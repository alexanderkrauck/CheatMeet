import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

const calls: string[] = [];
let driveFails = false;
let firestoreFails = false;
let token: string | null = "t";

vi.mock("./firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  deleteDoc: async (path: string) => {
    if (firestoreFails) throw new Error("offline");
    calls.push(`firestore:${path}`);
  },
}));
vi.mock("./drive", () => ({
  trashDriveFolder: async (id: string) => {
    if (driveFails) throw new Error("Der Drive-Ordner konnte nicht gelöscht werden (500).");
    calls.push(`drive:${id}`);
  },
}));
vi.mock("./local", () => ({
  deleteDraft: async (_u: string, id: string) => void calls.push(`draft:${id}`),
  dropLocal: async (_u: string, id: string) => void calls.push(`local:${id}`),
}));
vi.mock("./session", () => ({ ensureDriveToken: async () => token }));

const { deleteReport } = await import("./deleteReport");

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1", date: "2026-09-14T08:00:00.000Z", title: "Weekly",
  summary: "", transcription: "", todos: [], takeaways: [],
  driveFolderId: "folder-1", ...over,
});

beforeEach(() => {
  calls.length = 0;
  driveFails = false;
  firestoreFails = false;
  token = "t";
});

describe("deleteReport", () => {
  it("removes the meeting from all three stores", async () => {
    const result = await deleteReport("u1", report(), { fromDrive: true });
    expect(result).toMatchObject({ removed: true, warnings: [] });
    expect(calls).toEqual([
      "drive:folder-1",
      "firestore:users/u1/reports/r1",
      "draft:r1",
      "local:r1",
    ]);
  });

  it("leaves Drive alone when the user kept the files", async () => {
    await deleteReport("u1", report(), { fromDrive: false });
    expect(calls.some((c) => c.startsWith("drive:"))).toBe(false);
    expect(calls).toContain("local:r1");
  });

  it("keeps everything when Drive refuses, so the delete can be retried", async () => {
    driveFails = true;
    const result = await deleteReport("u1", report(), { fromDrive: true });
    expect(result).toMatchObject({ removed: false });
    expect(result.warnings[0]).toContain("Drive-Ordner");
    // Dropping the local copy here would throw away the folder id and strand
    // the Drive files forever.
    expect(calls).toEqual([]);
  });

  it("does not claim a Drive delete it could not even attempt", async () => {
    token = null;
    const result = await deleteReport("u1", report(), { fromDrive: true });
    expect(result.warnings[0]).toContain("nicht verbunden");
    expect(calls).toEqual([]);
  });

  it("says so when Drive was asked for but no folder is known", async () => {
    const result = await deleteReport("u1", report({ driveFolderId: undefined }), {
      fromDrive: true,
    });
    expect(result.warnings[0]).toContain("kein Drive-Ordner");
    expect(calls).toEqual([]);
  });

  it("warns that a failed cloud delete can resurface on another device", async () => {
    firestoreFails = true;
    const result = await deleteReport("u1", report(), { fromDrive: true });
    // Removed locally even though the cloud entry survives — the caller must
    // be able to tell that apart from "nothing happened".
    expect(result.removed).toBe(true);
    expect(result.warnings[0]).toContain("anderen Gerät");
    expect(calls).toContain("local:r1");
  });

  it("removes a meeting that never reached Drive when Drive was not asked for", async () => {
    const result = await deleteReport("u1", report({ driveFolderId: undefined }), {
      fromDrive: false,
    });
    expect(result.warnings).toEqual([]);
    expect(calls).toEqual(["firestore:users/u1/reports/r1", "draft:r1", "local:r1"]);
  });
});
