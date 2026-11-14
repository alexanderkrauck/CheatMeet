import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";
import type { LocalReport } from "./local";
import { toArchive } from "./archive";
import { projectReport } from "./reportProjection";
const m = vi.hoisted(() => ({
  auth: { currentUser: { uid: "u" } as { uid: string } | null },
  local: undefined as LocalReport | undefined,
  download: vi.fn(),
  read: vi.fn(),
  put: vi.fn(),
  token: vi.fn(async () => "token"),
}));
vi.mock("./firebase", () => ({ auth: m.auth }));
vi.mock("./local", () => ({
  getLocal: m.read,
  putLocal: m.put,
  ReportConflictError: class extends Error {
    constructor() {
      super("Meeting geändert");
      this.name = "ReportConflictError";
    }
  },
}));
vi.mock("./session", () => ({ ensureDriveToken: m.token }));
vi.mock("./drive", () => ({
  downloadDriveFile: m.download,
  findFileInFolder: vi.fn(),
}));
vi.mock("./onedrive", () => ({
  downloadOneDrive: m.download,
  listOneDriveItems: vi.fn(),
}));
const full = (microsoft: boolean): ReportData => ({
  id: "r",
  date: "2026-11-01",
  updatedAt: "2026-11-01",
  title: "Old archive title",
  summary: "Old summary",
  transcription: "Saved words",
  todos: [{ text: "Task" }],
  takeaways: ["Old"],
  ...(microsoft
    ? {
        home: {
          provider: "microsoft" as const,
          connectionId: "pinned",
          driveId: "d",
          rootId: "root",
          rootName: "Meetings",
          folderId: "f",
          reportId: "j",
          syncedAt: "2026-11-01",
        },
      }
    : { driveFolderId: "f", driveReportId: "j", driveSyncedAt: "2026-11-01" }),
});
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.currentUser = { uid: "u" };
  m.local = undefined;
  m.read.mockReset().mockImplementation(async () => structuredClone(m.local));
});

it.each([false, true])(
  "hydrates the latest saved metadata locally using only the pinned archive (Microsoft=%s)",
  async (microsoft) => {
    const archive = full(microsoft);
    const base = projectReport(archive);
    m.local = { report: base, dirty: false };
    m.download.mockImplementationOnce(async () => {
      m.local = {
        report: {
          ...base,
          updatedAt: "2026-11-14",
          title: "Latest title",
          summary: "Latest summary",
          todos: [{ text: "Task", done: true }],
          takeaways: ["Latest"],
          calendarEventId: "event",
          audioDeletedAt: "2026-11-13",
        },
        dirty: false,
      };
      return new Blob([JSON.stringify(toArchive(archive, "2026-11-01"))]);
    });
    const { restoreReportTranscript } = await import("./restoreTranscript");
    const restored = await restoreReportTranscript("u", base);
    expect(restored).toMatchObject({
      title: "Latest title",
      summary: "Latest summary",
      transcription: "Saved words",
      todos: [{ text: "Task", done: true }],
      takeaways: ["Latest"],
      calendarEventId: "event",
      audioDeletedAt: "2026-11-13",
      transcriptStale: false,
    });
    expect(m.put).toHaveBeenCalledWith("u", restored, false, "2026-11-14");
    expect(m.read).toHaveBeenCalledTimes(2);
    for (const call of m.read.mock.calls)
      expect(call).toEqual(["u", base.id, { index: microsoft ? "meetings" : "reports" }]);
    expect(restored.updatedAt).not.toBe("2026-11-14");
    expect(m.token).toHaveBeenCalledTimes(microsoft ? 0 : 1);
    expect(m.download).toHaveBeenCalledWith(
      ...(microsoft ? [archive.home, "j"] : ["j", "token"]),
    );
  },
);

it("refuses dirty edits, wrong archive identity and an account switch without any local write", async () => {
  const archive = full(false),
    base = projectReport(archive);
  const { restoreReportTranscript } = await import("./restoreTranscript");
  m.local = { report: base, dirty: false };
  m.download.mockImplementationOnce(async () => {
    m.local = { report: { ...base, summary: "Unsaved" }, dirty: true };
    return new Blob([JSON.stringify(toArchive(archive, "2026-11-01"))]);
  });
  await expect(restoreReportTranscript("u", base)).rejects.toThrow(
    /änder|gespeichert/,
  );
  m.local = { report: base, dirty: false };
  m.download.mockResolvedValueOnce(
    new Blob([
      JSON.stringify({ ...toArchive(archive, "2026-11-01"), id: "other" }),
    ]),
  );
  await expect(restoreReportTranscript("u", base)).rejects.toThrow(
    /Meeting|Archiv/,
  );
  m.download.mockImplementationOnce(async () => {
    m.auth.currentUser = { uid: "other" };
    return new Blob(["{}"]);
  });
  await expect(restoreReportTranscript("u", base)).rejects.toThrow(/Konto/);
  expect(m.put).not.toHaveBeenCalled();
});
