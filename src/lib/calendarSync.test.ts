import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

let grant = true;
const calls: string[] = [];
let existing: { description: string; htmlLink?: string } | null = {
  description: "Agenda",
};

vi.mock("./session", () => ({ hasCalendarGrant: () => grant }));
class FakeCalendarError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
let getFails: FakeCalendarError | null = null;

vi.mock("./calendar", () => ({
  CalendarError: FakeCalendarError,
  isEventGone: (e: unknown) =>
    e instanceof FakeCalendarError && (e.status === 404 || e.status === 410),
  getEvent: async (calendarId: string, id: string) => {
    calls.push(`get:${calendarId}/${id}`);
    if (getFails) throw getFails;
    return existing && { ...existing, id, calendarId };
  },
  updateEventDescription: async (e: { id: string }, block: string) => {
    calls.push(`patch:${e.id}:${block.slice(0, 20)}`);
  },
  createEvent: async ({ title }: { title: string }) => {
    calls.push(`create:${title}`);
    return { id: "new-1", calendarId: "primary", htmlLink: "https://cal/new-1" };
  },
  summaryBlock: ({ summary }: { summary: string }) => summary,
}));

const { syncReportToCalendar } = await import("./calendarSync");

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1", date: "2026-09-14T08:00:00.000Z", title: "Weekly",
  summary: "Roadmap.", transcription: "", todos: [], takeaways: [], ...over,
});

beforeEach(() => {
  calls.length = 0;
  grant = true;
  getFails = null;
  existing = { description: "Agenda" };
});

describe("syncReportToCalendar", () => {
  it("reads the event before patching, so the organiser's text survives", async () => {
    const patch = await syncReportToCalendar(
      report({ calendarEventId: "e1", calendarId: "primary" }),
    );
    expect(calls[0]).toBe("get:primary/e1");
    expect(calls[1]).toContain("patch:e1");
    expect(patch.calendarSyncedAt).toBeTruthy();
  });

  it("creates an event for a meeting that belonged to none", async () => {
    const patch = await syncReportToCalendar(report());
    expect(calls).toEqual(["create:Weekly"]);
    expect(patch).toMatchObject({ calendarEventId: "new-1", calendarId: "primary" });
  });

  it("never creates one on the automatic path", async () => {
    const patch = await syncReportToCalendar(report(), { create: false });
    expect(calls).toEqual([]);
    expect(patch.calendarEventId).toBeUndefined();
    expect(patch.calendarError).toContain("kein Termin");
  });

  it("clears the link when the event is gone, so the message is true", async () => {
    existing = null;
    const patch = await syncReportToCalendar(
      report({ calendarEventId: "e1", calendarId: "primary", calendarSyncedAt: "x" }),
    );
    expect(patch).toMatchObject({
      calendarEventId: undefined,
      calendarId: undefined,
      calendarSyncedAt: undefined,
    });
    expect(patch.calendarError).toContain("existiert nicht mehr");
  });

  it("keeps the link when the lookup merely failed", async () => {
    // A throttle, a timeout or an expired token must not be read as "deleted".
    getFails = new FakeCalendarError("ausgelastet", 403);
    await expect(
      syncReportToCalendar(
        report({ calendarEventId: "e1", calendarId: "primary" }),
      ),
    ).rejects.toThrow("ausgelastet");
    expect(calls).toEqual(["get:primary/e1"]);
  });

  it("clears the link only when the event is really gone", async () => {
    getFails = new FakeCalendarError("existiert nicht mehr", 404);
    const patch = await syncReportToCalendar(
      report({ calendarEventId: "e1", calendarId: "primary" }),
    );
    expect(patch.calendarEventId).toBeUndefined();
    expect(patch.calendarError).toContain("existiert nicht mehr");
  });

  it("refuses without a calendar grant rather than half-working", async () => {
    grant = false;
    await expect(syncReportToCalendar(report())).rejects.toThrow("nicht freigegeben");
  });
});
