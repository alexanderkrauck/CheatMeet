import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConsentRecord, consentFacts } from "../../shared/consent";
import type { ReportData } from "../types";

const calls: string[] = [];
const account = vi.hoisted(() => ({ uid: "u1" }));
let stored: Map<string, ReportData>;
let trashError: Error | null = null;
let token: string | null = "t";

vi.mock("./firebase", () => ({
  auth: { get currentUser() { return account; } },
  db: {},
}));
vi.mock("./reports", () => ({ uid: () => "u1", saveReport: async () => null }));
vi.mock("./drive", () => ({
  trashDriveFile: async (id: string) => {
    if (trashError) throw trashError;
    calls.push(`trash:${id}`);
  },
}));
vi.mock("./session", () => ({ ensureDriveToken: async () => token }));
vi.mock("./pipeline", () => ({ activeJobs: () => [] }));
vi.mock("./workflow", async () => {
  const actual = await vi.importActual<typeof import("./workflow")>("./workflow");
  return {
    ownedOperation: actual.ownedOperation,
    syncReport: async (report: ReportData) => {
      calls.push(`sync:${report.id}:${report.rawAudioUrl ?? "-"}`);
      stored.set(report.id, report);
      return { report, warning: null };
    },
  };
});
vi.mock("./local", () => ({
  listLocal: async () =>
    [...stored.values()].map((report) => ({ report, dirty: false })),
  getLocal: async (_u: string, id: string) => {
    const report = stored.get(id);
    return report ? { report, dirty: false } : undefined;
  },
  putLocal: async (_u: string, report: ReportData) => {
    calls.push(`putLocal:${report.id}:${report.audioDeleteAttempts ?? 0}`);
    stored.set(report.id, report);
  },
  deleteDraft: async (_u: string, id: string) =>
    void calls.push(`deleteDraft:${id}`),
}));

const { sweepRetention } = await import("./retentionSweep");

const DATE = "2026-01-01T00:00:00.000Z";
const DAY = 86_400_000;
const NOW = Date.parse(DATE) + 31 * DAY;

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: DATE,
  title: "Meeting",
  summary: "Zusammenfassung",
  transcription: "Gesagtes",
  todos: [],
  takeaways: [],
  rawAudioUrl: "audio-id",
  driveFolderId: "folder-id",
  driveSyncedAt: DATE,
  consent: buildConsentRecord(
    consentFacts({
      sources: ["mic"],
      folderName: "Ordner",
      retention: { audioDays: 30, textDays: null },
    }),
    { obtainedAt: DATE, method: "spoken", participants: [{ name: "Sergio", stance: "agreed" as const }] },
  ),
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  account.uid = "u1";
  trashError = null;
  token = "t";
  stored = new Map([["r1", report()]]);
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
});

describe("sweepRetention", () => {
  it("deletes the audio and nothing else", async () => {
    expect(await sweepRetention(NOW)).toEqual({ deleted: 1, failed: 0 });

    expect(calls).toEqual([
      "trash:audio-id",
      "sync:r1:-",
      "deleteDraft:r1",
    ]);
    // The meeting's folder — and with it the transcript and summary — is never
    // touched.
    expect(calls.some((call) => call.includes("folder-id"))).toBe(false);
    const after = stored.get("r1")!;
    expect(after.rawAudioUrl).toBeUndefined();
    expect(after.audioDeletedAt).toBe(new Date(NOW).toISOString());
  });

  it("keeps the pointer when the deletion itself failed", async () => {
    trashError = new Error("Die Datei konnte nicht aus Drive gelöscht werden (500).");

    expect(await sweepRetention(NOW)).toEqual({ deleted: 0, failed: 1 });

    const after = stored.get("r1")!;
    // A crash between trashing and writing back must lose no pointer.
    expect(after.rawAudioUrl).toBe("audio-id");
    expect(after.audioDeleteAttempts).toBe(1);
    expect(after.audioDeleteError).toContain("500");
  });

  it("does not spend an attempt on a dead Drive grant", async () => {
    trashError = new Error(
      "Die Drive-Verbindung ist abgelaufen. Bitte Google Drive erneut verbinden.",
    );

    await sweepRetention(NOW);

    expect(stored.get("r1")!.audioDeleteAttempts).toBeUndefined();
    expect(calls.some((call) => call.startsWith("putLocal"))).toBe(false);
  });

  it("is idempotent once the audio is gone", async () => {
    await sweepRetention(NOW);
    calls.length = 0;

    expect(await sweepRetention(NOW)).toEqual({ deleted: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  it("never resurrects a meeting deleted on another device", async () => {
    // Gone between the scan and the write-back: the cloud index only adds.
    const vanishing = {
      listLocal: async () => [{ report: report(), dirty: false }],
    };
    const local = await import("./local");
    vi.spyOn(local, "listLocal").mockImplementation(vanishing.listLocal);
    stored.delete("r1");

    expect(await sweepRetention(NOW)).toEqual({ deleted: 0, failed: 0 });

    expect(calls).toEqual([]);
    expect(stored.has("r1")).toBe(false);
    vi.mocked(local.listLocal).mockRestore();
  });

  it("writes nothing into an account that took over mid-sweep", async () => {
    const drive = await import("./drive");
    vi.spyOn(drive, "trashDriveFile").mockImplementation(async (id: string) => {
      calls.push(`trash:${id}`);
      account.uid = "jemand-anderes";
    });

    expect(await sweepRetention(NOW)).toEqual({ deleted: 0, failed: 1 });

    expect(calls).toEqual(["trash:audio-id"]);
    expect(stored.get("r1")!.rawAudioUrl).toBe("audio-id");
    vi.mocked(drive.trashDriveFile).mockRestore();
  });

  it("skips quietly without a Drive grant or a connection", async () => {
    token = null;
    expect(await sweepRetention(NOW)).toEqual({ deleted: 0, failed: 0 });
    expect(calls).toEqual([]);

    token = "t";
    vi.stubGlobal("navigator", { onLine: false });
    expect(await sweepRetention(NOW)).toEqual({ deleted: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  it("leaves a meeting alone until the day it promised", async () => {
    expect(await sweepRetention(Date.parse(DATE) + 29 * DAY)).toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(calls).toEqual([]);
  });
});
