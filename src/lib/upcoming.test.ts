import { describe, expect, it } from "vitest";
import {
  countdownLabel,
  guestLabel,
  hasGuests,
  isOver,
  isRunning,
  splitUpcoming,
  timeLabel,
} from "./upcoming";
import type { CalendarEvent } from "./calendar";

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
  description: "",
  ...over,
});

const now = at(8, 0);

describe("hasGuests", () => {
  it("separates a meeting from a personal block", () => {
    expect(hasGuests(event())).toBe(true);
    expect(hasGuests(event({ title: "krauckie gym", attendees: [] }))).toBe(false);
  });
});

describe("isOver / isRunning", () => {
  it("treats a running meeting as still recordable", () => {
    const e = event();
    expect(isRunning(e, at(10, 0))).toBe(true);
    expect(isOver(e, at(10, 0))).toBe(false);
  });
  it("treats a finished one as over, exactly at its end", () => {
    expect(isOver(event(), at(10, 30))).toBe(true);
    expect(isRunning(event(), at(10, 30))).toBe(false);
  });
});

describe("splitUpcoming", () => {
  const karaoke = event({ id: "k", title: "ROX Karaoke Night", attendees: [], startMs: at(20), endMs: at(23) });
  const gym = event({ id: "g", title: "krauckie gym", attendees: [], allDay: true, startMs: at(0, 0, 20), endMs: at(0, 0, 21) });
  const call = event({ id: "c", title: "AI Product Call" });
  const later = event({ id: "l", title: "Retro", startMs: at(16), endMs: at(17) });

  it("promotes the next meeting with guests and lists the rest behind it", () => {
    const split = splitUpcoming([karaoke, later, call, gym], now);
    expect(split.next?.id).toBe("c");
    expect(split.meetings.map((e) => e.id)).toEqual(["l"]);
  });

  it("folds the things that are not meetings away, without losing them", () => {
    const split = splitUpcoming([karaoke, call, gym], now);
    expect(split.personal.map((e) => e.id)).toEqual(["k", "g"]);
    expect(split.next?.id).toBe("c");
  });

  it("drops what has already finished", () => {
    const done = event({ id: "d", startMs: at(6), endMs: at(7) });
    const split = splitUpcoming([done, call], now);
    expect(split.next?.id).toBe("c");
    expect([...split.meetings, ...split.personal].map((e) => e.id)).not.toContain("d");
  });

  it("keeps a meeting that is running right now as the next one", () => {
    expect(splitUpcoming([event()], at(10, 0)).next?.id).toBe("e1");
  });

  it("has no hero when nothing has guests", () => {
    const split = splitUpcoming([karaoke, gym], now);
    expect(split.next).toBe(null);
    expect(split.personal).toHaveLength(2);
  });

  it("orders by start time regardless of input order", () => {
    const split = splitUpcoming([later, call], now);
    expect(split.next?.id).toBe("c");
  });
});

describe("timeLabel", () => {
  it("shows the range for a normal meeting", () => {
    expect(timeLabel(event())).toBe("09:30–10:30");
  });
  it("never renders an all-day event as midnight", () => {
    expect(timeLabel(event({ allDay: true }))).toBe("Ganztägig");
  });
  it("shows a single time when there is no duration", () => {
    expect(timeLabel(event({ endMs: at(9, 30) }))).toBe("09:30");
  });
});

describe("countdownLabel", () => {
  it("says what is happening now", () => {
    expect(countdownLabel(event(), at(10, 0))).toBe("läuft gerade");
  });
  it("counts down in minutes, then hours", () => {
    expect(countdownLabel(event(), at(9, 18))).toBe("in 12 Min");
    expect(countdownLabel(event(), at(8, 0))).toBe("in 1 Std 30 Min");
    expect(countdownLabel(event(), at(7, 30))).toBe("in 2 Std");
  });
  it("collapses the last minute rather than showing 'in 0 Min'", () => {
    expect(countdownLabel(event(), at(9, 30) - 30_000)).toBe("gleich");
  });
  it("switches to a clock time once it is far enough out", () => {
    const evening = event({ startMs: at(21), endMs: at(22) });
    expect(countdownLabel(evening, at(8, 0))).toBe("heute 21:00");
  });
  it("names tomorrow and the weekday beyond that", () => {
    const tomorrow = event({ startMs: at(9, 0, 17), endMs: at(10, 0, 17) });
    expect(countdownLabel(tomorrow, now)).toBe("morgen 09:00");
    const later = event({ startMs: at(9, 0, 19), endMs: at(10, 0, 19) });
    expect(countdownLabel(later, now)).toMatch(/^(Mo|Di|Mi|Do|Fr|Sa|So)\.? 09:00$/);
  });
  it("drops the clock time for an all-day entry", () => {
    const allDay = event({ allDay: true, startMs: at(0, 0, 17), endMs: at(0, 0, 18) });
    expect(countdownLabel(allDay, now)).toBe("morgen");
  });
});

describe("guestLabel", () => {
  it("names a small group and counts a large one", () => {
    expect(guestLabel(event({ attendees: ["Anna", "Ben"] }))).toBe("Anna, Ben");
    expect(guestLabel(event({ attendees: ["Anna", "Ben", "Clara", "Dora"] }))).toBe(
      "Anna, Ben +2",
    );
  });
  it("is empty for a solo block", () => {
    expect(guestLabel(event({ attendees: [] }))).toBe("");
  });
});

describe("events that cross midnight or fill a day", () => {
  it("names the end day when an event runs past midnight", () => {
    const night = event({ startMs: at(22), endMs: at(2, 0, 17) });
    const label = timeLabel(night);
    expect(label).toContain("22:00");
    // Never the impossible-looking "22:00–02:00" under one day heading.
    expect(label).not.toBe("22:00–02:00");
    expect(label).toMatch(/22:00 – \w+/);
  });
  it("keeps the compact range for a normal same-day meeting", () => {
    expect(timeLabel(event())).toBe("09:30–10:30");
  });
  it("never counts an all-day entry down to midnight", () => {
    const allDay = event({ allDay: true, startMs: at(0, 0, 17), endMs: at(0, 0, 18) });
    // 23:50 the night before: the minute branch would have said "in 10 Min".
    expect(countdownLabel(allDay, at(23, 50))).toBe("morgen");
    expect(countdownLabel(allDay, at(14, 0))).toBe("morgen");
  });
});
