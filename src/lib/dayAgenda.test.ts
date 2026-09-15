import { describe, expect, it } from "vitest";
import {
  buildAgenda,
  dayAgenda,
  recordedEventIds,
  scheduledByDay,
} from "./dayAgenda";
import type { CalendarEvent } from "./calendar";
import type { ReportSummary } from "./meetingMeta";

const at = (h: number, m = 0, day = 16) =>
  new Date(2026, 8, day, h, m).getTime();

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e1",
  calendarId: "primary",
  title: "Weekly Sync",
  startMs: at(9, 30),
  endMs: at(10, 30),
  allDay: false,
  attendees: ["Maik Retzlaff"],
  conference: false,
  kind: "default",
  description: "",
  ...over,
});

const report = (over: Partial<ReportSummary> = {}): ReportSummary =>
  ({
    id: "r1",
    title: "Erstgespräch",
    date: new Date(at(14)).toISOString(),
    durationMs: 1800000,
    status: "completed",
    ...over,
  }) as ReportSummary;

describe("recordedEventIds", () => {
  it("collects only the reports that are linked to an event", () => {
    const ids = recordedEventIds([
      report({ id: "a", calendarEventId: "e1" }),
      report({ id: "b" }),
    ]);
    expect([...ids]).toEqual(["e1"]);
  });
});

describe("scheduledByDay", () => {
  it("buckets by local day", () => {
    const days = scheduledByDay(
      [event(), event({ id: "e2", startMs: at(9, 0, 17), endMs: at(10, 0, 17) })],
      new Set(),
    );
    expect([...days.keys()].sort()).toEqual(["2026-09-16", "2026-09-17"]);
  });

  it("drops an event that has already been recorded", () => {
    // Otherwise the month grid counts a done meeting as still to do.
    expect(scheduledByDay([event()], new Set(["e1"])).size).toBe(0);
  });
});

describe("buildAgenda", () => {
  it("interleaves recordings and events in time order", () => {
    const morning = event({ id: "m", startMs: at(8), endMs: at(9) });
    const evening = event({ id: "v", startMs: at(20), endMs: at(22) });
    const entries = buildAgenda([report()], [evening, morning], new Set());
    expect(entries.map((e) => (e.kind === "report" ? e.report.id : e.event.id))).toEqual(
      ["m", "r1", "v"],
    );
  });

  it("lets the report replace the event it recorded", () => {
    const entries = buildAgenda(
      [report({ calendarEventId: "e1" })],
      [event()],
      new Set(["e1"]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("report");
  });

  it("leads the day with a whole-day entry instead of sorting it to midnight", () => {
    const allDay = event({ id: "g", allDay: true, startMs: at(0), endMs: at(0, 0, 17) });
    const early = event({ id: "e", startMs: at(8), endMs: at(9) });
    const entries = buildAgenda([], [early, allDay], new Set());
    expect(entries.map((e) => (e.kind === "event" ? e.event.id : ""))).toEqual(["g", "e"]);
  });

  it("keeps a whole-day entry on its own day rather than at the top of the month", () => {
    // The month-wide list is ordered only by this sort, so an all-day-first
    // rule applied across days printed a holiday on the 28th above a meeting
    // on the 16th.
    const holiday = event({
      id: "h",
      allDay: true,
      startMs: at(0, 0, 28),
      endMs: at(0, 0, 29),
    });
    const meeting = event({ id: "m", startMs: at(9, 0, 16), endMs: at(10, 0, 16) });
    const entries = buildAgenda([], [holiday, meeting], new Set());
    expect(entries.map((e) => (e.kind === "event" ? e.event.id : ""))).toEqual(["m", "h"]);
  });

  it("tells each entry which day it belongs to", () => {
    const [entry] = buildAgenda([report()], [], new Set());
    expect(entry.dayKey).toBe("2026-09-16");
  });

  it("marks an entry with nobody in it as quiet rather than hiding it", () => {
    const karaoke = event({ id: "k", attendees: [], title: "ROX Karaoke Night" });
    const [entry] = buildAgenda([], [karaoke], new Set());
    expect(entry.kind === "event" && entry.quiet).toBe(true);
    const [meeting] = buildAgenda([], [event()], new Set());
    expect(meeting.kind === "event" && meeting.quiet).toBe(false);
  });
});

describe("dayAgenda", () => {
  it("keeps only what belongs to that day, from both sides", () => {
    const other = event({ id: "o", startMs: at(9, 0, 17), endMs: at(10, 0, 17) });
    const entries = dayAgenda(
      "2026-09-16",
      [report(), report({ id: "r2", date: new Date(at(11, 0, 17)).toISOString() })],
      [event(), other],
      new Set(),
    );
    expect(entries.map((e) => (e.kind === "report" ? e.report.id : e.event.id))).toEqual(
      ["e1", "r1"],
    );
  });

  it("ignores a report with no usable date", () => {
    expect(dayAgenda("2026-09-16", [report({ date: "" })], [], new Set())).toHaveLength(0);
  });
});
