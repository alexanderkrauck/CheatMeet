import { afterEach, describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({
  rememberToken: vi.fn(),
  ensureDriveToken: vi.fn().mockResolvedValue(null),
}));
vi.mock("./session", () => session);
import { getDriveFolder, listDriveReports, verifyDriveAccess, uploadTimeoutMs } from "./drive";
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
  it("retries once with a freshly minted token before giving up", async () => {
    // A background job can outlive the token it started with.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(
        response({
          id: "folder",
          name: "Ordner",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    session.ensureDriveToken.mockResolvedValueOnce("fresh-token");
    await expect(getDriveFolder("folder", "stale")).resolves.toMatchObject({
      id: "folder",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (fetchMock.mock.calls[1][1] as RequestInit).headers,
    ).toMatchObject({ Authorization: "Bearer fresh-token" });
  });

  it("clears an expired access token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 401)));
    await expect(getDriveFolder("folder", "token")).rejects.toThrow(
      "abgelaufen",
    );
    expect(rememberToken).toHaveBeenCalledWith(undefined);
  });
  it.each([
    { field: "todos", value: "not-an-array" },
    { field: "takeaways", value: [{ text: "object instead of string" }] },
    { field: "rawAudioUrl", value: 42 },
  ])(
    "rejects a malformed imported $field before it reaches report rendering",
    async ({ field, value }) => {
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
              [field]: value,
            }),
          ),
      );
      const result = await listDriveReports("token", "root");
      expect(result.reports).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
    },
  );

  it("imports a meeting report and fills in absent optional fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({ files: [{ id: "folder", name: "Sync" }] }),
        )
        .mockResolvedValueOnce(
          response({ files: [{ id: "json", name: "bericht_daten.json" }] }),
        )
        .mockResolvedValueOnce(
          response({
            id: "r1",
            title: "Weekly Sync",
            date: "2026-09-10",
            todos: ["Angebot senden"],
          }),
        ),
    );
    const result = await listDriveReports("token", "root");
    expect(result.warnings).toHaveLength(0);
    // A report written before to-dos had structure still restores.
    expect(result.reports[0]).toMatchObject({
      id: "r1",
      todos: [{ text: "Angebot senden" }],
      takeaways: [],
      transcription: "",
      summary: "",
      status: "pending",
      driveFolderId: "folder",
      driveReportId: "json",
    });
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
        response({ id: "r1", title: "Report", date: "2026-09-10" }),
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

describe("upload deadlines", () => {
  it("keeps the short deadline for small payloads", () => {
    expect(uploadTimeoutMs(0)).toBe(120_000);
    expect(uploadTimeoutMs(1024)).toBe(120_000);
  });
  it("scales with the payload, so an hour of audio is not aborted", () => {
    // ~28 MB is roughly an hour of the recorder's output.
    expect(uploadTimeoutMs(28 * 1024 * 1024)).toBeGreaterThan(600_000);
  });
  it("grows monotonically", () => {
    expect(uploadTimeoutMs(200 * 1024 * 1024)).toBeGreaterThan(
      uploadTimeoutMs(28 * 1024 * 1024),
    );
  });
});
