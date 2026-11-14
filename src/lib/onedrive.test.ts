import { afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  api: vi.fn(),
  request: vi.fn(),
  user: { uid: "u" },
}));
vi.mock("./microsoft", () => ({
  microsoftApi: m.api,
  microsoftRequest: m.request,
  microsoftOwner: () => ({
    owner: m.user.uid,
    check: () => {
      if (m.user.uid !== "u") throw Error("Konto");
    },
  }),
}));
import {
  uploadOneDrive,
  writeOneDriveText,
  downloadOneDrive,
  createOneDriveFolder,
  readOneDriveArchiveRevision,
} from "./onedrive";
const home = {
  provider: "microsoft" as const,
  connectionId: "c",
  driveId: "d",
  rootId: "r",
  rootName: "Root",
  folderId: "f",
};
afterEach(() => { vi.unstubAllGlobals(); });
it.each(["before", "during", "commit"])("pins canonical OneDrive JSON against a change %s save even when another tab refreshes the ETag cache", async (when) => {
  const baseline = "2026-11-01T00:00:00.000Z";
  let etag = '"v1"';
  const revisions = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => revisions.get(k) || etag, setItem: (k: string, v: string) => revisions.set(k, v) });
  m.request.mockReset().mockImplementation(async (_path: string, init: RequestInit = {}) => {
    if (init.method === "PUT") {
      if (when === "commit") etag = '"v2"';
      if (new Headers(init.headers).get("If-Match") !== etag)
        throw Object.assign(Error("Precondition failed"), { status: 412 });
      throw Error("Must not overwrite");
    }
    return Response.json({ id: "json", eTag: etag, "@microsoft.graph.downloadUrl": "https://storage.example/json" });
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "r", home: { ...home, syncedAt: when === "before" ? "2026-11-02T00:00:00.000Z" : baseline } })));
  const pending = async () => {
    const pinned = await readOneDriveArchiveRevision({ id: "r", home: { ...home, reportId: "json", syncedAt: when === "commit" ? undefined : baseline }, archiveBaseSyncedAt: when === "commit" ? baseline : undefined });
    if (when === "during") etag = '"v2"';
    for (const key of revisions.keys()) revisions.set(key, '"v2"');
    await writeOneDriveText(home, "bericht_daten.json", "{}", "json", pinned);
  };
  await expect(pending()).rejects.toThrow(/Dateiversion|wiederherstellen/);
  expect(m.request.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(when === "commit" ? 1 : 0);
  if (when === "commit") expect(m.request).toHaveBeenLastCalledWith(
    "/drives/d/items/json/content", expect.objectContaining({ headers: expect.objectContaining({ "If-Match": '"v1"' }) }), "c",
  );
});
it('updates bounded text with native Graph If-Match rather than a Personal-only deferred commit',async()=>{
  m.api.mockReset().mockRejectedValue(Error('Deferred update is not supported by Business OneDrive'));
  m.request.mockReset().mockResolvedValueOnce(Response.json({id:'json',eTag:'v1'})).mockResolvedValueOnce(Response.json({id:'json',size:5,eTag:'v2'}));
  const revisions=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>revisions.get(key)||'v1',setItem:(key:string,value:string)=>revisions.set(key,value)});
  expect(await writeOneDriveText(home,'bericht_daten.json','hello','json')).toMatchObject({id:'json',eTag:'v2'});
  expect(m.request).toHaveBeenLastCalledWith('/drives/d/items/json/content',expect.objectContaining({method:'PUT',body:'hello',headers:expect.objectContaining({'If-Match':'v1'})}),'c');
  expect(m.api).not.toHaveBeenCalled();
});
it("resumes sequential chunks from server-owned ranges, never sends bearer to upload capability, verifies completion", async () => {
  m.api.mockImplementation(async (path: string) =>
    path === "uploads"
      ? { handle: "opaque" }
      : path === "uploads/session"
        ? {
            uploadUrl: "https://storage.example/upload",
            nextExpectedRanges: ["327680-"],
            expirationDateTime: "2099-01-01",
          }
        : { id: "audio", size: 655360 },
  );
  const send = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ id: "audio", size: 655360 }), {
        status: 201,
      }),
  );
  vi.stubGlobal("fetch", send);
  const checkpoints: string[] = [];
  const result = await uploadOneDrive(
    home,
    new Blob([new Uint8Array(655360)]),
    "aufnahme.webm",
    {
      checkpoint: async (h) => {
        checkpoints.push(h);
      },
    },
  );
  expect(result.id).toBe("audio");
  expect(checkpoints).toEqual(["opaque"]);
  const init = send.mock.calls[0][1] as RequestInit;
  expect(new Headers(init.headers).get("Content-Range")).toBe(
    "bytes 327680-655359/655360",
  );
  expect(new Headers(init.headers).has("Authorization")).toBe(false);
});
it("recovers a finalized upload after a lost last PUT response without creating another session", async () => {
  m.api.mockClear();
  m.api.mockImplementation(async (path: string) => {
    if (path === "uploads/complete") return { id: "done", size: 5 };
    throw Error("must not recreate");
  });
  expect(
    (
      await uploadOneDrive(home, new Blob(["audio"]), "aufnahme.webm", {
        handle: "old",
      })
    ).id,
  ).toBe("done");
  expect(m.api).toHaveBeenCalledOnce();
});
it("rejects editing a changed OneDrive archive instead of overwriting an external revision", async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) || null,
    setItem: (k: string, v: string) => stored.set(k, v),
  });
  m.request.mockResolvedValueOnce(
    Response.json({
      id: "json",
      eTag: "old",
      "@microsoft.graph.downloadUrl": "https://storage.example/data",
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}")),
  );
  await downloadOneDrive(home, "json");
  m.request.mockResolvedValueOnce(Response.json({ id: "json", eTag: "new" }));
  await expect(
    writeOneDriveText(home, "bericht_daten.json", "{}", "json"),
  ).rejects.toThrow("Dateiversion");
});
it("recovers a write-once consent file after its upload response was lost without overwriting it", async () => {
  m.api.mockClear();
  m.request
    .mockResolvedValueOnce(
      Response.json({
        value: [{ id: "consent", name: "einwilligung.md", size: 4 }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        id: "consent",
        eTag: "v1",
        "@microsoft.graph.downloadUrl": "https://storage.example/consent",
      }),
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("same")),
  );
  const saved = await writeOneDriveText(home, "einwilligung.md", "same");
  expect(saved.id).toBe("consent");
  expect(m.api).not.toHaveBeenCalled();
});
it("recovers the deterministic meeting folder after a lost creation response", async () => {
  m.request.mockClear();
  m.request.mockResolvedValueOnce(
    Response.json({
      value: [
        { id: "existing", name: "Meeting 2026-11-01 – report", folder: {} },
      ],
    }),
  );
  expect(
    (await createOneDriveFolder(home, "Meeting 2026-11-01 – report")).id,
  ).toBe("existing");
  expect(m.request.mock.calls[0][1]).not.toHaveProperty("method", "POST");
});
it("commits a deferred update after the last fragment returns 202 with no remaining ranges", async () => {
  m.api.mockImplementation(async (path: string) =>
    path === "uploads"
      ? { handle: "update" }
      : path === "uploads/session"
        ? {
            uploadUrl: "https://storage.example/update",
            nextExpectedRanges: ["0-"],
            expirationDateTime: "2099-01-01",
          }
        : { id: "updated", size: 5 },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ nextExpectedRanges: [] }, { status: 202 }),
    ),
  );
  expect(
    (
      await uploadOneDrive(home, new Blob(["audio"]), "bericht_daten.json", {
        itemId: "updated",
        etag: "old",
      })
    ).id,
  ).toBe("updated");
  m.api.mockImplementation(async (path: string) => {
    if (path === "uploads/complete")
      throw Object.assign(Error("Dateiversion geändert"), { status: 409 });
    return path === "uploads"
      ? { handle: "conflict" }
      : {
          uploadUrl: "https://storage.example/update",
          nextExpectedRanges: ["0-"],
          expirationDateTime: "2099-01-01",
        };
  });
  await expect(
    uploadOneDrive(home, new Blob(["audio"]), "bericht_daten.json", {
      itemId: "updated",
      etag: "old",
    }),
  ).rejects.toMatchObject({ status: 409 });
});
