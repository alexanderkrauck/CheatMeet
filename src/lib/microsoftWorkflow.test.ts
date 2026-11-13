import { expect, it, vi } from "vitest";
import type { Draft } from "../types";
import { buildConsentRecord, consentFacts } from "../../shared/consent";
const m = vi.hoisted(() => ({
  calls: [] as string[],
  revision: vi.fn(),
  stored: vi.fn(),
  write: vi.fn(async (_h: unknown, name: string) => {
    m.calls.push(name);
    return { id: name };
  }),
  upload: vi.fn(async () => {
    m.calls.push("audio");
    return { id: "audio" };
  }),
}));
vi.mock("./firebase", () => ({ auth: { currentUser: { uid: "u" } }, db: {} }));
vi.mock("./local", () => ({
  putDraft: m.stored,
  putLocal: m.stored,
  listLocal: async () => [],
}));
vi.mock("./reports", () => ({ saveReport: async () => null }));
vi.mock("./webmDuration", () => ({ withWebmDuration: async (b: Blob) => b }));
vi.mock("./onedrive", () => ({
  assertOneDriveRevision: m.revision,
  createOneDriveFolder: async () => ({ id: "f" }),
  writeOneDriveText: m.write,
  uploadOneDrive: m.upload,
  listOneDriveItems: async () => [],
}));
import { backupMicrosoftDraft, syncMicrosoftReport } from "./microsoftWorkflow";
it("checkpoints Microsoft references and consent before audio, without legacy Google IDs", async () => {
  const draft: Draft = {
    report: {
      id: "r",
      title: "Test",
      date: "2026-11-01",
      summary: "",
      transcription: "",
      todos: [],
      takeaways: [],
      home: {
        provider: "microsoft",
        connectionId: "c",
        driveId: "d",
        rootId: "root",
        rootName: "Meetings",
      },
      consent: buildConsentRecord(
        consentFacts({
          sources: ["mic"],
          folderName: "Meetings",
          retention: { audioDays: 30, textDays: null },
        }),
        {
          obtainedAt: "2026-11-01T00:00:00Z",
          method: "spoken",
          participants: [],
        },
      ),
    },
    audio: new Blob(["audio"]),
  };
  await backupMicrosoftDraft(draft, () => {});
  expect(m.calls.slice(0, 2)).toEqual(["einwilligung.md", "audio"]);
  expect(draft.report.home?.audioId).toBe("audio");
  expect(draft.report.rawAudioUrl).toBeUndefined();
  expect(draft.report.driveFolderId).toBeUndefined();
  await syncMicrosoftReport(draft.report);
  expect(draft.report.home?.reportId).toBe("bericht_daten.json");
  expect(draft.report.home?.syncedAt).toBeTruthy();
});
it("checks canonical revision before changing any derived text file", async () => {
  m.write.mockClear();
  m.revision.mockRejectedValueOnce(Error("Neue Dateiversion"));
  const report = {
    id: "r",
    title: "Test",
    date: "2026-11-01",
    summary: "Edit",
    transcription: "Words",
    todos: [],
    takeaways: [],
    home: {
      provider: "microsoft" as const,
      connectionId: "c",
      driveId: "d",
      rootId: "root",
      rootName: "Meetings",
      folderId: "f",
      reportId: "j",
    },
  };
  await expect(syncMicrosoftReport(report)).rejects.toThrow("Dateiversion");
  expect(m.write).not.toHaveBeenCalled();
});
