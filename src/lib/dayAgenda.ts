import type { CalendarEvent } from "./calendar";
import { localDayKey, type ReportSummary } from "./meetingMeta";
import { isMeeting } from "./upcoming";

/**
 * One day, one list.
 *
 * The calendar page used to stack two calendars on top of each other: what is
 * scheduled, and — far below, behind its own heading — what was recorded. They
 * are the same days. Merging them is the whole point: a Tuesday with a
 * ten-o'clock meeting you recorded and a four-o'clock one you have not is one
 * sequence, not two lists.
 */
type Timed = { atMs: number; dayKey: string; allDay: boolean };
/** Legacy primary Google IDs stay compatible; other identities are fully scoped. */
export const eventKey = (
  event: Pick<CalendarEvent, "id" | "calendarId" | "provider" | "connectionId">,
) =>
  (!event.provider || event.provider === "google") &&
  (!event.calendarId || event.calendarId === "primary")
    ? event.id
    : JSON.stringify([
        event.provider || "google",
        event.connectionId || "",
        event.calendarId,
        event.id,
      ]);
export const reportEventKey = (report: ReportSummary) =>
  report.calendarEventId
    ? eventKey({
        id: report.calendarEventId,
        calendarId: report.calendarId || "primary",
        provider: report.calendarProvider,
        connectionId: report.calendarConnectionId,
      })
    : undefined;
export type AgendaEntry =
  | (Timed & { kind: "report"; allDay: false; report: ReportSummary })
  | (Timed & { kind: "event"; event: CalendarEvent; quiet: boolean });

/**
 * Events that still need recording, by local day.
 *
 * An event whose recording already exists is dropped here rather than in the
 * view: the report says everything the calendar stub does and more, so the
 * month grid must not count it as still-to-do either.
 */
type AgendaRange = { fromMs: number; toMs: number };
/** Local calendar increments, not 24-hour jumps: DST days are not always 24h. */
function occupiedDays(
  event: CalendarEvent,
  range?: AgendaRange,
): { key: string; atMs: number }[] {
  const start = Math.max(event.startMs, range?.fromMs ?? -Infinity);
  const end = Math.min(
    Math.max(event.endMs, event.startMs + 1),
    range?.toMs ?? Infinity,
  );
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    return [];
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  const days: { key: string; atMs: number }[] = [];
  while (day.getTime() < end) {
    days.push({
      key: localDayKey(day.toISOString()),
      atMs: Math.max(event.startMs, day.getTime()),
    });
    day.setDate(day.getDate() + 1);
  }
  return days;
}
export function scheduledByDay(
  events: CalendarEvent[],
  recorded: Set<string>,
  range?: AgendaRange,
): Map<string, CalendarEvent[]> {
  const days = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    if (recorded.has(eventKey(event))) continue;
    for (const { key } of occupiedDays(event, range)) {
      const bucket = days.get(key);
      if (bucket) bucket.push(event);
      else days.set(key, [event]);
    }
  }
  return days;
}

/** Which calendar events already have a recording behind them. */
export const recordedEventIds = (reports: ReportSummary[]): Set<string> =>
  new Set(
    reports.map(reportEventKey).filter((id): id is string => Boolean(id)),
  );

/**
 * Recordings and still-unrecorded events in one chronological list.
 *
 * Callers narrow to a day or a month first; this only orders. A whole-day
 * entry has no time to sort by, so it leads its own day rather than landing at
 * midnight ahead of an 08:00 meeting it does not precede.
 */
export function buildAgenda(
  reports: ReportSummary[],
  events: CalendarEvent[],
  recorded: Set<string>,
  range?: AgendaRange,
): AgendaEntry[] {
  const entries: AgendaEntry[] = reports.map((report) => ({
    kind: "report",
    atMs: Date.parse(report.date) || 0,
    dayKey: localDayKey(report.date),
    allDay: false,
    report,
  }));
  for (const event of events) {
    if (recorded.has(eventKey(event))) continue;
    for (const day of occupiedDays(event, range))
      entries.push({
        kind: "event",
        atMs: day.atMs,
        dayKey: day.key,
        allDay: event.allDay,
        event,
        quiet: !isMeeting(event),
      });
  }
  return entries.sort((a, b) => {
    // Day first. The all-day lead is a rule *within* a day: applied across a
    // whole month it floated every holiday and vacation block above meetings
    // three weeks earlier, in a list whose only ordering cue is its order.
    if (a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.atMs - b.atMs;
  });
}

/** The same list, narrowed to one local day. */
export const dayAgenda = (
  dayKey: string,
  reports: ReportSummary[],
  events: CalendarEvent[],
  recorded: Set<string>,
): AgendaEntry[] =>
  buildAgenda(
    reports.filter((report) => localDayKey(report.date) === dayKey),
    events,
    recorded,
    {
      fromMs: new Date(`${dayKey}T00:00:00`).getTime(),
      toMs: (() => {
        const end = new Date(`${dayKey}T00:00:00`);
        end.setDate(end.getDate() + 1);
        return end.getTime();
      })(),
    },
  );
