import { describe, expect, it } from "vitest";
import {
  countdownLabel,
  guestLabel,
  hasGuests,
  imminentMeeting,
  isMeeting,
  isOver,
  isRecordable,
  isRunning,
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
  conference: false,
  kind: "default",
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

describe("isMeeting", () => {
  it("counts a video link as company, not just an attendee list", () => {
    expect(isMeeting(event({ attendees: [] }))).toBe(false);
    expect(isMeeting(event({ attendees: [], conference: true }))).toBe(true);
    expect(isMeeting(event())).toBe(true);
  });
});

describe("isRecordable", () => {
  it("rejects what has nobody to meet", () => {
    expect(isRecordable(event({ kind: "birthday" }))).toBe(false);
    expect(isRecordable(event({ kind: "workingLocation" }))).toBe(false);
    // A ticket Gmail parsed out of a confirmation mail is not a meeting.
    expect(isRecordable(event({ kind: "fromGmail" }))).toBe(false);
  });

  it("accepts a plain entry, attendees or not", () => {
    expect(isRecordable(event())).toBe(true);
    expect(isRecordable(event({ attendees: [] }))).toBe(true);
  });

  it("keeps a whole-day entry recordable — a day-long workshop is a sitting", () => {
    // Only the countdown excludes all-day entries; the offer to record must not.
    expect(isRecordable(event({ allDay: true }))).toBe(true);
  });
});

describe("imminentMeeting", () => {
  const call = event({ id: "c", startMs: at(8, 20), endMs: at(9) });
  const later = event({ id: "l", startMs: at(16), endMs: at(17) });
  const gym = event({
    id: "g",
    title: "krauckie gym",
    attendees: [],
    allDay: true,
    startMs: at(0),
    endMs: at(0, 0, 17),
  });

  it("alerts for an entry without attendees — guests rank, they do not gate", () => {
    // The regression this exists to prevent: a calendar whose meetings carry
    // no attendee list produced no alert at all, and read as broken.
    const solo = event({ id: "s", attendees: [], startMs: at(8, 10), endMs: at(9) });
    expect(imminentMeeting([solo], now)?.id).toBe("s");
  });

  it("stays quiet until the meeting is close", () => {
    expect(imminentMeeting([later], now)).toBe(null);
    expect(imminentMeeting([call], now)?.id).toBe("c");
  });

  it("never alerts for a whole-day block", () => {
    expect(imminentMeeting([gym], now)).toBe(null);
  });

  it("prefers the one already running over the one about to start", () => {
    const running = event({ id: "r", startMs: at(7, 50), endMs: at(8, 30) });
    expect(imminentMeeting([call, running], now)?.id).toBe("r");
  });

  it("drops what has already finished", () => {
    const done = event({ id: "d", startMs: at(7), endMs: at(7, 30) });
    expect(imminentMeeting([done], now)).toBe(null);
  });

  it("takes the soonest, then prefers one with people in it", () => {
    const solo = event({ id: "s", attendees: [], startMs: at(8, 20), endMs: at(9) });
    expect(imminentMeeting([solo, call], now)?.id).toBe("c");
    const sooner = event({ id: "x", attendees: [], startMs: at(8, 5), endMs: at(9) });
    expect(imminentMeeting([sooner, call], now)?.id).toBe("x");
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
