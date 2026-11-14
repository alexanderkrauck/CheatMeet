import { ensureMicrosoftToken } from "./microsoft";
import { hasAnyCalendarGrant } from "./calendar";
import { analyzeDraft, backupDraft, syncReport } from "./workflow";
import { saveReport } from "./reports";
import { acceptRemoteReport, deleteDraft, putLocal, putDraft, getDraft, listDrafts, getLocal, ReportConflictError, type LocalReport } from "./local";
import { processingAvailable, submitServerProcessing, getServerProcessing, discoverServerProcessing, listServerProcessing, type ProcessingOptions } from "./serverProcessing";
import { processingActive, processingSourceKey, processingStorage, jobStorage, type ProcessingJobView } from "../../shared/processing";
import { archiveAudioId, archiveSyncedAt } from "../../shared/storage";
import type { ReportData } from "../types";
import { errorMessage } from "./session";
import type { Draft } from "../types";
import { prepareTranscript } from "./prepareTranscript";
import { auth } from "./firebase";

import { syncReportToCalendar } from "./calendarSync";
import { calendarSyncEnabled } from "./meetingDefaults";
import { ensureDriveToken } from "./session";
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
  storage?: 'google' | 'microsoft';
  owner: string;
  title?: string;
  date?: string;
  analyze?: boolean;
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
const jobs = new Map<string, { state: JobState; source?: string; serverUpdatedAt?: string }>();
const localJobKey = (owner: string, id: string, storage = 'google') => `${owner}:${storage}:${id}`;
const sourceError = () => Object.assign(new Error('Der Auftrag gehört zu einem anderen Meeting-Speicherort.'), { status: 409, name: 'ProcessingSourceConflictError' });
const sourceIndex = (report: { home?: unknown }) => ({ index: report.home ? 'meetings' as const : 'reports' as const });
async function deleteSourceDraft(owner: string, report: ReportData) {
  const draft = await getDraft(report.home ? `${owner}:microsoft` : owner, report.id, true);
  if (auth.currentUser?.uid !== owner) throw new Error('Das angemeldete Konto hat sich geändert.');
  if (draft && processingSourceKey(draft.report) === processingSourceKey(report)) await deleteDraft(owner, report.id, sourceIndex(report));
}
const listeners = new Set<() => void>();

// useSyncExternalStore compares snapshots by identity, so the active list is
// rebuilt only when a job actually changes.
let active: JobState[] = [];

function changed() {
  active = [...jobs.values()].map(entry => entry.state).filter(
    (job) => job.stage !== "done" && job.stage !== "error" && job.stage !== "review",
  );
  for (const listener of listeners) listener();
}

function publish(state: JobState, report?: ReportData, serverUpdatedAt?: string) {
  const key = localJobKey(state.owner, state.reportId, state.storage);
  const previous = jobs.get(key);
  jobs.set(key, { state, serverUpdatedAt, source: report ? processingSourceKey(report) : serverUpdatedAt && previous?.serverUpdatedAt === serverUpdatedAt ? previous.source : undefined });
  changed();
}

export function subscribeJobs(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export const jobFor = (reportId: string, report?: Pick<ReportData, "id" | "home" | "driveFolderId" | "driveReportId">) => {
  const job = jobs.get(localJobKey(auth.currentUser?.uid || '', reportId, report ? processingStorage(report) : 'google'));
  return job && (!report || report.id === reportId && job.source === processingSourceKey(report)) ? job.state : undefined;
};
export const activeJobs = () => active;

let hydrationEpoch = 0;
export function clearJob(reportId: string, report?: ReportData) {
  if (report && report.id !== reportId) return;
  // Forgetting exact-source recovery also fences a response whose visible
  // discovery entry has no source binding. Removal still requires a match.
  hydrationEpoch++;
  const key = localJobKey(auth.currentUser?.uid || '', reportId, report ? processingStorage(report) : 'google');
  const job = jobs.get(key);
  if (report && job && job.source !== processingSourceKey(report)) return;
  if (jobs.delete(key)) changed();
}

const remoteRevisions = new Map<string, string>();
const observedRevision = (job: ProcessingJobView, local?: LocalReport) => JSON.stringify([job.updatedAt, local?.dirty, local?.report.status, local?.report.updatedAt]);
const running = new Set<string>();
const retries = new Map<string, { attempts: number; after: number }>();

function publishServerJob(owner: string, job: ProcessingJobView, report?: ReportData, analyze?: boolean) {
  if (report && (report.id !== job.reportId || processingStorage(report) !== jobStorage(job))) throw sourceError();
  const previous = jobs.get(localJobKey(owner, job.reportId, jobStorage(job)));
  const own = previous?.state.owner === owner ? previous.state : undefined;
  const stage: JobStage = job.state === "done" ? "done"
    : job.state === "review" ? "review"
    : job.state === "blocked" || job.state === "error" ? "error"
    : job.state === "exporting" ? "exporting" : "analyzing";
  publish({ owner, reportId: job.reportId, storage: jobStorage(job), stage, message: job.message,
    title: report?.title ?? own?.title, date: report?.date ?? own?.date, analyze: analyze ?? own?.analyze,
    error: job.error, warning: job.warning, serverOwned: true }, report, job.updatedAt);
}

/** Called only after the complete input exists in Drive. A failed response is
 * uncertain: never fall back to local AI and risk a duplicate paid run. */
export async function handoffServerProcessing(owner: string, report: ReportData, options: ProcessingOptions) {
  const check = () => {
    if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  check();
  const local = await getLocal(owner, report.id, { index: report.home ? "meetings" : "reports" });
  check();
  if (local && processingSourceKey(local.report) !== processingSourceKey(report)) throw sourceError();
  // A confirmed replacement may not adopt a later local edit. Ordinary upload
  // handoffs still observe the durable final-save revision below.
  if (options.analyze && options.retranscribe && options.regenerate &&
      (!local || local.dirty || local.report.updatedAt !== report.updatedAt ||
       !archiveSyncedAt(local.report) || local.report.audioDeletedAt ||
       !archiveAudioId(local.report) || archiveAudioId(local.report) !== archiveAudioId(report)))
    throw new ReportConflictError();
  const expectedUpdatedAt = local?.report.updatedAt ?? null;
  let result = await submitServerProcessing(report, options);
  check();
  if (result.job.reportId !== report.id || jobStorage(result.job) !== processingStorage(report)) throw sourceError();
  if (["done", "review"].includes(result.job.state)) {
    result = await getServerProcessing(report.id, report);
    check();
  }
  // Acceptance acknowledges the archived source, not arbitrary local edits or
  // the cloud index. Preserve its dirty state and condition this status-only
  // checkpoint on the durable revision observed before submission.
  if (result.report && processingSourceKey(result.report) !== processingSourceKey(report)) throw sourceError();
  await putLocal(owner, { ...(local?.report || report), status: result.job.state === "done" ? "completed" : options.analyze ? "analyzing" : "pending", error: "" }, local?.dirty ?? true, expectedUpdatedAt);
  check();
  publishServerJob(owner, result.job, report, options.analyze);
  if (result.report) {
    if (processingSourceKey(result.report) !== processingSourceKey(report)) throw sourceError();
    await acceptRemoteReport(owner, result.report);
    check();
  }
  return result;
}

/** Restores server progress, then resumes explicitly requested local uploads.
 * Paid processing and post-acceptance retries remain server-owned. */
export async function pollServerProcessing(owner: string) {
  let epoch = hydrationEpoch;
  if (auth.currentUser?.uid !== owner || !(await processingAvailable())) return;
  if (auth.currentUser?.uid !== owner) return;
  const { jobs: remote } = await listServerProcessing();
  if (auth.currentUser?.uid !== owner) return;
  for (const job of remote) {
    if (auth.currentUser?.uid !== owner || epoch !== hydrationEpoch) return;
    const key = localJobKey(owner, job.reportId, jobStorage(job));
    const known = jobs.get(key);
    const index = { index: jobStorage(job) === 'microsoft' ? 'meetings' as const : 'reports' as const };
    const local = job.state === 'done' || !known || known.serverUpdatedAt !== job.updatedAt ? await getLocal(owner, job.reportId, index) : undefined;
    if (auth.currentUser?.uid !== owner || epoch !== hydrationEpoch) return;
    if (remoteRevisions.get(key) === observedRevision(job, local)) continue;
    let selected = local?.report;
    let currentJob = job;
    if (['done', 'review', 'blocked', 'error'].includes(job.state) || selected && (!known || known.serverUpdatedAt !== job.updatedAt)) {
      let result;
      try { result = selected ? await getServerProcessing(job.reportId, selected) : await discoverServerProcessing(job); }
      catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404 && status !== 409) throw error;
        if (auth.currentUser?.uid !== owner || epoch !== hydrationEpoch) return;
        // A mismatched source is not permission to clear its local sibling.
        if (status === 404 && selected) clearJob(job.reportId, selected);
        epoch = hydrationEpoch;
        remoteRevisions.delete(key);
        continue;
      }
      if (auth.currentUser?.uid !== owner || epoch !== hydrationEpoch) return;
      if (result.job.reportId !== job.reportId || jobStorage(result.job) !== jobStorage(job)) throw sourceError();
      currentJob = result.job;
      if (result.report) {
        if (result.report.id !== job.reportId || processingStorage(result.report) !== jobStorage(job) || selected && processingSourceKey(selected) !== processingSourceKey(result.report)) throw sourceError();
        selected = result.report;
        await acceptRemoteReport(owner, result.report);
        if (auth.currentUser?.uid !== owner || epoch !== hydrationEpoch) return;
      }
      if (currentJob.state === 'done' && selected) await deleteSourceDraft(owner, selected);
    }
    if (auth.currentUser?.uid !== owner || epoch !== hydrationEpoch) return;
    publishServerJob(owner, currentJob, selected);
    const accepted = currentJob.state === 'done' ? await getLocal(owner, job.reportId, index) : undefined;
    if (auth.currentUser?.uid !== owner) return;
    remoteRevisions.set(key, observedRevision(currentJob, accepted));
  }
  // A successful authoritative observation is required before retrying uploads.
  if (auth.currentUser?.uid !== owner || captureBusy()) return;
  const drafts = await listDrafts(owner, { includeAudio: false });
  if (auth.currentUser?.uid !== owner) return;
  for (const draft of drafts) {
    if (auth.currentUser?.uid !== owner || captureBusy()) return;
    if (!draft.processing || remote.some(job => job.reportId === draft.report.id)) continue;
    const known = jobFor(draft.report.id, draft.report);
    if (known?.owner === owner && known.serverOwned) continue;
    const retry = retries.get(localJobKey(owner, draft.report.id, processingStorage(draft.report)));
    if (retry && Date.now() < retry.after) continue;
    // No cross-tab lock means no safe automatic upload. Manual saving remains available.
    if (typeof navigator === "undefined" || !navigator.locks) continue;
    await startProcessing({ owner, draft, analyze: draft.processing.analyze, resume: true });
  }
  return remote.some(processingActive);
}

export function observeServerProcessing(owner: string): () => void {
  let stopped = false;
  let polling = false;
  let failures = 0;
  let focused = typeof document === "undefined" || document.hasFocus();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => focused && (typeof document === "undefined" || !document.hidden);
  const serverIds = () => new Set(activeJobs().filter(job => job.owner === owner && job.serverOwned).map(job => job.reportId));
  let known = serverIds();
  const pause = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const tick = async () => {
    if (stopped || polling || !visible()) return;
    pause();
    polling = true;

    let delay = 300000;
    try {
      const busy = await pollServerProcessing(owner);
      failures = 0;
      if (busy || serverIds().size > 0) delay = 5000;
    } catch {
      // A quota/offline error is not an idle response; do not hammer every 5s.
      failures++;
      delay = Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4));
    } finally {
      polling = false;
      if (!stopped && visible()) timer = setTimeout(tick, delay);
    }
  };
  const resume = () => { if (!stopped && visible()) void tick(); };
  const focus = () => { focused = true; resume(); };
  const blur = () => { focused = false; pause(); };
  const visibility = () => {
    if (document.hidden) pause();
    else { focused = true; resume(); }
  };
  const unsubscribe = subscribeJobs(() => {
    const next = serverIds();
    const added = [...next].some(id => !known.has(id));
    known = next;
    if (!added) return;
    // Observation itself publishes jobs. Never recursively poll from publish.
    if (!polling) resume();
  });
  if (typeof window !== "undefined") {
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
  resume();
  return () => {
    stopped = true;
    pause();
    unsubscribe();
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility);
    for (const [id, job] of jobs) if (job.state.owner === owner && job.state.serverOwned) jobs.delete(id);
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
  const key = localJobKey(owner, reportId, processingStorage(draft.report));
  const update = (stage: JobStage, message: string, extra: Partial<JobState> = {}) =>
    publish({ reportId, owner, storage: processingStorage(current.report), title: current.report.title, date: current.report.date, analyze, stage, message, ...extra }, current.report);

  const assertOwner = () => {
    if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  const run = async () => {
    let warning = "";
    let expectedUpdatedAt: string | null = current.report.updatedAt ?? null;
    const conflict = (error: unknown) => error instanceof Error && ['ReportConflictError','ProcessingSourceConflictError'].includes(error.name);
    const checkpoint = async (next: ReportData) => {
      assertOwner();
      const committed = { ...next, updatedAt: new Date(Math.max(Date.now(), (Date.parse(expectedUpdatedAt || "") || 0) + 1)).toISOString() };
      await putLocal(owner, committed, true, expectedUpdatedAt);
      assertOwner();
      expectedUpdatedAt = committed.updatedAt;
      current.report = committed;
    };
    const saveCurrent = async () => {
      const next = current.report;
      const result = await saveReport(next, { expectedUpdatedAt });
      assertOwner();
      const saved = await getLocal(owner, reportId, { index: current.report.home ? "meetings" : "reports" });
      assertOwner();
      // saveReport owns its final revision. Do not adopt a different tab's save
      // merely because it won the read-back race.
      if (!saved || Object.keys({ ...next, ...saved.report }).some(key =>
        key !== "updatedAt" && key !== "transcriptRevision" && JSON.stringify(next[key as keyof ReportData]) !== JSON.stringify(saved.report[key as keyof ReportData])))
        throw new ReportConflictError();
      current.report = saved.report;
      expectedUpdatedAt = saved.report.updatedAt ?? null;
      return result;
    };
    const syncCurrent = async () => {
      assertOwner();
      try {
        const result = await syncReport(current.report, token!);
        assertOwner();
        current.report = result.report;
        return result;
      } finally { expectedUpdatedAt = current.report.updatedAt ?? null; }
    };
    let analysisFailed = false;
    const prepare = async (batch = true) => {
      try { await prepareTranscript(current, token, { batch, expectedUpdatedAt }); }
      finally { expectedUpdatedAt = current.report.updatedAt ?? null; }
    };
    try {
      assertOwner();
      if (resume) {
        const stored = await getDraft(current.report.home ? `${owner}:microsoft` : owner, reportId, true);
        assertOwner();
        if (!stored?.processing || captureBusy()) return;
        if (processingSourceKey(stored.report) !== processingSourceKey(current.report)) throw sourceError();
        current = stored;
        analyze = stored.processing.analyze;
      }
      update("saving", "Bericht wird gesichert …");
      const observed = await getLocal(owner, reportId, { index: current.report.home ? "meetings" : "reports" });
      assertOwner();
      expectedUpdatedAt = observed?.report.updatedAt ?? null;
      if (observed && processingSourceKey(observed.report) !== processingSourceKey(current.report)) throw sourceError();
      if (observed && expectedUpdatedAt !== (current.report.updatedAt ?? null)) throw new ReportConflictError();
      await putDraft(owner, current);
      assertOwner();
      const configured = await processingAvailable();
      assertOwner();
      if (configured) {
        const { jobs: remote } = await listServerProcessing();
        assertOwner();
        const accepted = remote.find(job => job.reportId === reportId);
        if (accepted) {
          if (jobStorage(accepted) !== processingStorage(current.report)) throw sourceError();
          // List metadata is not evidence of pinned archive identity.
          const result = await getServerProcessing(reportId, current.report);
          assertOwner();
          if (result.report && processingSourceKey(result.report) !== processingSourceKey(current.report)) throw sourceError();
          publishServerJob(owner, result.job, current.report, analyze);
          if (result.report) { await acceptRemoteReport(owner, result.report); assertOwner(); }
          if (result.job.state === "done") {
            await deleteSourceDraft(owner, current.report);
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
          calendarSync: analyze && calendarSyncEnabled() && hasAnyCalendarGrant(current.report.calendarEventId ? current.report.calendarProvider || "google" : undefined, current.report.calendarEventId ? current.report.calendarConnectionId : undefined),
        });
        assertOwner();
        await deleteSourceDraft(owner, current.report);
        assertOwner();
        return;
      }
      const saveWarning = await saveCurrent();
      assertOwner();
      if (saveWarning) warning = saveWarning;

      update("uploading", "Aufnahme wird in Google Drive gesichert …", {
        warning,
      });
      try {
        await backupDraft(current, token, (message) =>
          update("uploading", message, { warning }), expectedUpdatedAt,
        );
      } finally {
        expectedUpdatedAt = current.report.updatedAt ?? null;
      }
      assertOwner();

      if (configured) {
        // Finish live text locally without a paid batch pass. The server needs
        // a durable source before it can promise work survives this tab.
        await prepare(false).catch((error) => {
          if (conflict(error) || current.report.transcriptionOrigin !== "import") throw error;
        });
        assertOwner();
        update("exporting", "Aufnahme und Transkript für den Server sichern …", { warning });
        const source = await syncCurrent();
        assertOwner();
        current = { ...current, report: source.report, processing: { analyze, sourceReady: true } };
        await putDraft(owner, current);
        assertOwner();
        await handoffServerProcessing(owner, source.report, {
          analyze, retranscribe: analyze && current.retranscribe === true,
          calendarSync: analyze && calendarSyncEnabled() && hasAnyCalendarGrant(current.report.calendarEventId ? current.report.calendarProvider || "google" : undefined, current.report.calendarEventId ? current.report.calendarConnectionId : undefined),
        });
        assertOwner();
        await deleteSourceDraft(owner, current.report);
        assertOwner();
        return;
      }

      update(analyze ? "analyzing" : "uploading", !analyze
        ? "Gespeichertes Transkript wird vorbereitet …"
        : current.retranscribe ? "Gesamte Aufnahme wird erneut transkribiert …"
        : "Transkript wird für die Zusammenfassung vorbereitet …", { warning });
      if (analyze) {
        await prepare();
      } else {
        // Still runs the free local finalisation of a live capture. An import
        // has no transcript and must not trigger the paid batch job the user
        // just declined — that is a note, not a failure: the audio still
        // belongs in Drive.
        await prepare(false).catch((error) => {
          if (conflict(error)) throw error;
          warning = warning
            ? `${warning} ${errorMessage(error)}`
            : errorMessage(error);
        });
      }
      assertOwner();
      if (analyze) {
        update("analyzing", "Bericht wird erstellt …", { warning });
        let analysed: ReportData;
        try { analysed = await analyzeDraft(current, { expectedUpdatedAt }); }
        catch (error) { analysisFailed = true; throw error; }
        finally { expectedUpdatedAt = current.report.updatedAt ?? null; }
        assertOwner();
        await checkpoint(analysed);
      }

      // Before the Drive export, so the exported report carries the calendar
      // link. Never fatal: a calendar failure is a warning, and the meeting is
      // saved either way. Only an already-matched event is touched — creating
      // one is an explicit action on the report page.
      if (
        analyze &&
        calendarSyncEnabled() &&
        hasAnyCalendarGrant(current.report.calendarEventId ? current.report.calendarProvider || "google" : undefined, current.report.calendarEventId ? current.report.calendarConnectionId : undefined) &&
        current.report.calendarEventId
      ) {
        update("exporting", "Kalendereintrag wird aktualisiert …", { warning });
        try {
          const patch = await syncReportToCalendar(current.report, { create: false });
          assertOwner();
          await checkpoint({ ...current.report, ...patch });
          if (patch.calendarError)
            warning = warning
              ? `${warning} ${patch.calendarError}`
              : patch.calendarError;
        } catch (error) {
          assertOwner();
          if (conflict(error)) throw error;
          warning = warning
            ? `${warning} ${errorMessage(error)}`
            : errorMessage(error);
        }
      }

      update("exporting", "Bericht wird nach Google Drive exportiert …", {
        warning,
      });
      assertOwner();
      const result = await syncCurrent();
      assertOwner();

      await deleteSourceDraft(owner, result.report);
      assertOwner();
      update("done", "Fertig.", {
        warning: result.warning || warning || undefined,
      });
    } catch (error) {
      const previous = retries.get(key)?.attempts || 0;
      const retryAfter=(error as {retryAfterMs?:number})?.retryAfterMs;
      if (!(error instanceof Error && error.name === 'ProcessingSourceConflictError')) retries.set(key, { attempts: previous + 1, after: Date.now() + Math.max(Math.min(300_000, 30_000 * 2 ** previous), Number.isFinite(retryAfter)?retryAfter!:0) });
      if (auth.currentUser?.uid !== owner) return;
      if (!conflict(error)) {
        try {
          await checkpoint({ ...current.report, status: "error", error: errorMessage(error) });
          if (analysisFailed && token) {
            await saveCurrent();
            assertOwner();
            await syncCurrent();
            assertOwner();
          }
        } catch (checkpointError) {
          // Never retry a failed CAS with a fresh observation or an error stub.
          if (conflict(checkpointError)) error = checkpointError;
        }
      }
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
