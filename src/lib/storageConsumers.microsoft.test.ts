import { expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  trash: vi.fn(),
  google: vi.fn(),
  remove: vi.fn(async () => {}),
  sync: vi.fn(),
  report: undefined as any,
}));
vi.mock("./firebase", () => ({ auth: { currentUser: { uid: "u" } }, db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: (...p: unknown[]) => p,
  deleteDoc: m.remove,
}));
vi.mock("./drive", () => ({ trashDriveFile: m.google }));
vi.mock("./onedrive", () => ({ trashOneDrive: m.trash }));
vi.mock("./session", () => ({ ensureDriveToken: async () => null }));
vi.mock("./local", () => ({
  deleteDraft: vi.fn(async () => {}),
  dropLocal: vi.fn(async () => {}),
  listLocal: async () => [{ report: m.report }],
  getLocal: async () => ({ report: m.report }),
  putLocal: vi.fn(),
}));
vi.mock("./pipeline", () => ({ activeJobs: () => [], jobFor: () => undefined, clearJob: vi.fn() }));
vi.mock("./serverProcessing", () => ({ forgetServerProcessing: vi.fn(async () => {}) }));
vi.mock("./workflow", () => ({
  ownedOperation: () => ({
    owner: "u",
    run: async (fn: () => Promise<unknown>) => fn(),
  }),
  syncReport: m.sync,
}));
import { deleteReport } from "./deleteReport";
import { sweepRetention } from "./retentionSweep";
const home = {
  provider: "microsoft" as const,
  connectionId: "c",
  driveId: "d",
  rootId: "root",
  rootName: "Meetings",
  folderId: "f",
  audioId: "a",
  syncedAt: "2026-01-01",
};
it("deletes and retains Microsoft files only on their pinned OneDrive connection", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  m.report = {
    id: "r",
    date: "2026-01-01",
    home,
    transcription: "Words",
    consent: { facts: { retention: { audioDays: 1 } } },
  };
  await sweepRetention(Date.parse("2026-11-01"));
  expect(m.trash).toHaveBeenCalledWith(home, "a");
  expect(m.sync).toHaveBeenCalledWith(
    expect.objectContaining({
      home: expect.not.objectContaining({ audioId: "a" }),
      audioDeletedAt: expect.any(String),
    }),
    expect.any(String),
  );
  await deleteReport("u", m.report, { fromDrive: true });
  expect(m.trash).toHaveBeenCalledWith(home, "f");
  expect(m.google).not.toHaveBeenCalled();
  expect(m.remove).toHaveBeenCalledWith([{}, "users", "u", "meetings", "r"]);
});
