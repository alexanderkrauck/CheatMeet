import { describe, expect, it } from "vitest";
import {
  buildMonthGrid,
  calendarState,
  dayHeading,
  dayKeyLabel,
  isMonthKey,
  plural,
  knownSpeakers,
  speakerNamesOf,
  summarise,
  dayIntensity,
  formatDuration,
  groupByMonth,
  isValidDate,
  localDayKey,
  meetingDurationMs,
  meetingStatus,
  matchesQuery,
  monthEventRange,
  monthKeyOf,
  searchSnippet,
  shiftMonth,
  speakerCount,
} from "./meetingMeta";
import type { ReportData } from "../types";

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: "2026-09-14T08:30:00.000Z",
  title: "Weekly",
  summary: "",
  transcription: "",
  todos: [],
  takeaways: [],
  ...over,
});

const turn = (id: string, speaker: string, endMs: number) => ({
  id,
  speaker,
  startMs: 0,
  endMs,
  text: "",
  final: true,
});

describe("isValidDate", () => {
  it("accepts the date-only form the Drive restore path admits", () => {
    expect(isValidDate("2026-09-14")).toBe(true);
  });
  it("rejects what would render as Invalid Date", () => {
    expect(isValidDate("irgendwann")).toBe(false);
    expect(isValidDate("")).toBe(false);
    expect(isValidDate(undefined)).toBe(false);
  });
});

describe("localDayKey", () => {
  it("buckets by wall clock, not by the UTC day Drive folders use", () => {
    // 23:30 in UTC+2 is still the 14th locally but the 15th in UTC, which is
    // the day the Drive subfolder is named after.
    const late = new Date(2026, 8, 14, 23, 30).toISOString();
    expect(localDayKey(late)).toBe("2026-09-14");
    expect(late.slice(0, 10) === "2026-09-14").toBe(
      new Date(late).getUTCDate() === 14,
    );
  });
  it("pads single-digit months and days", () => {
    expect(localDayKey(new Date(2026, 0, 3, 12).toISOString())).toBe("2026-01-03");
  });
});

describe("shiftMonth", () => {
  it("rolls over the year in both directions", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
  it("is the inverse of itself", () => {
    expect(shiftMonth(shiftMonth("2026-09", 5), -5)).toBe("2026-09");
  });
});

describe("meetingDurationMs", () => {
  it("prefers the recorded clock", () => {
    expect(meetingDurationMs(report({ durationMs: 60_000 }))).toBe(60_000);
  });
  it("recovers a duration for imports, which store durationMs: 0", () => {
    const imported = report({
      durationMs: 0,
      speech: {
        provider: "assemblyai",
        phase: "final",
        languages: ["de"],
        turns: [turn("a", "batch:A", 5_000), turn("b", "batch:B", 92_000)],
        speakerNames: {},
      },
    });
    expect(meetingDurationMs(imported)).toBe(92_000);
  });
  it("is zero when nothing knows the length", () => {
    expect(meetingDurationMs(report())).toBe(0);
  });
});

describe("formatDuration", () => {
  it("never rounds a real recording down to nothing", () => {
    expect(formatDuration(20_000)).toBe("< 1 Min");
  });
  it("switches to hours past sixty minutes", () => {
    expect(formatDuration(47 * 60_000)).toBe("47 Min");
    expect(formatDuration(72 * 60_000)).toBe("1 Std 12 Min");
  });
});

describe("speakerCount", () => {
  it("counts distinct voices and ignores unassigned audio", () => {
    const speech = {
      provider: "assemblyai" as const,
      phase: "final" as const,
      languages: ["de"],
      turns: [
        turn("1", "mic:1", 10),
        turn("2", "mic:1", 20),
        turn("3", "system:2", 30),
        turn("4", "system:unknown", 40),
      ],
      speakerNames: {},
    };
    expect(speakerCount(speech)).toBe(2);
  });
  it("is zero without a structured transcript", () => {
    expect(speakerCount(undefined)).toBe(0);
  });
});

describe("meetingStatus", () => {
  it("treats an absent status as a draft rather than as completed", () => {
    expect(meetingStatus(report())).toBe("pending");
    expect(meetingStatus(report({ status: "completed" }))).toBe("completed");
  });
});

describe("groupByMonth", () => {
  const now = new Date(2026, 8, 14);
  it("orders months newest first and names the current one relatively", () => {
    const groups = groupByMonth(
      [
        report({ id: "a", date: new Date(2026, 8, 2, 9).toISOString() }),
        report({ id: "b", date: new Date(2026, 7, 30, 9).toISOString() }),
        report({ id: "c", date: new Date(2026, 8, 9, 9).toISOString() }),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["Dieser Monat", "August 2026"]);
    expect(groups[0].reports.map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("keeps unparseable dates visible instead of dropping them", () => {
    const groups = groupByMonth(
      [report({ id: "a" }), report({ id: "x", date: "irgendwann" })],
      now,
    );
    expect(groups.at(-1)).toMatchObject({ key: "", label: "Ohne Datum" });
    expect(groups.at(-1)!.reports.map((r) => r.id)).toEqual(["x"]);
  });
});

describe("buildMonthGrid", () => {
  const now = new Date(2026, 8, 14, 10);
  it("opens on the Monday before the first and covers the last day", () => {
    const weeks = buildMonthGrid("2026-09", [], now);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // 1 September 2026 is a Tuesday, so the grid opens on 31 August.
    expect(weeks[0][0]).toMatchObject({ day: 31, inMonth: false });
    expect(weeks[0][1]).toMatchObject({ day: 1, inMonth: true });
    expect(weeks.flat().filter((c) => c.inMonth)).toHaveLength(30);
  });
  it("never renders a week made only of the neighbouring months", () => {
    for (const month of ["2026-01", "2026-02", "2026-09", "2027-02", "2028-10"]) {
      const weeks = buildMonthGrid(month, [], now);
      expect(weeks.every((week) => week.some((cell) => cell.inMonth))).toBe(true);
      expect(weeks.at(-1)!.some((cell) => cell.inMonth)).toBe(true);
    }
  });
  it("uses five rows for a month that fits in five and six when it does not", () => {
    // February 2026 starts on a Sunday: 1 leading blank + 28 days = 5 rows.
    expect(buildMonthGrid("2026-02", [], now)).toHaveLength(5);
    // May 2027 starts on a Saturday: 5 leading blanks + 31 days = 6 rows.
    expect(buildMonthGrid("2027-05", [], now)).toHaveLength(6);
  });
  it("totals count and minutes onto the day a meeting actually happened", () => {
    const weeks = buildMonthGrid(
      "2026-09",
      [
        report({ id: "a", date: new Date(2026, 8, 14, 9).toISOString(), durationMs: 30 * 60_000 }),
        report({ id: "b", date: new Date(2026, 8, 14, 15).toISOString(), durationMs: 20 * 60_000 }),
      ],
      now,
    );
    const cell = weeks.flat().find((c) => c.key === "2026-09-14")!;
    expect(cell).toMatchObject({ count: 2, minutes: 50, isToday: true });
    expect(weeks.flat().filter((c) => c.count).length).toBe(1);
  });
  it("leaves a neighbouring month's own meetings out of the padding cells", () => {
    // 31 August 2026 is the grid's first cell for September.
    const weeks = buildMonthGrid(
      "2026-09",
      [report({ date: new Date(2026, 7, 31, 10).toISOString(), durationMs: 60_000 })],
      now,
    );
    expect(weeks[0][0]).toMatchObject({ day: 31, inMonth: false, count: 0 });
    expect(weeks.flat().every((c) => c.count === 0)).toBe(true);
  });
  it("leaves neighbouring-month cells empty of this month's meetings", () => {
    const weeks = buildMonthGrid(
      "2026-10",
      [report({ date: new Date(2026, 8, 14, 9).toISOString() })],
      now,
    );
    expect(weeks.flat().every((c) => c.count === 0)).toBe(true);
  });
});

describe("dayIntensity", () => {
  const cell = (count: number, minutes: number, events = 0) => ({
    key: "2026-09-14", day: 14, inMonth: true, isToday: false, count, minutes, events,
  });
  it("steps with recorded time and is flat when nothing was recorded", () => {
    expect(dayIntensity(cell(0, 0))).toBe(0);
    expect(dayIntensity(cell(1, 10))).toBe(1);
    expect(dayIntensity(cell(1, 45))).toBe(2);
    expect(dayIntensity(cell(3, 200))).toBe(3);
  });
  it("is driven by the past only — a day of scheduled events stays unfilled", () => {
    // Fill means recorded. Letting the future tint the cell would make the two
    // channels say the same thing in different alphabets.
    expect(dayIntensity(cell(0, 0, 4))).toBe(0);
  });
});

describe("buildMonthGrid scheduled counts", () => {
  const now = new Date(2026, 8, 14, 10);
  it("counts scheduled entries per day without touching the recorded count", () => {
    const weeks = buildMonthGrid(
      "2026-09",
      [report({ date: new Date(2026, 8, 14, 9).toISOString() })],
      now,
      new Map([["2026-09-14", { length: 2 }], ["2026-09-21", { length: 5 }]]),
    );
    const day = (key: string) => weeks.flat().find((c) => c.key === key)!;
    expect(day("2026-09-14").count).toBe(1);
    expect(day("2026-09-14").events).toBe(2);
    expect(day("2026-09-21").count).toBe(0);
    expect(day("2026-09-21").events).toBe(5);
  });

  it("leaves a neighbouring month's cell blank in both channels", () => {
    const weeks = buildMonthGrid("2026-10", [], now, new Map([["2026-09-28", { length: 3 }]]));
    const outside = weeks.flat().find((c) => c.key === "2026-09-28")!;
    expect(outside.inMonth).toBe(false);
    expect(outside.events).toBe(0);
  });

  it("reports no scheduled entries at all without a calendar grant", () => {
    const weeks = buildMonthGrid("2026-09", [], now);
    expect(weeks.flat().every((c) => c.events === 0)).toBe(true);
  });
});

describe("monthEventRange", () => {
  const now = new Date(2026, 8, 14, 10);
  it("asks for nothing in a month that is already over", () => {
    expect(monthEventRange("2026-08", now)).toBe(null);
  });

  it("starts the current month at local midnight, not at the current time", () => {
    // "Heute" at 14:00 must still list the 09:00 standup.
    const range = monthEventRange("2026-09", now)!;
    expect(range.fromMs).toBe(new Date(2026, 8, now.getDate()).getTime());
    expect(range.toMs).toBe(new Date(2026, 9, 1).getTime());
  });

  it("covers a future month end to end", () => {
    const range = monthEventRange("2026-11", now)!;
    expect(range.fromMs).toBe(new Date(2026, 10, 1).getTime());
    expect(range.toMs).toBe(new Date(2026, 11, 1).getTime());
  });
});

describe("calendarState", () => {
  it("separates a link from a write-back that actually happened", () => {
    // A report can point at an event whose notes were never updated; calling
    // both of those "synced" is how a silently failing write-back hides.
    expect(calendarState({})).toBe("none");
    expect(calendarState({ calendarEventId: "e1" })).toBe("linked");
    expect(
      calendarState({ calendarEventId: "e1", calendarSyncedAt: "2026-09-15T10:00:00Z" }),
    ).toBe("synced");
  });

  it("lets an error outrank everything else", () => {
    expect(
      calendarState({
        calendarEventId: "e1",
        calendarSyncedAt: "2026-09-15T10:00:00Z",
        calendarError: "Der Termin gehört jemand anderem.",
      }),
    ).toBe("error");
  });
});

describe("dayHeading", () => {
  const now = new Date(2026, 8, 14, 10);
  it("names the days a person would name", () => {
    const today = `2026-09-${String(now.getDate()).padStart(2, "0")}`;
    expect(dayHeading(today, now)).toBe("Heute");
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    expect(
      dayHeading(
        `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`,
        now,
      ),
    ).toBe("Morgen");
    expect(dayHeading("2026-12-24", now)).toContain("24");
  });
});

describe("matchesQuery", () => {
  it("searches the transcript and the extracted items, not just the title", () => {
    const r = summarise(
      report({ transcription: "Wir brauchen ein Budget", todos: [{ text: "Angebot einholen" }] }),
    );
    expect(matchesQuery(r, "budget")).toBe(true);
    expect(matchesQuery(r, "angebot")).toBe(true);
    expect(matchesQuery(r, "urlaub")).toBe(false);
  });
  it("finds a meeting by who spoke in it", () => {
    const r = summarise(
      report({
        speech: {
          provider: "assemblyai",
          phase: "final",
          languages: ["de"],
          turns: [turn("1", "mic:1", 10), turn("2", "system:2", 20)],
          speakerNames: { "mic:1": "Alexander", "system:2": "Beate" },
        },
      }),
    );
    expect(matchesQuery(r, "beate")).toBe(true);
    expect(matchesQuery(r, "clara")).toBe(false);
  });
  it("matches everything without a query", () => {
    expect(matchesQuery(summarise(report()), "")).toBe(true);
  });
});

describe("searchSnippet", () => {
  it("returns the hit split for highlighting, with the original casing", () => {
    const r = summarise(report({ transcription: "Am Montag besprechen wir das Budget für Q4." }));
    const snippet = searchSnippet(r, "budget")!;
    expect(snippet.match).toBe("Budget");
    expect(snippet.before.endsWith("wir das ")).toBe(true);
    expect(`${snippet.before}${snippet.match}${snippet.after}`).toContain("Q4");
  });
  it("elides both ends of a long transcript", () => {
    const r = summarise(report({ transcription: `${"a".repeat(200)} Budget ${"b".repeat(200)}` }));
    const snippet = searchSnippet(r, "budget")!;
    expect(snippet.before.startsWith("… ")).toBe(true);
    expect(snippet.after.endsWith(" …")).toBe(true);
  });
  it("is null when the hit is only in the title, so the caller can say so", () => {
    expect(searchSnippet(summarise(report({ title: "Budget" })), "budget")).toBe(null);
  });
});

describe("monthKeyOf", () => {
  it("agrees with localDayKey", () => {
    const at = new Date(2026, 8, 14, 22).toISOString();
    expect(monthKeyOf(at)).toBe(localDayKey(at).slice(0, 7));
  });
});

describe("isMonthKey", () => {
  it("accepts a real month and rejects anything else from the URL", () => {
    expect(isMonthKey("2026-09")).toBe(true);
    expect(isMonthKey("2026-12")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-00")).toBe(false);
    expect(isMonthKey("2026-9")).toBe(false);
    expect(isMonthKey("nein")).toBe(false);
    expect(isMonthKey(null)).toBe(false);
  });
});

describe("dayKeyLabel", () => {
  it("names the day the key means, not a UTC re-parse of it", () => {
    // new Date("2026-09-14") is UTC midnight, which is 13 September west of UTC.
    expect(dayKeyLabel("2026-09-14")).toContain("14.");
    expect(dayKeyLabel("2026-01-01")).toContain("2026");
    expect(dayKeyLabel("2026-09-14", { weekday: "long" })).toBe("Montag");
  });
  it("agrees with localDayKey for any timestamp", () => {
    const at = new Date(2026, 8, 14, 23, 30).toISOString();
    expect(dayKeyLabel(localDayKey(at), { day: "numeric" })).toBe("14");
  });
  it("degrades rather than printing Invalid Date", () => {
    expect(dayKeyLabel("")).toBe("Ohne Datum");
    expect(dayKeyLabel("kaputt")).toBe("Ohne Datum");
  });
});

describe("plural", () => {
  it("uses the singular for exactly one", () => {
    expect(plural(1, "Bericht", "Berichte")).toBe("1 Bericht");
    expect(plural(0, "Bericht", "Berichte")).toBe("0 Berichte");
    expect(plural(7, "Bericht", "Berichte")).toBe("7 Berichte");
  });
});

describe("summarise", () => {
  const speech = {
    provider: "assemblyai" as const,
    phase: "final" as const,
    languages: ["de"],
    speakerReview: "pending" as const,
    turns: [turn("1", "mic:1", 90_000), turn("2", "system:2", 40_000)],
    speakerNames: { "mic:1": "Alexander" },
  };

  it("drops the transcript turns, which are the heavy part of a report", () => {
    const projected = summarise(report({ speech })) as unknown as Record<string, unknown>;
    expect(projected.speech).toBeUndefined();
    expect(projected.turns).toBeUndefined();
  });
  it("resolves everything the list renders so no caller needs the turns", () => {
    expect(summarise(report({ speech, todos: [{ text: "a" }, { text: "b", done: true }], takeaways: ["c"] }))).toMatchObject({
      durationMs: 90_000,
      todoCount: 2,
      openTodoCount: 1,
      takeawayCount: 1,
      needsReview: true,
      status: "pending",
    });
  });
  it("keeps the transcript and the extracted items searchable", () => {
    const projected = summarise(
      report({ transcription: "Budget", todos: [{ text: "Angebot" }], takeaways: ["Risiko"] }),
    );
    expect(projected.transcription).toBe("Budget");
    expect(projected.items).toContain("Angebot");
    expect(projected.items).toContain("Risiko");
  });
});

describe("speakerNamesOf", () => {
  it("resolves display names once per voice and skips unassigned audio", () => {
    const names = speakerNamesOf({
      provider: "assemblyai",
      phase: "final",
      languages: ["de"],
      turns: [
        turn("1", "mic:1", 10),
        turn("2", "mic:1", 20),
        turn("3", "system:2", 30),
        turn("4", "system:unknown", 40),
      ],
      speakerNames: { "mic:1": "Alexander" },
    });
    expect(names).toContain("Alexander");
    expect(names).not.toContain("Unbekannt");
    expect(names.filter((n) => n === "Alexander")).toHaveLength(1);
  });
  it("is empty without a structured transcript", () => {
    expect(speakerNamesOf(undefined)).toEqual([]);
  });
});

describe("knownSpeakers", () => {
  const withSpeakers = (...names: string[]) =>
    ({ speakers: names }) as ReturnType<typeof summarise>;

  it("collects the people you have actually named, across meetings", () => {
    expect(
      knownSpeakers([withSpeakers("Alexander", "Beate"), withSpeakers("Beate", "Clara")]),
    ).toEqual(["Alexander", "Beate", "Clara"]);
  });
  it("leaves out the placeholders, which are not people", () => {
    expect(knownSpeakers([withSpeakers("Sprecher 1", "Sprecher 12", "Unbekannt", "Anna")])).toEqual(
      ["Anna"],
    );
  });
});

describe("summarise for a report whose transcript is elsewhere", () => {
  const base = {
    id: "r1",
    date: "2026-09-15T12:00:00.000Z",
    title: "Weekly Sync",
    summary: "Roadmap besprochen.",
    transcription: "",
    todos: [],
    takeaways: [],
  };

  it("reads the participants resolved before the projection", () => {
    const result = summarise({
      ...base,
      participants: ["Alex", "Sergio"],
      speakerReviewPending: true,
      transcriptChars: 42,
    } as never);

    expect(result.speakers).toEqual(["Alex", "Sergio"]);
    expect(result.needsReview).toBe(true);
    expect(result.transcriptLocal).toBe(false);
  });

  it("still prefers the real transcript when this device has it", () => {
    const result = summarise({
      ...base,
      transcription: "Alles Gesagte",
      participants: ["Veraltet"],
      speech: {
        provider: "assemblyai",
        phase: "final",
        languages: ["de"],
        speakerNames: { "mic:0:A": "Alex" },
        turns: [
          { id: "mic:0:0", speaker: "mic:0:A", text: "Hallo", startMs: 0, endMs: 1000, final: true },
        ],
      },
    } as never);

    expect(result.speakers).toEqual(["Alex"]);
    expect(result.transcriptLocal).toBe(true);
  });
});
