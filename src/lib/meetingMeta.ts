import {
  needsSpeakerReview,
  speakerLabel,
  type MeetingTranscript,
} from "../../shared/transcription";
import type { ReportData } from "../types";

/**
 * Facts about a meeting that the list, the calendar and the row renderer all
 * need, kept out of the components so they can be tested without a DOM.
 *
 * `date` is only ever validated as "a string" (firestore.rules) and the Drive
 * restore path admits any parseable form, so every date-driven view guards it
 * here rather than rendering "Invalid Date".
 */
export const isValidDate = (date?: string): boolean =>
  !!date && Number.isFinite(Date.parse(date));

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The LOCAL calendar day. Drive subfolders are named from the UTC day
 * (workflow.ts), so a late-evening meeting files under tomorrow there while
 * appearing on its actual evening here. A calendar means wall clock; the
 * folder name is an internal detail.
 */
export function localDayKey(date: string): string {
  const at = new Date(date);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export const monthKeyOf = (date: string) => localDayKey(date).slice(0, 7);

/** A month key that came from the URL is user input until this says otherwise. */
export const isMonthKey = (month?: string | null): month is string =>
  /^\d{4}-(0[1-9]|1[0-2])$/.test(month || "");

/**
 * Labels a local day key. `new Date("2026-09-14")` is UTC midnight per spec, so
 * re-parsing the key would name the previous day everywhere west of UTC.
 */
export function dayKeyLabel(
  key: string,
  options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "long",
    year: "numeric",
  },
): string {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return "Ohne Datum";
  return new Date(year, month - 1, day).toLocaleDateString("de-AT", options);
}

/** German plurals, so no string has to read "1 Bericht(e)". */
export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split("-").map(Number);
  const at = new Date(year, index - 1 + delta, 1);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}`;
}

/** Imported audio is stored with `durationMs: 0`, so fall back to the
 *  transcript's own clock, which exists for both origins. */
export function meetingDurationMs(report: ReportData): number {
  if (report.durationMs) return report.durationMs;
  return (Array.isArray(report.speech?.turns) ? report.speech.turns : []).reduce(
    (longest, turn) => Math.max(longest, turn.endMs),
    0,
  );
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "< 1 Min";
  if (minutes < 60) return `${minutes} Min`;
  return `${Math.floor(minutes / 60)} Std ${pad(minutes % 60)} Min`;
}

/** Named or not, a distinct voice is a participant; unassigned audio is not. */
export function speakerCount(speech?: MeetingTranscript): number {
  const turns = Array.isArray(speech?.turns) ? speech.turns : [];
  return new Set(
    turns.filter((t) => !t.speaker.endsWith(":unknown")).map((t) => t.speaker),
  ).size;
}

/** `status` is optional and the Drive restore path coerces unknown values, so
 *  normalise once instead of re-deriving the absent case at every call site. */
export type MeetingStatus = "completed" | "error" | "analyzing" | "pending";
export const meetingStatus = (report: ReportData): MeetingStatus =>
  report.status === "completed" ||
  report.status === "error" ||
  report.status === "analyzing"
    ? report.status
    : "pending";

interface Dated {
  date: string;
  durationMs?: number;
}

export interface MonthGroup<T extends Dated = Dated> {
  key: string;
  label: string;
  reports: T[];
}

const MONTHS = [
  "Jänner", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/** `absolute` keeps the month name for surfaces that navigate between months,
 *  where "Dieser Monat" would hide which month is on screen. */
export function monthLabel(month: string, now: Date, absolute = false): string {
  const [year, index] = month.split("-").map(Number);
  const name = `${MONTHS[index - 1]} ${year}`;
  const current = month === `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  return current && !absolute ? "Dieser Monat" : name;
}

/** Month headings give the list rhythm: an identical absolute date on every
 *  row cannot show that one meeting was yesterday and the next was a year ago. */
export function groupByMonth<T extends Dated>(
  reports: T[],
  now: Date,
): MonthGroup<T>[] {
  const groups = new Map<string, T[]>();
  const undated: T[] = [];
  for (const report of reports) {
    if (!isValidDate(report.date)) {
      undated.push(report);
      continue;
    }
    const key = monthKeyOf(report.date);
    const bucket = groups.get(key);
    if (bucket) bucket.push(report);
    else groups.set(key, [report]);
  }
  const result = [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, items]) => ({ key, label: monthLabel(key, now), reports: items }));
  if (undated.length)
    result.push({ key: "", label: "Ohne Datum", reports: undated });
  return result;
}

export interface DayCell {
  key: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  count: number;
  minutes: number;
  /** Scheduled and not yet recorded — the future half of the same day. */
  events: number;
}

export function meetingsByDay<T extends Dated>(reports: T[]): Map<string, T[]> {
  const days = new Map<string, T[]>();
  for (const report of reports) {
    if (!isValidDate(report.date)) continue;
    const key = localDayKey(report.date);
    const bucket = days.get(key);
    if (bucket) bucket.push(report);
    else days.set(key, [report]);
  }
  return days;
}

/** Monday-first weeks, only as many as the month actually spans: a trailing
 *  row made entirely of the next month's days is padding, not a week. */
export function buildMonthGrid(
  month: string,
  reports: Dated[],
  now: Date,
  /** Scheduled entries per day key. Absent without a calendar grant. */
  scheduled?: Map<string, { length: number }>,
): DayCell[][] {
  const byDay = meetingsByDay(reports);
  const today = localDayKey(now.toISOString());
  const [year, index] = month.split("-").map(Number);
  const first = new Date(year, index - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, index - 1, 1 - offset);
  const length = new Date(year, index, 0).getDate();
  const weeks: DayCell[][] = [];
  for (let week = 0; week < Math.ceil((offset + length) / 7); week++) {
    const row: DayCell[] = [];
    for (let day = 0; day < 7; day++) {
      const at = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + week * 7 + day,
      );
      const key = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
      const inMonth =
        at.getMonth() === index - 1 && at.getFullYear() === year;
      // A leading or trailing cell belongs to another month, so it stays blank
      // even if that day has meetings: selecting it would open an empty panel.
      const items = inMonth ? byDay.get(key) || [] : [];
      row.push({
        key,
        day: at.getDate(),
        inMonth,
        isToday: key === today,
        count: items.length,
        minutes: Math.round(
          items.reduce((sum, r) => sum + (r.durationMs || 0), 0) / 60000,
        ),
        events: inMonth ? scheduled?.get(key)?.length || 0 : 0,
      });
    }
    weeks.push(row);
  }
  return weeks;
}

/** Three discrete steps, not a continuous heatmap: with a handful of meetings
 *  a day, a smooth scale reads as noise rather than as information. */
export const dayIntensity = (cell: DayCell): 0 | 1 | 2 | 3 =>
  !cell.count ? 0 : cell.minutes >= 120 ? 3 : cell.minutes >= 30 ? 2 : 1;

/**
 * Which slice of a month is worth asking Google about.
 *
 * A month already over has no recordable future in it, and an unrecorded past
 * event is not something the user can act on — so it costs nothing and is
 * fetched as nothing. The current month starts at local midnight rather than
 * at `now`, because "Heute" at 14:00 must still show the 09:00 standup.
 */
export function monthEventRange(
  month: string,
  now: Date,
): { fromMs: number; toMs: number } | null {
  const [year, index] = month.split("-").map(Number);
  const end = new Date(year, index, 1).getTime();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  if (end <= midnight) return null;
  const start = new Date(year, index - 1, 1).getTime();
  return { fromMs: Math.max(start, midnight), toMs: end };
}

/** Today, tomorrow, then the weekday — the way a person reads a schedule. */
export function dayHeading(key: string, now: Date): string {
  const today = localDayKey(now.toISOString());
  const tomorrow = localDayKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
  );
  if (key === today) return "Heute";
  if (key === tomorrow) return "Morgen";
  return dayKeyLabel(key, { weekday: "long", day: "numeric", month: "long" });
}

const searchable = (report: ReportSummary): string[] => [
  report.title,
  report.summary,
  report.transcription,
  report.items,
  // Who was in the room is the other thing you look a meeting up by.
  ...report.speakers,
];

export function matchesQuery(report: ReportSummary, needle: string): boolean {
  if (!needle) return true;
  return searchable(report).some((field) =>
    field?.toLowerCase().includes(needle),
  );
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

/**
 * The text around a transcript hit, so a search result says *why* it matched.
 * Returns null when the hit is not in prose, letting the caller fall back to
 * the summary instead of printing a constant "matched somewhere" string.
 */
export function searchSnippet(
  report: ReportSummary,
  needle: string,
): Snippet | null {
  if (!needle) return null;
  const text = report.transcription || report.summary || "";
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  const from = Math.max(0, at - 70);
  const to = Math.min(text.length, at + needle.length + 110);
  return {
    before: `${from > 0 ? "… " : ""}${text.slice(from, at)}`,
    match: text.slice(at, at + needle.length),
    after: `${text.slice(at + needle.length, to)}${to < text.length ? " …" : ""}`,
  };
}

/**
 * What a list of meetings needs to know.
 *
 * `speech.turns` — one object per utterance, carrying the transcript text a
 * second time and typically the bulk of a report — is dropped, because the
 * list never renders a turn. `transcription` is deliberately kept: search runs
 * over it and the row quotes the matching passage back. So this bounds the
 * archive's footprint rather than eliminating it.
 */
export interface ReportSummary {
  id: string;
  date: string;
  updatedAt?: string;
  title: string;
  summary: string;
  status: MeetingStatus;
  error?: string;
  todoCount: number;
  /** What is still owed; a list of ticked boxes is not a list of work. */
  openTodoCount: number;
  takeawayCount: number;
  /** Already resolved against the transcript, so callers never need the turns. */
  durationMs: number;
  speakers: string[];
  needsReview: boolean;
  driveFolderId?: string;
  driveSyncedAt?: string;
  /** Lets an upcoming event show its report instead of offering a re-record. */
  calendarEventId?: string;
  /** Kept whole: search matches on it and the row quotes it back. */
  transcription: string;
  /** To-dos and takeaways as one string, so search still reaches them. */
  items: string;
}

/** The names a person actually reads, deduplicated, without the turns. */
export function speakerNamesOf(speech?: MeetingTranscript): string[] {
  // `speech` can come back from Drive as anything; one bad record must not
  // throw where the whole list is being built.
  if (!Array.isArray(speech?.turns) || !speech.turns.length) return [];
  const seen = new Map<string, string>();
  for (const turn of speech.turns) {
    if (turn.speaker.endsWith(":unknown") || seen.has(turn.speaker)) continue;
    seen.set(turn.speaker, speakerLabel(speech, turn));
  }
  return [...new Set(seen.values())];
}

export function summarise(report: ReportData): ReportSummary {
  return {
    id: report.id,
    date: report.date,
    updatedAt: report.updatedAt,
    title: report.title,
    summary: report.summary,
    status: meetingStatus(report),
    error: report.error,
    todoCount: report.todos?.length || 0,
    openTodoCount: (report.todos || []).filter((todo) => !todo.done).length,
    takeawayCount: report.takeaways?.length || 0,
    durationMs: meetingDurationMs(report),
    speakers: speakerNamesOf(report.speech),
    needsReview: needsSpeakerReview(report.speech),
    driveFolderId: report.driveFolderId,
    driveSyncedAt: report.driveSyncedAt,
    calendarEventId: report.calendarEventId,
    transcription: report.transcription || "",
    items: [
      ...(report.todos || []).map((todo) => `${todo.text} ${todo.owner || ""}`),
      ...(report.takeaways || []),
    ].join(" "),
  };
}

/**
 * Every person you have named, newest mention first. Speaker names live inside
 * each report and nowhere else, so the archive itself is the address book —
 * no new store, no rules change, no second source of truth to drift.
 */
export function knownSpeakers(summaries: ReportSummary[]): string[] {
  const seen = new Set<string>();
  for (const summary of summaries)
    for (const name of summary.speakers)
      // "Sprecher 3" is a placeholder, not a person.
      if (!/^Sprecher \d+$/.test(name) && name !== "Unbekannt") seen.add(name);
  return [...seen];
}
