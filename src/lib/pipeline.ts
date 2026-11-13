import { ensureMicrosoftToken } from "./microsoft";
import { hasAnyCalendarGrant } from "./calendar";
import { analyzeDraft, backupDraft, syncReport } from "./workflow";
import { saveReport } from "./reports";
import { acceptRemoteReport, deleteDraft, putLocal, putDraft, getDraft, listDrafts, getLocal, type LocalReport } from "./local";
import { processingAvailable, submitServerProcessing, getServerProcessing, listServerProcessing, type ProcessingOptions } from "./serverProcessing";
import type { ProcessingJobView } from "../../shared/processing";
import type { ReportData } from "../types";
import { errorMessage } from "./session";
import type { Draft } from "../types";
import { prepareTranscript } from "./prepareTranscript";
import { auth } from "./firebase";
import { needsSpeakerReview } from "../../shared/transcription";
import { syncReportToCalendar } from "./calendarSync";
import { calendarSyncEnabled } from "./meetingDefaults";
import { hasCalendarGrant, ensureDriveToken } from "./session";
import { isCapturing, captureSnapshot } from "./capture";

const captureBusy = () => isCapturing() || !!captureSnapshot().busy;

export type JobStage =
  | "saving"
  | "uploading"
  | "analyzing"
  | "exporting"
  | "done"
  | "review"
  | "error";

export interface JobState {
  reportId: string;
  owner: string;
  stage: JobStage;
  message: string;
  warning?: string;
  error?: string;
  /** Once accepted, closing this tab does not stop the server job. */
  serverOwned?: boolean;
}

/**
 * Save/analyse/export runs here rather than inside the recording screen, so
 * navigating away no longer cancels it. The work still belongs to this tab:
 * closing it stops local work. Configured deployments hand durable Drive input
 * to the server instead; those jobs continue independently of this tab.
 */
const jobs = new Map<string, JobState>();
const listeners = new Set<() => void>();

// useSyncExternalStore compares snapshots by identity, so the active list is
// rebuilt only when a job actually changes.
let active: JobState[] = [];

function changed() {
  active = [...jobs.values()].filter(
    (job) => job.stage !== "done" && job.stage !== "error" && job.stage !== "review",
  );
  for (const listener of listeners) listener();
}

function publish(state: JobState) {
  jobs.set(state.reportId, state);
  changed();
}

export function subscribeJobs(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export const jobFor = (reportId: string) => jobs.get(reportId);
export const activeJobs = () => active;

export function clearJob(reportId: string) {
  if (jobs.delete(reportId)) changed();
}

const remoteRevisions = new Map<string, string>();
const observedRevision = (job: ProcessingJobView, local?: LocalReport) => JSON.stringify([job.updatedAt, local?.dirty, local?.report.status, local?.report.updatedAt]);
const running = new Set<string>();
const retries = new Map<string, { attempts: number; after: number }>();

function publishServerJob(owner: string, job: ProcessingJobView) {
  const stage: JobStage = job.state === "done" ? "done"
    : job.state === "review" ? "review"
    : job.state === "blocked" || job.state === "error" ? "error"
    : job.state === "exporting" ? "exporting" : "analyzing";
  publish({ owner, reportId: job.reportId, stage, message: job.message,
    error: job.error, warning: job.warning, serverOwned: true });
}

/** Called only after the complete input exists in Drive. A failed response is
 * uncertain: never fall back to local AI and risk a duplicate paid run. */
export async function handoffServerProcessing(owner: string, report: ReportData, options: ProcessingOptions) {
  const check = () => {
    if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  check();
  let result = await submitServerProcessing(report, options);
  check();
  if (["done", "review"].includes(result.job.state)) {
    result = await getServerProcessing(report.id);
    check();
  }
  // The acknowledged source is durable, even if its earlier index write timed out.
  await putLocal(owner, { ...report, status: result.job.state === "done" ? "completed" : options.analyze ? "analyzing" : "pending", error: "" }, false);
  check();
  publishServerJob(owner, result.job);
  if (result.report) {
    await acceptRemoteReport(owner, result.report);
    check();
  }
  return result;
}

/** Restores server progress, then resumes explicitly requested local uploads.
 * Paid processing and post-acceptance retries remain server-owned. */
export async function pollServerProcessing(owner: string) {
  if (auth.currentUser?.uid !== owner || !(await processingAvailable())) return;
  if (auth.currentUser?.uid !== owner) return;
  const { jobs: remote } = await listServerProcessing();
  if (auth.currentUser?.uid !== owner) return;
  for (const job of remote) {
    if (auth.currentUser?.uid !== owner) return;
    const key = `${owner}:${job.reportId}`;
    const local = job.state === "done" ? await getLocal(owner, job.reportId) : undefined;
    if (auth.currentUser?.uid !== owner) return;
    if (remoteRevisions.get(key) === observedRevision(job, local)) continue;
    if (["done", "review", "blocked", "error"].includes(job.state)) {
      const result = await getServerProcessing(job.reportId);
      if (auth.currentUser?.uid !== owner) return;
      if (result.report) {
        await acceptRemoteReport(owner, result.report);
        if (auth.currentUser?.uid !== owner) return;
      }
      if (job.state === "done") await deleteDraft(owner, job.reportId);
    }
    if (auth.currentUser?.uid !== owner) return;
    publishServerJob(owner, job);
    const accepted = job.state === "done" ? await getLocal(owner, job.reportId) : undefined;
    if (auth.currentUser?.uid !== owner) return;
    remoteRevisions.set(key, observedRevision(job, accepted));
  }
  // A successful authoritative observation is required before retrying uploads.
  if (auth.currentUser?.uid !== owner || captureBusy()) return;
  const drafts = await listDrafts(owner, { includeAudio: false });
  if (auth.currentUser?.uid !== owner) return;
  for (const draft of drafts) {
    if (auth.currentUser?.uid !== owner || captureBusy()) return;
    if (!draft.processing || remote.some(job => job.reportId === draft.report.id)) continue;
    const known = jobFor(draft.report.id);
    if (known?.owner === owner && known.serverOwned) continue;
    const retry = retries.get(`${owner}:${draft.report.id}`);
    if (retry && Date.now() < retry.after) continue;
    // No cross-tab lock means no safe automatic upload. Manual saving remains available.
    if (typeof navigator === "undefined" || !navigator.locks) continue;
    await startProcessing({ owner, draft, analyze: draft.processing.analyze, resume: true });
  }
}

export function observeServerProcessing(owner: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { if (!stopped) await pollServerProcessing(owner); }
    catch { /* Offline only pauses observation; server retries continue. */ }
    finally { if (!stopped) timer = setTimeout(tick, 5000); }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const [id, job] of jobs) if (job.owner === owner && job.serverOwned) jobs.delete(id);
    changed();
  };
}

export function startProcessing({
  owner,
  draft,
  token,
  analyze,
  resume = false,
}: {
  owner: string;
  draft: Draft;
  token?: string;
  analyze: boolean;
  /** Internal observer path: reload the checkpoint under the cross-tab lock. */
  resume?: boolean;
}): Promise<void> {
  const reportId = draft.report.id;
  let current = { ...draft, processing: { ...draft.processing, analyze } } as Draft;
  const key = `${owner}:${reportId}`;
  const update = (stage: JobStage, message: string, extra: Partial<JobState> = {}) =>
    publish({ reportId, owner, stage, message, ...extra });

  const assertOwner = () => {
    if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  const run = async () => {
    let warning = "";
    try {
      assertOwner();
      if (resume) {
        const stored = await getDraft(owner, reportId);
        assertOwner();
        if (!stored?.processing || captureBusy()) return;
        current = stored;
        analyze = stored.processing.analyze;
      }
      update("saving", "Bericht wird gesichert …");
      await putDraft(owner, current);
      assertOwner();
      const configured = await processingAvailable();
      assertOwner();
      if (configured) {
        const { jobs: remote } = await listServerProcessing();
        assertOwner();
        const accepted = remote.find(job => job.reportId === reportId);
        if (accepted) {
          publishServerJob(owner, accepted);
          if (accepted.state === "done") {
            await deleteDraft(owner, reportId);
            assertOwner();
          }
          return;
        }
      } else if (resume || current.processing?.sourceReady) {
        throw new Error("Server-Verarbeitung derzeit nicht erreichbar. Der Entwurf bleibt erhalten.");
      }
      if (current.report.home) {
        if (!configured) throw new Error("OneDrive benötigt die Server-Verarbeitung. Der lokale Entwurf bleibt erhalten; es wird nicht zu Google gewechselt.");
        token = (await ensureMicrosoftToken(current.report.home.connectionId)).accessToken;
      } else token ||= await ensureDriveToken();
      assertOwner();
      if (!token) throw new Error("Bitte Google Drive erneut verbinden. Der Entwurf bleibt erhalten.");
      if (current.processing?.sourceReady) {
        await handoffServerProcessing(owner, current.report, {
          analyze, retranscribe: analyze && current.retranscribe === true,
          calendarSync: analyze && calendarSyncEnabled() && hasAnyCalendarGrant(current.report.calendarEventId ? current.report.calendarProvider || "google" : undefined),
        });
        assertOwner();
        await deleteDraft(owner, reportId);
        assertOwner();
        return;
      }
      const saveWarning = await saveReport(current.report);
      assertOwner();
      if (saveWarning) warning = saveWarning;

      update("uploading", "Aufnahme wird in Google Drive gesichert …", {
        warning,
      });
      await backupDraft(current, token, (message) =>
        update("uploading", message, { warning }),
      );
      assertOwner();
      await putLocal(owner, current.report);
      assertOwner();

      if (configured) {
        // Finish live text locally without a paid batch pass. The server needs
        // a durable source before it can promise work survives this tab.
        await prepareTranscript(current, token, { batch: false }).catch((error) => {
          if (current.report.transcriptionOrigin !== "import") throw error;
        });
        assertOwner();
        update("exporting", "Aufnahme und Transkript für den Server sichern …", { warning });
        const source = await syncReport(current.report, token);
        assertOwner();
        current = { ...current, report: source.report, processing: { analyze, sourceReady: true } };
        await putDraft(owner, current);
        assertOwner();
        await handoffServerProcessing(owner, source.report, {
          analyze, retranscribe: analyze && current.retranscribe === true,
          calendarSync: analyze && calendarSyncEnabled() && hasAnyCalendarGrant(current.report.calendarEventId ? current.report.calendarProvider || "google" : undefined),
        });
        assertOwner();
        await deleteDraft(owner, reportId);
        assertOwner();
        return;
      }

      update("analyzing", analyze && current.retranscribe
        ? "Gesamte Aufnahme wird erneut transkribiert …"
        : "Transkript wird für die Zusammenfassung vorbereitet …", { warning });
      if (analyze) {
        await prepareTranscript(current, token);
      } else {
        // Still runs the free local finalisation of a live capture. An import
        // has no transcript and must not trigger the paid batch job the user
        // just declined — that is a note, not a failure: the audio still
        // belongs in Drive.
        await prepareTranscript(current, token, { batch: false }).catch((error) => {
          warning = warning
            ? `${warning} ${errorMessage(error)}`
            : errorMessage(error);
        });
      }
      assertOwner();
      if (needsSpeakerReview(current.report.speech)) {
        current.report = { ...current.report, status: "pending", error: "" };
        await putLocal(owner, current.report);
        assertOwner();
        const result = await syncReport(current.report, token);
        assertOwner();
        update("review", "Sprecher prüfen oder Prüfung überspringen.", { warning: result.warning || warning });
        return;
      }

      if (analyze) {
        update("analyzing", "Bericht wird erstellt …", { warning });
        try {
          current = { ...current, report: await analyzeDraft(current) };
          assertOwner();
          await putLocal(owner, current.report);
        } catch (error) {
          assertOwner();
          // Keep the failure on the report so it can be retried from its page.
          current = {
            ...current,
            report: {
              ...current.report,
              status: "error",
              error: errorMessage(error),
            },
          };
          await putLocal(owner, current.report);
          assertOwner();
          if (auth.currentUser?.uid === owner) await saveReport(current.report).catch(() => {});
          if (auth.currentUser?.uid === owner) await syncReport(current.report, token).catch(() => {});
          throw error;
        }
      }

      // Before the Drive export, so the exported report carries the calendar
      // link. Never fatal: a calendar failure is a warning, and the meeting is
      // saved either way. Only an already-matched event is touched — creating
      // one is an explicit action on the report page.
      if (
        analyze &&
        calendarSyncEnabled() &&
        hasAnyCalendarGrant(current.report.calendarEventId ? current.report.calendarProvider || "google" : undefined) &&
        current.report.calendarEventId
      ) {
        update("exporting", "Kalendereintrag wird aktualisiert …", { warning });
        try {
          const patch = await syncReportToCalendar(current.report, { create: false });
          assertOwner();
          current = { ...current, report: { ...current.report, ...patch } };
          if (patch.calendarError)
            warning = warning
              ? `${warning} ${patch.calendarError}`
              : patch.calendarError;
          await putLocal(owner, current.report);
        } catch (error) {
          assertOwner();
          warning = warning
            ? `${warning} ${errorMessage(error)}`
            : errorMessage(error);
        }
      }

      update("exporting", "Bericht wird nach Google Drive exportiert …", {
        warning,
      });
      assertOwner();
      const result = await syncReport(current.report, token);
      assertOwner();

      await deleteDraft(owner, result.report.id);
      assertOwner();
      update("done", "Fertig.", {
        warning: result.warning || warning || undefined,
      });
    } catch (error) {
      const previous = retries.get(key)?.attempts || 0;
      const retryAfter=(error as {retryAfterMs?:number})?.retryAfterMs;
      retries.set(key, { attempts: previous + 1, after: Date.now() + Math.max(Math.min(300_000, 30_000 * 2 ** previous), Number.isFinite(retryAfter)?retryAfter!:0) });
      if (auth.currentUser?.uid !== owner) return;
      current.report = { ...current.report, status: "error", error: errorMessage(error) };
      // Preparing an imported transcript may fail before the summary block. Keep its recovery
      // state on the report as well as the transient job notification.
      await putLocal(owner, current.report).catch(() => {});
      if (auth.currentUser?.uid !== owner) return;
      update("error", "Fehlgeschlagen.", {
        error: errorMessage(error),
        warning: warning || undefined,
      });
    }
  };

  if (running.has(key)) return Promise.resolve();
  running.add(key);
  // ifAvailable avoids queueing a stale draft behind another tab’s upload.
  const work = typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request(`cheatmeet:processing:${key}`, { ifAvailable: true }, lock => lock ? run() : undefined)
    : run();
  return work.finally(() => { running.delete(key); });
}
