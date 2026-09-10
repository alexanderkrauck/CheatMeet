import { analyzeDraft, backupDraft, syncReport } from "./workflow";
import { saveReport } from "./reports";
import { deleteDraft, putLocal } from "./local";
import { errorMessage } from "./session";
import type { Draft } from "../types";

export type JobStage =
  | "saving"
  | "uploading"
  | "analyzing"
  | "exporting"
  | "done"
  | "error";

export interface JobState {
  reportId: string;
  owner: string;
  stage: JobStage;
  message: string;
  warning?: string;
  error?: string;
}

/**
 * Save/analyse/export runs here rather than inside the recording screen, so
 * navigating away no longer cancels it. The work still belongs to this tab:
 * closing it stops the job, which is why callers warn before unload.
 */
const jobs = new Map<string, JobState>();
const listeners = new Set<() => void>();

// useSyncExternalStore compares snapshots by identity, so the active list is
// rebuilt only when a job actually changes.
let active: JobState[] = [];

function changed() {
  active = [...jobs.values()].filter(
    (job) => job.stage !== "done" && job.stage !== "error",
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

  const run = async () => {
    let warning = "";
    try {
      update("saving", "Bericht wird gesichert …");
      const saveWarning = await saveReport(current.report);
      if (saveWarning) warning = saveWarning;

      update("uploading", "Aufnahme wird in Google Drive gesichert …", {
        warning,
      });
      await backupDraft(current, token, (message) =>
        update("uploading", message, { warning }),
      );
      await putLocal(owner, current.report);

      if (analyze) {
        update("analyzing", "Bericht wird erstellt …", { warning });
        try {
          current = { ...current, report: await analyzeDraft(current) };
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
          await saveReport(current.report).catch(() => {});
          await syncReport(current.report, token).catch(() => {});
          throw error;
        }
      }

      update("exporting", "Bericht wird nach Google Drive exportiert …", {
        warning,
      });
      const result = await syncReport(current.report, token);
      await deleteDraft(owner, result.report.id);
      update("done", "Fertig.", {
        warning: result.warning || warning || undefined,
      });
    } catch (error) {
      update("error", "Fehlgeschlagen.", {
        error: errorMessage(error),
        warning: warning || undefined,
      });
    }
  };

  return run();
}
