import type { ReportSummary } from "./meetingMeta";

export type UsagePeriod = "day" | "week" | "month";
export interface UsageRange { start: string; end: string; days: string[] }

/** Civil arithmetic, never adding 24 hours to a zoned instant. End exclusive. */
export function usageRange(period: UsagePeriod, anchor: string, delta = 0): UsageRange {
  const first = civil(anchor);
  if (period === "month") first.setUTCDate(1);
  if (period === "week") first.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7);
  if (period === "month") first.setUTCMonth(first.getUTCMonth() + delta);
  else first.setUTCDate(first.getUTCDate() + delta * (period === "week" ? 7 : 1));
  const last = new Date(first);
  if (period === "month") last.setUTCMonth(last.getUTCMonth() + 1);
  else last.setUTCDate(last.getUTCDate() + (period === "week" ? 7 : 1));
  const days: string[] = [];
  for (const at = new Date(first); at < last; at.setUTCDate(at.getUTCDate() + 1)) days.push(keyOf(at));
  return { start: keyOf(first), end: keyOf(last), days };
}

export interface UsageTotals {
  meetings: number;
  knownDurationCount: number;
  /** Sum of known durations only; null when none is known, never a fake zero. */
  durationMs: number | null;
  summaries: number;
}
export interface UsageDay extends UsageTotals { key: string }
export interface UsageActivity extends UsageTotals { days: UsageDay[]; excludedInvalidDates: number }
type UsageMeeting = Pick<ReportSummary, "id" | "date" | "durationMs" | "summary" | "home" | "updatedAt">;
const empty = (): UsageTotals => ({ meetings: 0, knownDurationCount: 0, durationMs: null, summaries: 0 });

/** Only consume useReports' normalized, owning-account metadata, not drafts. */
export function aggregateUsage(reports: readonly UsageMeeting[], range: UsageRange): UsageActivity {
  const days = range.days.map((key) => ({ key, ...empty() }));
  const byDay = new Map(days.map((day) => [day.key, day]));
  const result: UsageActivity = { ...empty(), days, excludedInvalidDates: 0 };
  // Matches local.ts: one owner, separate legacy Google / Microsoft namespaces.
  // Calendar provider and archive file IDs do not create additional meetings.
  const unique = new Map<string, UsageMeeting>();
  for (const report of reports) {
    const id = `${report.home ? "microsoft" : "google"}:${report.id}`;
    const old = unique.get(id);
    if (!old || (Date.parse(report.updatedAt || "") || 0) > (Date.parse(old.updatedAt || "") || 0)) unique.set(id, report);
  }
  for (const report of unique.values()) {
    const key = viennaDay(report.date);
    if (!key) { result.excludedInvalidDates++; continue; }
    const day = byDay.get(key);
    if (!day) continue;
    const known = Number.isFinite(report.durationMs) && report.durationMs > 0;
    for (const total of [result, day]) {
      total.meetings++;
      if (known) {
        total.knownDurationCount++;
        total.durationMs = (total.durationMs ?? 0) + report.durationMs;
      }
      if (report.summary?.trim()) total.summaries++;
    }
  }
  return result;
}

export const USAGE_TIME_ZONE = "Europe/Vienna";
const calendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: USAGE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
const civil = (key: string) => new Date(`${key}T12:00:00Z`);
const keyOf = (date: Date) => date.toISOString().slice(0, 10);

/** Dates without a time denote a civil day; instants always use Vienna. */
export function viennaDay(value: string | Date): string | null {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return null;
  if (typeof value === "string") {
    const isoDay = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value)?.[1];
    if (isoDay && keyOf(civil(isoDay)) !== isoDay) return null;
    if (value === isoDay) return isoDay;
  }
  const parts = calendar.formatToParts(at);
  return ["year", "month", "day"].map((part) => parts.find((p) => p.type === part)!.value).join("-");
}
