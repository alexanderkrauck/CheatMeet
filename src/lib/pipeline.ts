import { analyzeDraft, backupDraft, syncReport } from "./workflow";
import { saveReport } from "./reports";
import { deleteDraft, putLocal } from "./local";
import { errorMessage } from "./session";
import type { Draft } from "../types";
import { ensureFinalTranscript } from "./finalTranscription";
import { auth } from "./firebase";
import { needsSpeakerReview } from "../../shared/transcription";

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

      update("analyzing", "Finales Transkript und Sprecher werden erstellt …", { warning });
      await ensureFinalTranscript(current, token);
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
      // The final pass may fail before the summary block. Keep its recovery
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
