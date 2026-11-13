import { analyzeDraft, backupDraft, syncReport } from "./workflow";
import { saveReport } from "./reports";
import { acceptRemoteReport, deleteDraft, putLocal } from "./local";
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
import { hasCalendarGrant } from "./session";

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
  if (result.report) await acceptRemoteReport(owner, result.report);
  return result;
}

/** Restores progress after reload/on another device. Polling only observes jobs;
 * work and retries are owned by Cloud Tasks, not this timer. */
export async function pollServerProcessing(owner: string) {
  if (auth.currentUser?.uid !== owner || !(await processingAvailable())) return;
  const { jobs: remote } = await listServerProcessing();
  if (auth.currentUser?.uid !== owner) return;
  for (const job of remote) {
    if (auth.currentUser?.uid !== owner) return;
    const key = `${owner}:${job.reportId}`;
    if (remoteRevisions.get(key) === job.updatedAt) continue;
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
    remoteRevisions.set(key, job.updatedAt);
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
}: {
  owner: string;
  draft: Draft;
  token: string;
  analyze: boolean;
}): Promise<void> {
  const reportId = draft.report.id;
  let current = draft;
  const update = (stage: JobStage, message: string, extra: Partial<JobState> = {}) =>
    publish({ reportId, owner, stage, message, ...extra });

  const assertOwner = () => {
    if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  const run = async () => {
    let warning = "";
    try {
      assertOwner();
      update("saving", "Bericht wird gesichert …");
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

      if (await processingAvailable()) {
        // Finish live text locally without a paid batch pass. The server needs
        // a durable source before it can promise work survives this tab.
        await prepareTranscript(current, token, { batch: false }).catch((error) => {
          if (current.report.transcriptionOrigin !== "import") throw error;
        });
        assertOwner();
        update("exporting", "Aufnahme und Transkript für den Server sichern …", { warning });
        const source = await syncReport(current.report, token);
        assertOwner();
        await handoffServerProcessing(owner, source.report, {
          analyze, retranscribe: analyze && current.retranscribe === true,
          calendarSync: analyze && calendarSyncEnabled() && hasCalendarGrant(),
        });
        assertOwner();
        await deleteDraft(owner, reportId);
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
        hasCalendarGrant() &&
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
      update("done", "Fertig.", {
        warning: result.warning || warning || undefined,
      });
    } catch (error) {
      current.report = { ...current.report, status: "error", error: errorMessage(error) };
      // Preparing an imported transcript may fail before the summary block. Keep its recovery
      // state on the report as well as the transient job notification.
      await putLocal(owner, current.report).catch(() => {});
      update("error", "Fehlgeschlagen.", {
        error: errorMessage(error),
        warning: warning || undefined,
      });
    }
  };

  return run();
}
