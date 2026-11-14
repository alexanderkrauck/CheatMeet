import type { ReportData } from "../src/types";
import { formatTodoLine } from "./analysis";

/** Exact managed notes shared by browser and server; no provider/auth runtime. */
export function summaryBlock({ summary, todos, link }: {
  summary: string; todos: string[]; link?: string;
}): string {
  const lines = [summary.trim()].filter(Boolean);
  if (todos.length) lines.push("", "Aufgaben:", ...todos.map(todo => `• ${todo}`));
  if (link) lines.push("", `Bericht & Aufnahme: ${link}`);
  return lines.join("\n");
}

export const calendarReportBlock = (report: ReportData) => summaryBlock({
  summary: report.summary,
  todos: (report.todos || []).map(formatTodoLine),
  link: report.home?.provider === "microsoft" ? report.home.webUrl
    : report.driveFolderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(report.driveFolderId)}` : undefined,
});

/** A changed payload needs another calendar write; unrelated edits do not. */
export function withCalendarFreshness(previous: ReportData, next: ReportData): ReportData {
  return calendarReportBlock(previous) === calendarReportBlock(next)
    ? next : { ...next, calendarSyncedAt: undefined };
}
