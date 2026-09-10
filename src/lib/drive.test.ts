import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./session", () => ({ rememberToken: vi.fn() }));
import { getDriveFolder, listDriveReports, verifyDriveAccess } from "./drive";
import { rememberToken } from "./session";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
describe("Drive storage", () => {
  it("rejects a folder without write access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          id: "folder",
          name: "Shared",
          mimeType: "application/vnd.google-apps.folder",
          capabilities: { canAddChildren: false },
        }),
      ),
    );
    await expect(getDriveFolder("folder", "token")).rejects.toThrow(
      "keine Dateien speichern",
    );
  });
  it("clears an expired access token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 401)));
    await expect(getDriveFolder("folder", "token")).rejects.toThrow(
      "abgelaufen",
    );
    expect(rememberToken).toHaveBeenCalledWith(undefined);
  });
  it("rejects malformed imported room tags before they reach report rendering", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({ files: [{ id: "folder", name: "Broken" }] }),
        )
        .mockResolvedValueOnce(
          response({ files: [{ id: "json", name: "bericht_daten.json" }] }),
        )
        .mockResolvedValueOnce(
          response({
            id: "bad",
            title: "Report",
            date: "2026-09-10",
            rooms: [
              {
                name: "Room",
                summary: "",
                transcription: "",
                tags: "not-an-array",
              },
            ],
          }),
        ),
    );
    const result = await listDriveReports("token", "root");
    expect(result.reports).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });
  it("recovers reports across folder pages and reports malformed exports", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          files: [{ id: "folder1", name: "One" }],
          nextPageToken: "second",
        }),
      )
      .mockResolvedValueOnce(
        response({ files: [{ id: "folder2", name: "Two" }] }),
      )
      .mockResolvedValueOnce(
        response({ files: [{ id: "json1", name: "bericht_daten.json" }] }),
      )
      .mockResolvedValueOnce(
        response({ id: "r1", title: "Report", date: "2026-09-10", rooms: [] }),
      )
      .mockResolvedValueOnce(
        response({ files: [{ id: "json2", name: "bericht_daten.json" }] }),
      )
      .mockResolvedValueOnce(response({ invalid: true }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await listDriveReports("token", "root");
    expect(fetchMock.mock.calls[1][0]).toContain("pageToken=second");
    expect(result.reports).toEqual([
      expect.objectContaining({
        id: "r1",
        driveFolderId: "folder1",
        driveReportId: "json1",
      }),
    ]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("Drive permission preflight", () => {
  it("checks permissions without creating cloud files or requesting file data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ kind: "drive#fileList" }));
    vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await verifyDriveAccess("token");
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=kind",
        {
          headers: { Authorization: "Bearer token" },
          signal: expect.any(AbortSignal),
        },
      );
      expect(timeout).toHaveBeenCalledWith(10000);
      expect(rememberToken).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([401, 403])(
    "clears unusable credentials on HTTP %s before recording",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, status)));
      await expect(verifyDriveAccess("token")).rejects.toThrow(
        "Zugriff erlauben",
      );
      expect(rememberToken).toHaveBeenCalledExactlyOnceWith(undefined);
    },
  );

  it.each([429, 500, 503])(
    "keeps authorization on a transient HTTP %s failure",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, status)));
      await expect(verifyDriveAccess("token")).rejects.toThrow(
        "erneut versuchen",
      );
      expect(rememberToken).not.toHaveBeenCalled();
    },
  );

  it("keeps authorization after an offline request or timeout", async () => {
    const unavailable = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(unavailable));
    await expect(verifyDriveAccess("token")).rejects.toBe(unavailable);
    expect(rememberToken).not.toHaveBeenCalled();
  });
});
