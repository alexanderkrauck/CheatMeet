import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const identity = vi.hoisted(() => ({ currentUser: { uid: "A" } as { uid: string } | null }));
const session = vi.hoisted(() => ({
  cached: "synthetic-A" as string | undefined,
  rememberToken: vi.fn(),
  ensureDriveToken: vi.fn().mockResolvedValue(null),
}));
vi.mock("./firebase", () => ({ auth: identity }));
vi.mock("./session", () => session);
import { createSubFolder, getDriveFolder, listDriveReports, trashDriveFile, verifyDriveAccess, uploadTimeoutMs, uploadFileToFolder, readDriveArchiveRevision } from "./drive";
beforeEach(() => {
  identity.currentUser = { uid: "A" };
  session.cached = "synthetic-A";
  session.ensureDriveToken.mockReset().mockResolvedValue(null);
  session.rememberToken.mockImplementation(token => { session.cached = token; });
});
import { rememberToken } from "./session";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
describe("Drive storage", () => {
  it.each(["folder", "upload", "canonical", "preflight", "trash"])("preserves B's session when A's %s returns a late authorization failure", async operation => {
    let finish!: (response: Response) => void;
    const send = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValue(response({ id: "foreign-write" }));
    vi.stubGlobal("fetch", send);
    session.ensureDriveToken.mockResolvedValueOnce("synthetic-B");
    const pending = operation === "folder" ? createSubFolder("Only A", undefined, "synthetic-A")
      : operation === "upload" ? uploadFileToFolder(new Blob(["Only A"]), "a.txt", "text/plain", "A-folder", "synthetic-A")
      : operation === "canonical" ? uploadFileToFolder(new Blob(['{"id":"A"}']), "bericht_daten.json", "application/json", "A-folder", "synthetic-A", "A-json", '"v1"')
      : operation === "preflight" ? verifyDriveAccess("synthetic-A")
      : trashDriveFile("A-folder", "synthetic-A");
    identity.currentUser = { uid: "B" };
    session.cached = "synthetic-B";
    finish(response({}, 401));
    await expect(pending).rejects.toThrow(/Konto.*geändert/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(session.ensureDriveToken).not.toHaveBeenCalled();
    expect(rememberToken).not.toHaveBeenCalled();
    expect(session.cached).toBe("synthetic-B");
  });

  it("checks the owner again before renewal after clearing an expired token", async () => {
    const send = vi.fn().mockResolvedValueOnce(response({}, 401)).mockResolvedValue(response({ id: "foreign-write" }));
    vi.stubGlobal("fetch", send);
    session.rememberToken.mockImplementationOnce(() => {
      // Clearing the cache synchronously notifies session subscribers.
      identity.currentUser = { uid: "B" };
      session.cached = "synthetic-B";
    });
    session.ensureDriveToken.mockResolvedValueOnce("synthetic-B");
    await expect(createSubFolder("Only A", undefined, "synthetic-A")).rejects.toThrow(/Konto.*geändert/);
    expect(session.ensureDriveToken).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(session.cached).toBe("synthetic-B");
  });

  it("does not resend A's mutation when the account switches during renewal", async () => {
    let renew!: (token: string) => void;
    const send = vi.fn().mockResolvedValueOnce(response({}, 401)).mockResolvedValue(response({ id: "foreign-write" }));
    vi.stubGlobal("fetch", send);
    session.ensureDriveToken.mockImplementationOnce(() => new Promise(resolve => { renew = resolve; }));
    const pending = createSubFolder("Only A", undefined, "synthetic-A");
    await vi.waitFor(() => expect(session.ensureDriveToken).toHaveBeenCalledTimes(1));
    identity.currentUser = { uid: "B" };
    session.cached = "synthetic-B";
    renew("synthetic-renewed-A");
    await expect(pending).rejects.toThrow(/Konto.*geändert/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rememberToken).toHaveBeenCalledTimes(1);
    expect(session.cached).toBe("synthetic-B");
  });

  it("retains A's owner fence on the retried request's late 401", async () => {
    let finish!: (response: Response) => void;
    const send = vi.fn().mockResolvedValueOnce(response({}, 401))
      .mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", send);
    session.ensureDriveToken.mockResolvedValueOnce("synthetic-renewed-A");
    const pending = createSubFolder("Only A", undefined, "synthetic-A");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(new Headers(send.mock.calls[1][1].headers).get("Authorization")).toBe("Bearer synthetic-renewed-A");
    identity.currentUser = { uid: "B" };
    session.cached = "synthetic-B";
    finish(response({}, 401));
    await expect(pending).rejects.toThrow(/Konto.*geändert/);
    expect(send).toHaveBeenCalledTimes(2);
    expect(rememberToken).toHaveBeenCalledTimes(1);
    expect(session.ensureDriveToken).toHaveBeenCalledTimes(1);
    expect(session.cached).toBe("synthetic-B");
  });

  it("keeps the same conditional v2 URL, bytes and ETag on a same-owner token retry", async () => {
    const body = new Blob(['{"id":"r1","title":"Only A"}']);
    const send = vi.fn().mockResolvedValueOnce(response({}, 401)).mockResolvedValueOnce(response({ id: "json" }));
    vi.stubGlobal("fetch", send);
    session.ensureDriveToken.mockResolvedValueOnce("synthetic-renewed-A");
    await expect(uploadFileToFolder(body, "bericht_daten.json", "application/json", "folder", "synthetic-A", "json", '"v1"')).resolves.toBe("json");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe(send.mock.calls[0][0]);
    expect(send.mock.calls[1][0]).toContain("/upload/drive/v2/files/json");
    for (const [, init] of send.mock.calls) {
      expect(init).toMatchObject({ method: "PUT", body, headers: expect.objectContaining({ "If-Match": '"v1"' }) });
      expect(init.body).toBe(body);
    }
    expect(new Headers(send.mock.calls[1][1].headers).get("Authorization")).toBe("Bearer synthetic-renewed-A");
  });

  it.each(["before", "during", "unchanged"])("guards canonical JSON when its baseline is %s save", async (when) => {
    const baseline = "2026-11-01T00:00:00.000Z";
    let canonical = { id: "r1", driveSyncedAt: when === "before" ? "2026-11-02T00:00:00.000Z" : baseline, title: "Other client" };
    let etag = '"v1"';
    const send = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes("/upload/")) {
        if (init.method !== "PUT" || new Headers(init.headers).get("If-Match") !== etag)
          return response({}, 412);
        canonical = JSON.parse(await (init.body as Blob).text());
        return response({ id: "json" });
      }
      if (url.includes("alt=media")) return response(canonical);
      return response({ id: "json", version: "1", etag, parents: ["folder"] });
    });
    vi.stubGlobal("fetch", send);
    const pending = async () => {
      const revision = await readDriveArchiveRevision({ id: "r1", driveReportId: "json", driveFolderId: "folder", driveSyncedAt: when === "unchanged" ? "" : baseline, archiveBaseSyncedAt: when === "unchanged" ? baseline : undefined }, "token");
      if (when === "during") etag = '"v2"';
      await uploadFileToFolder(new Blob(['{"id":"r1","title":"Stale"}']), "bericht_daten.json", "application/json", "folder", "token", "json", revision);
    };
    if (when === "unchanged") {
      await expect(pending()).resolves.toBeUndefined();
      expect(canonical.title).toBe("Stale");
    } else {
      await expect(pending()).rejects.toThrow(/geändert|wiederherstellen/);
      expect(canonical.title).toBe("Other client");
    }
    if (when === "before") expect(send.mock.calls.some(([url]) => url.includes("/upload/"))).toBe(false);
    else {
      const [url, init] = send.mock.calls.find(([url]) => url.includes("/upload/"))!;
      expect(url).toContain("/upload/drive/v2/files/json");
      expect(init).toMatchObject({ method: "PUT", headers: expect.objectContaining({ "If-Match": '"v1"' }) });
    }
  });
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
  const folderWith = (document: unknown) =>
    vi
      .fn()
      .mockResolvedValueOnce(
        response({ files: [{ id: "folder", name: "Meeting 2026-09-15" }] }),
      )
      .mockResolvedValueOnce(
        response({ files: [{ id: "json", name: "bericht_daten.json" }] }),
      )
      .mockResolvedValueOnce(response(document));

  it("reads a document written under the current archive contract", async () => {
    vi.stubGlobal(
      "fetch",
      folderWith({
        archive: { version: 1, generator: "cheatmeet", generatedAt: "2026-09-15T12:00:00.000Z" },
        id: "r1",
        title: "Weekly Sync",
        date: "2026-09-15T12:00:00.000Z",
        summary: "Roadmap besprochen.",
        transcription: "Gesagtes",
        todos: [],
        takeaways: [],
        driveConsentId: "einwilligung-id",
      }),
    );

    const { reports, warnings } = await listDriveReports("token", "root");

    expect(warnings).toEqual([]);
    expect(reports).toHaveLength(1);
    // The ids always come from where the file was found.
    expect(reports[0].driveFolderId).toBe("folder");
    expect(reports[0].driveReportId).toBe("json");
    // A v1 file carries no status; a summarised meeting is a finished one.
    expect(reports[0].status).toBe("completed");
    expect(reports[0].driveConsentId).toBe("einwilligung-id");
  });

  it("restores a meeting whose consent record is unreadable", async () => {
    vi.stubGlobal(
      "fetch",
      folderWith({
        id: "r1",
        title: "Weekly Sync",
        date: "2026-09-15T12:00:00.000Z",
        todos: [],
        takeaways: [],
        consent: "ja klar",
      }),
    );

    const { reports, warnings } = await listDriveReports("token", "root");

    // Losing the evidence must not cost the user the meeting.
    expect(warnings).toEqual([]);
    expect(reports[0].title).toBe("Weekly Sync");
    expect(reports[0].consent).toBeUndefined();
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
