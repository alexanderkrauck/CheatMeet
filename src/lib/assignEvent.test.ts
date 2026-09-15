import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

const state = {
  stored: undefined as { report: ReportData } | undefined,
  /** What a second read returns, when a concurrent write changed it. */
  freshest: undefined as { report: ReportData } | undefined,
  granted: true,
  saveWarning: "",
  syncPatch: {} as Partial<ReportData>,
  syncThrows: null as Error | null,
  signedIn: "u1",
};
const saved: ReportData[] = [];
const synced: { report: ReportData; create?: boolean }[] = [];

vi.mock("./local", () => ({
  getLocal: async () => state.freshest ?? state.stored,
}));
vi.mock("./reports", () => ({
  saveReport: async (report: ReportData) => {
    saved.push(report);
    return state.saveWarning;
  },
  uid: () => state.signedIn,
}));
vi.mock("./calendarSync", () => ({
  syncReportToCalendar: async (
    report: ReportData,
    options: { create?: boolean },
  ) => {
    synced.push({ report, create: options?.create });
    if (state.syncThrows) throw state.syncThrows;
    return state.syncPatch;
  },
}));
vi.mock("./session", () => ({
  hasCalendarGrant: () => state.granted,
  errorMessage: (cause: unknown) => (cause as Error).message,
}));

const { assignReportToEvent } = await import("./assignEvent");

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: "2026-09-15T07:31:00.000Z",
  title: "Erstgespräch",
  summary: "Maik und Alexander besprechen …",
  transcription: "lange abschrift",
  todos: [],
  takeaways: [],
  ...over,
});

const event = {
  id: "ev-you-two",
  calendarId: "primary",
  htmlLink: "https://calendar.google.com/event?eid=x",
};

beforeEach(() => {
  saved.length = 0;
  synced.length = 0;
  state.stored = { report: report() };
  state.freshest = undefined;
  state.signedIn = "u1";
  state.granted = true;
  state.saveWarning = "";
  state.syncPatch = { calendarSyncedAt: "2026-09-15T12:00:00.000Z" };
  state.syncThrows = null;
});

describe("assignReportToEvent", () => {
  it("links the stored report to the event and saves it once", async () => {
    const outcome = await assignReportToEvent("u1", "r1", event);
    expect(outcome).toEqual({ assigned: true, warnings: [] });
    expect(saved).toHaveLength(1);
    expect(saved[0].calendarEventId).toBe("ev-you-two");
    expect(saved[0].calendarId).toBe("primary");
    expect(saved[0].calendarLink).toBe(event.htmlLink);
  });

  it("saves the stored report, never the row projection", async () => {
    // Re-saving a summary would write the transcript out of existence.
    await assignReportToEvent("u1", "r1", event);
    expect(saved[0].transcription).toBe("lange abschrift");
  });

  it("writes the summary back before saving, so one write carries both", async () => {
    await assignReportToEvent("u1", "r1", event);
    expect(synced).toHaveLength(1);
    // The link must already be on the report the sync sees, or it would have
    // nothing to update.
    expect(synced[0].report.calendarEventId).toBe("ev-you-two");
    expect(saved[0].calendarSyncedAt).toBe("2026-09-15T12:00:00.000Z");
  });

  it("never creates a second event next to the one being assigned", async () => {
    await assignReportToEvent("u1", "r1", event);
    expect(synced[0].create).toBe(false);
  });

  it("skips the write-back when it was not asked for", async () => {
    const outcome = await assignReportToEvent("u1", "r1", event, {
      writeBack: false,
    });
    expect(synced).toHaveLength(0);
    expect(outcome.assigned).toBe(true);
    expect(saved[0].calendarEventId).toBe("ev-you-two");
  });

  it("links without a grant, but says the notes were not written", async () => {
    state.granted = false;
    const outcome = await assignReportToEvent("u1", "r1", event);
    expect(synced).toHaveLength(0);
    expect(outcome.assigned).toBe(true);
    expect(saved[0].calendarEventId).toBe("ev-you-two");
    // Silently dropping half of what was asked for is how a feature looks done
    // and is not.
    expect(outcome.warnings[0]).toContain("nicht freigegeben");
  });

  it("refuses when the target event has vanished, instead of saving a cleared link", async () => {
    // syncReportToCalendar signals a deleted event by RETURNING a patch that
    // clears the link. Spreading that would persist an error about a link that
    // never existed and call it a success.
    state.syncPatch = {
      calendarEventId: undefined,
      calendarId: undefined,
      calendarLink: undefined,
      calendarSyncedAt: undefined,
      calendarError: "Der verknüpfte Kalendereintrag existiert nicht mehr.",
    };
    const outcome = await assignReportToEvent("u1", "r1", event);
    expect(outcome.assigned).toBe(false);
    expect(saved).toHaveLength(0);
    expect(outcome.warnings[0]).toContain("existiert nicht mehr");
  });

  it("writes nothing when the account changed while the calendar was called", async () => {
    state.syncPatch = {};
    synced.length = 0;
    const promise = assignReportToEvent("u1", "r1", event);
    state.signedIn = "u2";
    const outcome = await promise;
    expect(outcome.assigned).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it("applies the link to the newest stored copy, not the one read first", async () => {
    // The calendar call can take 30s. Writing back the pre-call snapshot would
    // undo a speaker rename or a ticked to-do saved in the meantime.
    state.freshest = { report: report({ title: "Umbenannt" }) };
    await assignReportToEvent("u1", "r1", event);
    expect(saved[0].title).toBe("Umbenannt");
    expect(saved[0].calendarEventId).toBe("ev-you-two");
  });

  it("keeps the link when the calendar refuses the notes", async () => {
    // A refused write-back is a warning: the assignment is still worth having,
    // and the report page can push the notes later.
    state.syncThrows = new Error("Google Kalender ist gerade ausgelastet.");
    const outcome = await assignReportToEvent("u1", "r1", event);
    expect(outcome.assigned).toBe(true);
    expect(outcome.warnings[0]).toContain("Google Kalender ist gerade ausgelastet.");
    expect(saved[0].calendarEventId).toBe("ev-you-two");
  });

  it("surfaces a calendar error reported in the patch rather than thrown", async () => {
    state.syncPatch = { calendarError: "Der Termin gehört jemand anderem." };
    const outcome = await assignReportToEvent("u1", "r1", event);
    expect(outcome.warnings).toEqual(["Der Termin gehört jemand anderem."]);
  });

  it("reports a failed cloud save as a warning, not as success", async () => {
    state.saveWarning = "Nur lokal gespeichert.";
    const outcome = await assignReportToEvent("u1", "r1", event);
    expect(outcome).toEqual({
      assigned: true,
      warnings: ["Nur lokal gespeichert."],
    });
  });

  it("writes nothing when the report is not on this device", async () => {
    state.stored = undefined;
    const outcome = await assignReportToEvent("u1", "r1", event);
    expect(outcome.assigned).toBe(false);
    expect(saved).toHaveLength(0);
    expect(synced).toHaveLength(0);
  });

  it("clears a stale calendar error from an earlier attempt", async () => {
    state.stored = { report: report({ calendarError: "alter Fehler" }) };
    await assignReportToEvent("u1", "r1", event, { writeBack: false });
    expect(saved[0].calendarError).toBeUndefined();
  });
});
