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
export function scheduledByDay(
  events: CalendarEvent[],
  recorded: Set<string>,
): Map<string, CalendarEvent[]> {
  const days = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    if (recorded.has(event.id)) continue;
    const key = localDayKey(new Date(event.startMs).toISOString());
    const bucket = days.get(key);
    if (bucket) bucket.push(event);
    else days.set(key, [event]);
  }
  return days;
}

/** Which calendar events already have a recording behind them. */
export const recordedEventIds = (reports: ReportSummary[]): Set<string> =>
  new Set(
    reports
      .map((report) => report.calendarEventId)
      .filter((id): id is string => Boolean(id)),
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
): AgendaEntry[] {
  const entries: AgendaEntry[] = reports.map((report) => ({
    kind: "report",
    atMs: Date.parse(report.date) || 0,
    dayKey: localDayKey(report.date),
    allDay: false,
    report,
  }));
  for (const event of events) {
    if (recorded.has(event.id)) continue;
    entries.push({
      kind: "event",
      atMs: event.startMs,
      dayKey: localDayKey(new Date(event.startMs).toISOString()),
      allDay: event.allDay,
      event,
      // Not hidden, not shouting. The karaoke night stays reachable; it just
      // stops competing with the meeting two rows down.
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
    events.filter(
      (event) => localDayKey(new Date(event.startMs).toISOString()) === dayKey,
    ),
    recorded,
  );
