import type { ReportData } from "../types";
import { archiveSyncedAt, reportIndexCollection } from "../../shared/storage";

/** Pending edits retain the canonical baseline without claiming archive sync. */
export function pendingArchive(source: ReportData) {
  const base = source.archiveBaseSyncedAt || archiveSyncedAt(source);
  return {
    ...(base ? { archiveBaseSyncedAt: base } : {}),
    ...(source.home
      ? { home: { ...source.home, syncedAt: undefined } }
      : { driveSyncedAt: "" }),
  };
}

// This is only a tab-local recovery copy, never a saved report or cloud write.
const fields = [
  "title",
  "summary",
  "todos",
  "takeaways",
  "transcription",
  "speech",
  "status",
  "error",
  "summaryNeedsRefresh",
] as const;
export type ReportEditDraft = {
  baseUpdatedAt: string | null;
  report: ReportData;
  todosText: string;
  editFields: boolean;
};
const key = (owner: string, id: string, index: "reports" | "meetings") =>
  `cheatmeet:report-edit:${encodeURIComponent(owner)}:${index}:${encodeURIComponent(id)}`;
const content = (report: ReportData) =>
  Object.fromEntries(fields.map((field) => [field, report[field]]));
export function hasReportEdits(saved: ReportData, draft: ReportData) {
  return JSON.stringify(content(saved)) !== JSON.stringify(content(draft));
}
export function rememberReportEdit(owner: string, draft: ReportEditDraft) {
  try {
    sessionStorage.setItem(
      key(owner, draft.report.id, reportIndexCollection(draft.report)),
      JSON.stringify({
        version: 1,
        baseUpdatedAt: draft.baseUpdatedAt,
        patch: content(draft.report),
        todosText: draft.todosText,
        editFields: draft.editFields,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
export function forgetReportEdit(owner: string, id: string, options: { index: "reports" | "meetings" }) {
  try {
    sessionStorage.removeItem(key(owner, id, options.index));
  } catch {
    /* Leave guard still protects work. */
  }
}
export function recoverReportEdit(
  owner: string,
  saved: ReportData,
): ReportEditDraft | undefined {
  try {
    const raw = sessionStorage.getItem(key(owner, saved.id, reportIndexCollection(saved)));
    if (!raw) return;
    const value = JSON.parse(raw);
    const patch = value.patch;
    if (
      value.version !== 1 ||
      !patch ||
      typeof patch.title !== "string" ||
      typeof patch.summary !== "string" ||
      typeof patch.transcription !== "string" ||
      !Array.isArray(patch.todos) ||
      !patch.todos.every((t: any) => t && typeof t.text === "string") ||
      !Array.isArray(patch.takeaways) ||
      !patch.takeaways.every((t: unknown) => typeof t === "string") ||
      (value.baseUpdatedAt !== null &&
        typeof value.baseUpdatedAt !== "string") ||
      typeof value.todosText !== "string" ||
      typeof value.editFields !== "boolean"
    )
      return;
    if (
      patch.speech &&
      (!Array.isArray(patch.speech.turns) || !patch.speech.speakerNames)
    )
      return;
    // Never restore home, owner, IDs, calendar or retention from the recovery copy.
    const report = { ...saved };
    for (const field of fields) {
      if (field in patch) Object.assign(report, { [field]: patch[field] });
    }
    return {
      report,
      baseUpdatedAt: value.baseUpdatedAt,
      todosText: value.todosText,
      editFields: value.editFields,
    };
  } catch {
    return;
  }
}
