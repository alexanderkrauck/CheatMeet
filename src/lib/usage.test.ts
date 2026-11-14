import { describe, expect, it } from "vitest";
import { aggregateUsage, usageRange, viennaDay } from "./usage";
import { summarise } from "./meetingMeta";
import type { ReportData } from "../types";

const meeting = (id: string, fields: Partial<ReportData> = {}) => summarise({
  id, date: "2026-03-29T10:00:00Z", title: "Fixture", summary: "", transcription: "",
  todos: [], takeaways: [], ...fields,
});

describe("account meeting activity", () => {
  it("deduplicates each storage namespace, excludes invalid dates, and respects exclusive range ends", () => {
    const google = meeting("same", { durationMs: 60_000, updatedAt: "2026-03-30T10:00:00Z" });
    const microsoft = meeting("same", { durationMs: 120_000, home: {
      provider: "microsoft", connectionId: "own", driveId: "drive", rootId: "root", rootName: "Archive",
    } });
    const activity = aggregateUsage([
      google, microsoft, google, microsoft,
      meeting("same", { durationMs: 900_000, updatedAt: "2026-03-29T10:00:00Z" }),
      meeting("invalid", { date: "invalid" }), meeting("invalid", { date: "invalid" }),
      meeting("next", { date: "2026-03-29T22:00:00Z" }),
      meeting("previous", { date: "2026-03-28T22:59:59Z" }),
    ], usageRange("day", "2026-03-29"));
    expect(activity).toMatchObject({ meetings: 2, durationMs: 180_000, excludedInvalidDates: 1 });
    expect(activity.days.map((day) => [day.key, day.meetings])).toEqual([["2026-03-29", 2]]);
  });
  it("keeps unknown durations separate and counts stored summary text, not status or AI calls", () => {
    const range = usageRange("day", "2026-03-29");
    const activity = aggregateUsage([
      meeting("known", { durationMs: 60_000, summary: "Saved", status: "pending" }),
      meeting("import", { durationMs: 0, status: "completed" }),
      meeting("missing", { summary: "   " }),
      meeting("negative", { durationMs: -100 }),
      meeting("nan", { durationMs: NaN }),
      meeting("infinite", { durationMs: Infinity }),
    ], range);
    expect(activity).toMatchObject({ meetings: 6, knownDurationCount: 1, durationMs: 60_000, summaries: 1 });
    expect(activity.days[0]).toMatchObject({ meetings: 6, knownDurationCount: 1, durationMs: 60_000 });
    expect(aggregateUsage([meeting("unknown")], range).durationMs).toBeNull();
    expect(aggregateUsage([], range).durationMs).toBeNull();
  });
  it("navigates whole Monday-first weeks and months across leap days and year boundaries", () => {
    expect(usageRange("week", "2027-01-03")).toMatchObject({ start: "2026-12-28", end: "2027-01-04" });
    expect(usageRange("week", "2027-01-03", 1).start).toBe("2027-01-04");
    expect(usageRange("week", "2026-03-29").days).toHaveLength(7);
    expect(usageRange("day", "2026-03-29", 1)).toMatchObject({ start: "2026-03-30", end: "2026-03-31" });
    expect(usageRange("month", "2024-03-31", -1)).toMatchObject({ start: "2024-02-01", end: "2024-03-01" });
    expect(usageRange("month", "2024-03-31", -1).days).toHaveLength(29);
    expect(usageRange("month", "2026-12-31", 1).start).toBe("2027-01-01");
  });
  it("assigns Vienna calendar days at both DST transitions, not fixed 24-hour buckets", () => {
    expect(viennaDay("2026-03-28T22:59:59Z")).toBe("2026-03-28");
    expect(viennaDay("2026-03-28T23:00:00Z")).toBe("2026-03-29");
    expect(viennaDay("2026-03-29T21:59:59Z")).toBe("2026-03-29");
    expect(viennaDay("2026-03-29T22:00:00Z")).toBe("2026-03-30");
    expect(viennaDay("2026-10-24T22:00:00Z")).toBe("2026-10-25");
    expect(viennaDay("2026-10-25T22:59:59Z")).toBe("2026-10-25");
    expect(viennaDay("2026-10-25T23:00:00Z")).toBe("2026-10-26");
    expect(viennaDay("2026-10-25")).toBe("2026-10-25");
    expect(viennaDay("2026-02-30")).toBeNull();
    expect(viennaDay("invalid")).toBeNull();
  });
});
