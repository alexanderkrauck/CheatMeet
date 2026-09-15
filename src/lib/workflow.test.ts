import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConsentRecord, consentFacts } from "../../shared/consent";
import type { Draft, ReportData } from "../types";

const calls: string[] = [];
let audioFails = false;
/** The JSON actually published to Drive, so the contract can be asserted. */
let archived: Record<string, unknown> | undefined;
let indexed: Record<string, unknown> | undefined;
let storedReports: ReportData[] = [];
let existingIndexId: string | undefined;

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
  listLocal: async () => [{ report: storedReports[0], dirty: false }],
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
    blob: Blob,
    name: string,
    _mime: string,
    parent: string,
    _token: string,
    existingId?: string,
  ) => {
    if (name.startsWith("aufnahme") && audioFails)
      throw new Error("Upload fehlgeschlagen");
    if (name === "bericht_daten.json") archived = JSON.parse(await blob.text());
    if (name === "index.json") indexed = JSON.parse(await blob.text());
    calls.push(`upload:${name}:${parent}:${existingId ?? "new"}`);
    return `${name}-id`;
  },
  downloadDriveFile: async () => new Blob(["x"]),
  findFileInFolder: async (name: string) =>
    name === "index.json" ? existingIndexId : undefined,
}));
vi.mock("./prepareTranscript", () => ({ prepareTranscript: async () => {} }));

const { backupDraft, syncReport } = await import("./workflow");
const { forgetArchiveIndexIds } = await import("./archiveDrive");

const consent = buildConsentRecord(
  consentFacts({
    sources: ["mic"],
    folderName: "Ordner",
    retention: { audioDays: 30, textDays: null },
  }),
  { obtainedAt: "2026-09-15T12:00:00.000Z", method: "spoken", participants: [{ name: "Sergio", stance: "agreed" as const }] },
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
  archived = undefined;
  indexed = undefined;
  existingIndexId = undefined;
  storedReports = [report({ driveFolderId: "folder-id", driveReportId: "json" })];
  forgetArchiveIndexIds();
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
    expect(names.slice(0, 4)).toEqual([
      "einwilligung.md",
      "zusammenfassung.md",
      "transkript.md",
      "bericht_daten.json",
    ]);
  });

  it("publishes the agreed contract, not the app's own report shape", async () => {
    await syncReport(report({ rawAudioUrl: "audio-id" }), "token");

    const document = archived!;
    expect(document.archive).toMatchObject({ version: 1, generator: "cheatmeet" });
    for (const internal of [
      "status",
      "error",
      "captureState",
      "driveFolderId",
      "driveReportId",
    ])
      expect(document, internal).not.toHaveProperty(internal);
    expect(document.consent).toBeTruthy();
    expect(document.rawAudioUrl).toBe("audio-id");
  });

  it("still syncs a meeting that has no consent record", async () => {
    await syncReport(report({ consent: undefined }), "token");

    expect(uploads().map((call) => call.split(":")[1]).slice(0, 3)).toEqual([
      "zusammenfassung.md",
      "transkript.md",
      "bericht_daten.json",
    ]);
  });
});

describe("the archive overview", () => {
  it("writes an index and a schema note beside the meetings", async () => {
    await syncReport(report({ driveFolderId: "folder-id" }), "token");

    const names = uploads().map((call) => call.split(":")[1]);
    expect(names).toContain("index.json");
    expect(names).toContain("SCHEMA.md");
    // At the archive root, not inside one meeting's folder.
    expect(uploads().find((call) => call.includes("index.json"))).toContain(
      ":root:",
    );
    expect(indexed!.schema).toBe("cheatmeet.index/1");
    // It says plainly that it is derived, so a reader knows to fall back.
    expect(indexed!.derived).toBe(true);
    const meetings = indexed!.meetings as Record<string, unknown>[];
    expect(meetings[0].id).toBe("r1");
    expect(meetings[0].consent_obtained_at).toBe("2026-09-15T12:00:00.000Z");
  });

  it("replaces the overview instead of piling up copies", async () => {
    existingIndexId = "vorhandene-index-id";

    await syncReport(report({ driveFolderId: "folder-id" }), "token");

    expect(uploads().find((call) => call.includes("index.json"))).toContain(
      ":vorhandene-index-id",
    );
  });

  it("saves the meeting even when the overview cannot be written", async () => {
    const settings = await import("./driveSettings");
    vi.spyOn(settings, "getRootFolder").mockRejectedValue(
      new Error("Drive nicht erreichbar"),
    );

    await expect(
      syncReport(report({ driveFolderId: "folder-id" }), "token"),
    ).resolves.toBeTruthy();

    // The per-meeting files are the source of truth and were written.
    expect(uploads().map((call) => call.split(":")[1])).toContain(
      "bericht_daten.json",
    );
    vi.mocked(settings.getRootFolder).mockRestore();
  });
});
