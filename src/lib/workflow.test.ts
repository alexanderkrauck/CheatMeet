import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConsentRecord, consentFacts } from "../../shared/consent";
import type { Draft, ReportData } from "../types";

const microsoftSync = vi.hoisted(() => vi.fn());
const microsoftBackup = vi.hoisted(() => vi.fn());
vi.mock("./microsoftWorkflow", () => ({ syncMicrosoftReport: microsoftSync, backupMicrosoftDraft: microsoftBackup }));
const calls: string[] = [];
let audioFails = false;
/** The JSON actually published to Drive, so the contract can be asserted. */
let archived: Record<string, unknown> | undefined;
let indexed: Record<string, unknown> | undefined;
let storedReports: ReportData[] = [];
let existingIndexId: string | undefined;
let localReport: ReportData | undefined;
let duringUpload: ((name: string) => Promise<void>) | undefined;
class ReportConflictError extends Error {
  constructor() { super("Neuere Fassung laden"); this.name = "ReportConflictError"; }
}

vi.mock("./firebase", () => ({
  auth: { currentUser: { uid: "u1", getIdToken: async () => "fixture-identity" } },
  db: {},
}));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  getDoc: async () => ({ exists: () => false, data: () => ({}) }),
}));
vi.mock("./reports", () => ({
  uid: () => "u1",
  saveReport: async (report: ReportData, options?: { expectedUpdatedAt?: string | null }) => {
    if (options?.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== (localReport?.updatedAt ?? null)) throw new ReportConflictError();
    localReport = { ...structuredClone(report), updatedAt: new Date(Date.parse(report.updatedAt!) + 1).toISOString() };
    return null;
  },
}));
vi.mock("./local", () => ({
  ReportConflictError,
  getLocal: async () => localReport ? { report: localReport, dirty: false } : undefined,
  listLocal: async () => [{ report: storedReports[0], dirty: false }],
  putDraft: async (_u: string, draft: Draft) =>
    void calls.push(`putDraft:${draft.report.driveConsentId || "-"}`),
  putLocal: async (_u: string, report: ReportData, _dirty = true, expected?: string | null) => {
    if (expected !== undefined && (localReport?.updatedAt ?? null) !== expected)
      throw new ReportConflictError();
    localReport = structuredClone(report);
    calls.push(`putLocal:${report.driveConsentId || "-"}`);
  },
}));
vi.mock("./driveSettings", () => ({ getRootFolder: async () => "root" }));
vi.mock("./webmDuration", () => ({ withWebmDuration: async (blob: Blob) => blob }));
vi.mock("./drive", () => ({
  readDriveArchiveRevision: async () => '"v1"',
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
    await duringUpload?.(name);
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

const { analyzeDraft, backupDraft, syncReport } = await import("./workflow");
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
  localReport = undefined;
  duringUpload = undefined;
  storedReports = [report({ driveFolderId: "folder-id", driveReportId: "json" })];
  forgetArchiveIndexIds();
});

it.each([true, false])("keeps calendar success only for unchanged regenerated notes: changed=%s", async changed => {
  const pending = draft({ calendarEventId: "event", calendarId: "calendar", calendarSyncedAt: "previous-success" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    title: "Neuer Titel", summary: changed ? "Neue Zusammenfassung" : pending.report.summary,
    transcription: pending.report.transcription, todos: [], takeaways: [],
  })));
  try {
    const result = await analyzeDraft(pending);
    expect(result.calendarEventId).toBe("event");
    expect(result.calendarSyncedAt).toBe(changed ? undefined : "previous-success");
  } finally { vi.unstubAllGlobals(); }
});

describe("backupDraft", () => {
  it("forwards an explicit observed revision to the pinned Microsoft backup", async () => {
    const pending = draft({ home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Archive" } });
    const progress = vi.fn();
    await backupDraft(pending, "unused", progress, null);
    expect(microsoftBackup).toHaveBeenCalledWith(pending, progress, null);
  });
  it("rejects an upload checkpoint after a newer human revision", async () => {
    const pending = draft({ updatedAt: "2026-11-01T00:00:00.000Z", driveFolderId: "folder-id", driveConsentId: "consent" });
    localReport = structuredClone(pending.report);
    const newer = { ...pending.report, title: "Neue menschliche Fassung", updatedAt: "2026-11-02T00:00:00.000Z" };
    duringUpload = async () => { localReport = structuredClone(newer); };
    await expect(backupDraft(pending, "token", () => {})).rejects.toMatchObject({ name: "ReportConflictError" });
    expect(localReport).toEqual(newer);
  });
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
  it("confirms the final Microsoft durable revision instead of the adapter checkpoint", async () => {
    const input = report({ updatedAt: "2026-11-01T00:00:00.000Z", home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } });
    microsoftSync.mockImplementationOnce(async () => {
      localReport = { ...input, updatedAt: "2026-11-01T00:00:00.001Z" };
      return { report: input, warning: null };
    });
    const result = await syncReport(input, "microsoft-token");
    expect(result.report.updatedAt).toBe(localReport?.updatedAt);
    expect(uploads()).toEqual([]);
  });
  it("returns the confirmed durable revision advanced by the final cloud-index save", async () => {
    const result = await syncReport(report(), "token");
    expect(result.report.updatedAt).toBe(localReport?.updatedAt);
  });
  it.each(["entry", "upload"])("preserves a later local revision at %s without publishing stale JSON", async (when) => {
    const input = report({ updatedAt: "2026-11-01T00:00:00.000Z", driveFolderId: "folder-id", driveConsentId: "consent" });
    const newer = { ...input, title: "Neuere Bearbeitung", updatedAt: "2026-11-02T00:00:00.000Z" };
    localReport = structuredClone(when === "entry" ? newer : input);
    duringUpload = async (name) => {
      if (name === "zusammenfassung.md") localReport = structuredClone(newer);
    };
    await expect(syncReport(input, "token")).rejects.toMatchObject({ name: "ReportConflictError" });
    expect(localReport).toEqual(newer);
    expect(archived).toBeUndefined();
    if (when === "entry") expect(uploads()).toEqual([]);
  });
  it("refuses an old caller snapshot after the latest local content was invalidated", async () => {
    localReport = report({ transcriptStale: true });
    await expect(syncReport(report(), "token")).rejects.toThrow(/wiederherstellen|Transkript/);
    expect(uploads()).toEqual([]);
  });
  it("refuses stale cached text before writing any archive file", async () => {
    await expect(syncReport(report({ transcriptStale: true }), "token")).rejects.toThrow(/wiederherstellen|Transkript/);
    expect(uploads()).toEqual([]);
  });
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

  it("never copies Microsoft meeting metadata into the Google archive index",async()=>{
    storedReports=[report({home:{provider:"microsoft",connectionId:"c",driveId:"d",rootId:"root",rootName:"Meetings",folderId:"ms-folder"},driveFolderId:undefined})];
    await syncReport(report({driveFolderId:"google-folder"}),"token");
    expect(indexed?.meetings).toEqual([]);
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
