import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConsentRecord, consentFacts } from "../../shared/consent";
import type { Draft, ReportData } from "../types";

const calls: string[] = [];
let audioFails = false;

vi.mock("./firebase", () => ({
  auth: { currentUser: { uid: "u1" } },
  db: {},
}));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  getDoc: async () => ({ exists: () => false, data: () => ({}) }),
}));
vi.mock("./reports", () => ({
  uid: () => "u1",
  saveReport: async () => null,
}));
vi.mock("./local", () => ({
  putDraft: async (_u: string, draft: Draft) =>
    void calls.push(`putDraft:${draft.report.driveConsentId || "-"}`),
  putLocal: async (_u: string, report: ReportData) =>
    void calls.push(`putLocal:${report.driveConsentId || "-"}`),
}));
vi.mock("./driveSettings", () => ({ getRootFolder: async () => "root" }));
vi.mock("./webmDuration", () => ({ withWebmDuration: async (blob: Blob) => blob }));
vi.mock("./drive", () => ({
  createSubFolder: async (name: string) => {
    calls.push(`folder:${name}`);
    return "folder-id";
  },
  uploadFileToFolder: async (
    _blob: Blob,
    name: string,
    _mime: string,
    parent: string,
    _token: string,
    existingId?: string,
  ) => {
    if (name.startsWith("aufnahme") && audioFails)
      throw new Error("Upload fehlgeschlagen");
    calls.push(`upload:${name}:${parent}:${existingId ?? "new"}`);
    return `${name}-id`;
  },
  downloadDriveFile: async () => new Blob(["x"]),
}));
vi.mock("./prepareTranscript", () => ({ prepareTranscript: async () => {} }));

const { backupDraft, syncReport } = await import("./workflow");

const consent = buildConsentRecord(
  consentFacts({
    sources: ["mic"],
    folderName: "Ordner",
    retention: { audioDays: 30, textDays: null },
  }),
  { obtainedAt: "2026-09-15T12:00:00.000Z", method: "spoken", allInformed: true },
);

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: "2026-09-15T12:00:00.000Z",
  title: "Meeting",
  summary: "Zusammenfassung",
  transcription: "Gesagtes",
  todos: [],
  takeaways: [],
  consent,
  ...over,
});

const draft = (over: Partial<ReportData> = {}): Draft => ({
  report: report(over),
  audio: new Blob(["audio"], { type: "audio/webm" }),
});

const uploads = () => calls.filter((call) => call.startsWith("upload:"));

beforeEach(() => {
  calls.length = 0;
  audioFails = false;
});

describe("backupDraft", () => {
  it("writes the permission before the recording it covers", async () => {
    await backupDraft(draft(), "token", () => {});

    const names = uploads().map((call) => call.split(":")[1]);
    expect(names[0]).toBe("einwilligung.md");
    expect(names[1]).toMatch(/^aufnahme\./);
    // No existingId: an accidental second write must be a visible duplicate,
    // never a silent overwrite of evidence.
    expect(uploads()[0]).toBe("upload:einwilligung.md:folder-id:new");
  });

  it("checkpoints the consent file before risking the audio upload", async () => {
    audioFails = true;
    const pending = draft();

    await expect(backupDraft(pending, "token", () => {})).rejects.toThrow(
      /Upload fehlgeschlagen/,
    );

    // The id reached both stores, so a retry resumes instead of duplicating.
    expect(calls).toContain("putDraft:einwilligung.md-id");
    expect(calls).toContain("putLocal:einwilligung.md-id");
    expect(pending.report.driveConsentId).toBe("einwilligung.md-id");
  });

  it("uploads the permission exactly once across retries", async () => {
    const pending = draft();
    await backupDraft(pending, "token", () => {});
    calls.length = 0;

    await backupDraft(pending, "token", () => {});

    expect(uploads().some((call) => call.includes("einwilligung.md"))).toBe(
      false,
    );
  });

  it("leaves a meeting recorded before consent existed alone", async () => {
    await backupDraft(draft({ consent: undefined }), "token", () => {});

    expect(uploads().some((call) => call.includes("einwilligung.md"))).toBe(
      false,
    );
    expect(uploads().some((call) => call.includes("aufnahme."))).toBe(true);
  });
});

describe("syncReport", () => {
  it("writes the permission for a report that never went through a backup", async () => {
    // Saving from the report page reaches syncReport directly.
    await syncReport(report(), "token");

    const names = uploads().map((call) => call.split(":")[1]);
    expect(names).toEqual([
      "einwilligung.md",
      "zusammenfassung.md",
      "transkript.md",
      "bericht_daten.json",
    ]);
  });

  it("still syncs a meeting that has no consent record", async () => {
    await syncReport(report({ consent: undefined }), "token");

    expect(uploads().map((call) => call.split(":")[1])).toEqual([
      "zusammenfassung.md",
      "transkript.md",
      "bericht_daten.json",
    ]);
  });
});
