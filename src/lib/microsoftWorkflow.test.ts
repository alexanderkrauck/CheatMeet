import { beforeEach, expect, it, vi } from "vitest";
import type { Draft, ReportData } from "../types";
import { buildConsentRecord, consentFacts } from "../../shared/consent";
const m = vi.hoisted(() => ({
  calls: [] as string[],
  revision: vi.fn(),
  items: vi.fn(),
  download: vi.fn(),
  read: vi.fn(),
  db: new Map<string, any>(),
  snapshots: new Map<string, (value: any) => void>(),
  stored: vi.fn(),
  draftStored: vi.fn(),
  folder: vi.fn<typeof import("./onedrive").createOneDriveFolder>(),
  local: undefined as { report: ReportData; dirty: boolean } | undefined,
  write: vi.fn(async (_h: unknown, name: string) => {
    m.calls.push(name);
    return { id: name };
  }),
  upload: vi.fn<typeof import("./onedrive").uploadOneDrive>(async () => {
    m.calls.push("audio");
    return { id: "audio" };
  }),
}));
vi.mock("./firebase", () => ({ auth: { currentUser: { uid: "u" } }, db: {} }));
vi.mock("idb-keyval", () => ({
  createStore: () => ({}), get: async (key: string) => m.db.get(key),
  set: async (key: string, value: unknown) => { m.db.set(key, structuredClone(value)); },
  setMany: async (entries: [string, unknown][]) => { for (const [key, value] of entries) m.db.set(key, structuredClone(value)); },
  del: async (key: string) => { m.db.delete(key); },
  update: async (key: string, change: (value: any) => any) => { m.db.set(key, structuredClone(change(m.db.get(key)))); },
  keys: async () => [...m.db.keys()], getMany: async (keys: string[]) => keys.map(key => m.db.get(key)),
}));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  collection: (_db: unknown, ...path: string[]) => path.join("/"),
  onSnapshot: (path: string, _options: unknown, callback: (value: any) => void) => { m.snapshots.set(path, callback); return () => m.snapshots.delete(path); },
  setDoc: vi.fn(), getDocFromServer: vi.fn(),
}));
vi.mock("./people", () => ({ rememberPeople: vi.fn() }));
vi.mock("./session", () => ({ errorMessage: String }));
vi.mock("./local", async original => ({
  ...await original<typeof import("./local")>(),
  ReportConflictError: class extends Error { constructor() { super("Neuere Fassung laden"); this.name = "ReportConflictError"; } },
  getLocal: m.read,
  putDraft: m.draftStored,
  putLocal: m.stored,
}));
vi.mock("./reports", () => ({ saveReport: async () => null }));
vi.mock("./webmDuration", () => ({ withWebmDuration: async (b: Blob) => b }));
vi.mock("./onedrive", () => ({
  readOneDriveArchiveRevision: m.revision,
  createOneDriveFolder: m.folder,
  writeOneDriveText: m.write,
  uploadOneDrive: m.upload,
  listOneDriveItems: m.items,
  downloadOneDrive: m.download,
}));
import { backupMicrosoftDraft, syncMicrosoftReport, restoreMicrosoftArchive } from "./microsoftWorkflow";
beforeEach(() => {
  m.local = undefined;
  m.db.clear(); m.snapshots.clear();
  m.read.mockReset().mockImplementation(async () => m.local);
  m.calls.length = 0;
  m.revision.mockReset();
  m.items.mockReset().mockResolvedValue([]);
  m.download.mockReset();
  m.folder.mockReset().mockResolvedValue({ id: "f" });
  m.upload.mockReset().mockImplementation(async () => {
    m.calls.push("audio");
    return { id: "audio" };
  });
  m.draftStored.mockReset();
  m.write.mockReset().mockImplementation(async (_h: unknown, name: string) => {
    m.calls.push(name);
    return { id: name };
  });
  m.stored.mockReset().mockImplementation(async (_u: string, report: ReportData, _dirty = true, expected?: string | null) => {
    if (expected !== undefined && (m.local?.report.updatedAt ?? null) !== expected)
      throw Object.assign(Error("Neuere Fassung laden"), { name: "ReportConflictError" });
    if (report.id) m.local = { report: structuredClone(report), dirty: _dirty };
  });
});
it.each(["folder", "audio", "upload-handle"] as const)("rejects a late Microsoft backup %s checkpoint without replacing human work", async stage => {
  const local = await vi.importActual<typeof import("./local")>("./local");
  m.read.mockImplementation(local.getLocal);
  m.stored.mockImplementation(local.putLocal);
  m.draftStored.mockImplementation(local.putDraft);
  const originalAudio = new Blob(["original recording"], { type: "audio/webm" });
  const draft: Draft = {
    report: { id: "r", title: "Aufnahme", date: "2026-11-01", summary: "", transcription: "Live", todos: [], takeaways: [], updatedAt: "2026-11-01T00:00:00.000Z", home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", ...(stage === "folder" ? {} : { folderId: "f", consentId: "consent" }) } },
    audio: originalAudio,
    ...(stage === "audio" ? { microsoftUploadHandle: "resumable-handle" } : {}),
  };
  await local.putLocal("u", draft.report);
  await local.putDraft("u", draft);
  const google = { ...draft.report, home: undefined, title: "Google sibling" };
  await local.putLocal("u", google);
  await local.putDraft("u", { report: google, audio: new Blob(["Google audio"]) });
  await local.putLocal("other-owner", draft.report);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  if (stage === "folder") m.folder.mockImplementationOnce(async () => { await waiting; return { id: "f" }; });
  else m.upload.mockImplementationOnce(async (_home, _audio, _name, options) => {
    expect(options?.handle).toBe(draft.microsoftUploadHandle);
    await waiting;
    if (stage === "upload-handle") await options?.checkpoint?.("late-handle");
    return { id: "audio" };
  });
  const pending = backupMicrosoftDraft(draft, () => {});
  await vi.waitFor(() => expect(stage === "folder" ? m.folder : m.upload).toHaveBeenCalledOnce());
  const newer = { ...structuredClone(draft.report), title: "Menschliche Bearbeitung", transcription: "Neu bearbeitet", updatedAt: "2026-11-02T00:00:00.000Z" };
  const newerDraft = { ...draft, report: newer, retranscribe: true };
  await local.putLocal("u", newer, true);
  await local.putDraft("u", newerDraft);
  const savedHuman = await local.getLocal("u", "r", { index: "meetings" });
  release();
  await expect(pending).rejects.toMatchObject({ name: "ReportConflictError" });
  expect(await local.getLocal("u", "r", { index: "meetings" })).toEqual(savedHuman);
  expect(await local.getDraft("u:microsoft", "r", true)).toEqual(newerDraft);
  expect(await local.getLocal("u", "r", { index: "reports" })).toMatchObject({ report: google });
  expect((await local.getDraft("u", "r", true))?.report).toEqual(google);
  expect((await local.getLocal("other-owner", "r", { index: "meetings" }))?.report.title).toBe("Aufnahme");
  expect(m.read).toHaveBeenCalledWith("u", "r", { index: "meetings" });
  expect(draft.report.updatedAt).toBe("2026-11-01T00:00:00.000Z");
  expect(draft.microsoftUploadHandle).toBe(stage === "audio" ? "resumable-handle" : undefined);
  expect(draft.audio).toBe(originalAudio);
});
it.each([undefined, null, "2026-11-01T00:00:00.000Z"])("refuses a stale Microsoft backup before provider waits with expectation %s", async expected => {
  const report: ReportData = { id: "r", title: "Aufnahme", date: "2026-11-01", summary: "", transcription: "Live", todos: [], takeaways: [], updatedAt: "2026-11-01T00:00:00.000Z", home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } };
  const newer = { ...report, title: "Menschliche Bearbeitung", updatedAt: "2026-11-02T00:00:00.000Z" };
  m.local = { report: structuredClone(newer), dirty: true };
  await expect(backupMicrosoftDraft({ report, audio: new Blob(["audio"]) }, () => {}, expected)).rejects.toMatchObject({ name: "ReportConflictError" });
  expect(m.local.report).toEqual(newer);
  expect(m.folder).not.toHaveBeenCalled();
  expect(m.write).not.toHaveBeenCalled();
  expect(m.upload).not.toHaveBeenCalled();
  expect(m.draftStored).not.toHaveBeenCalled();
});
it("resumes a committed Microsoft upload handle with the original audio after interruption", async () => {
  const local = await vi.importActual<typeof import("./local")>("./local");
  m.read.mockImplementation(local.getLocal);
  m.stored.mockImplementation(local.putLocal);
  m.draftStored.mockImplementation(local.putDraft);
  const audio = new Blob(["original recording"], { type: "audio/webm" });
  const draft: Draft = { report: { id: "r", title: "Aufnahme", date: "2026-11-01", summary: "", transcription: "Live", todos: [], takeaways: [], home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", folderId: "f", consentId: "consent" } }, audio };
  m.upload.mockImplementationOnce(async (_home, _audio, _name, options) => {
    await options?.checkpoint?.("resumable-handle");
    throw Error("Upload unterbrochen");
  });
  await expect(backupMicrosoftDraft(draft, () => {}, null)).rejects.toThrow("Upload unterbrochen");
  const resumed = (await local.getDraft("u:microsoft", "r", true))!;
  expect(resumed.microsoftUploadHandle).toBe("resumable-handle");
  expect(await resumed.audio!.text()).toBe(await audio.text());
  expect(resumed.report.updatedAt).toBe(draft.report.updatedAt);
  expect((await local.getLocal("u", "r", { index: "meetings" }))?.report.updatedAt).toBe(resumed.report.updatedAt);
  await backupMicrosoftDraft(resumed, () => {}, resumed.report.updatedAt);
  expect(m.upload.mock.calls[1][3]?.handle).toBe("resumable-handle");
  expect(resumed.report.home?.audioId).toBe("audio");
  expect(resumed.microsoftUploadHandle).toBeUndefined();
  expect((await local.getDraft("u:microsoft", "r", true))?.microsoftUploadHandle).toBeUndefined();
  expect(await resumed.audio!.text()).toBe(await audio.text());
  expect(draft.audio).toBe(audio);
});
it("syncs the selected Microsoft report beside a same-ID Google copy", async () => {
  const local = await vi.importActual<typeof import("./local")>("./local");
  m.read.mockImplementation(local.getLocal);
  m.stored.mockImplementation(local.putLocal);
  const microsoft: ReportData = { id: "r", title: "Microsoft", date: "2026-11-01", summary: "Edit", transcription: "Words", todos: [], takeaways: [], home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", folderId: "f" } };
  const google = { ...microsoft, home: undefined, title: "Google sibling" };
  await local.putLocal("u", google);
  await local.putLocal("u", microsoft);
  const googleBefore = await local.getLocal("u", "r", { index: "reports" });
  await syncMicrosoftReport(microsoft);
  expect(await local.getLocal("u", "r", { index: "reports" })).toEqual(googleBefore);
  expect((await local.getLocal("u", "r", { index: "meetings" }))?.report.home?.syncedAt).toBeTruthy();
  for (const call of m.read.mock.calls)
    expect(call).toEqual(["u", "r", { index: "meetings" }]);
});
it.each(["entry", "upload"])("preserves a later Microsoft local revision at %s", async (when) => {
  const report: ReportData = { id: "r", title: "Test", date: "2026-11-01", summary: "Edit", transcription: "Words", todos: [], takeaways: [], updatedAt: "2026-11-01T00:00:00.000Z", home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", folderId: "f" } };
  const newer = { ...report, title: "Neuere Bearbeitung", updatedAt: "2026-11-02T00:00:00.000Z" };
  m.local = { report: structuredClone(when === "entry" ? newer : report), dirty: true };
  m.write.mockImplementation(async (_h: unknown, name: string) => {
    m.calls.push(name);
    if (name === "zusammenfassung.md") m.local = { report: structuredClone(newer), dirty: true };
    return { id: name };
  });
  await expect(syncMicrosoftReport(report)).rejects.toMatchObject({ name: "ReportConflictError" });
  expect(m.local.report).toEqual(newer);
  expect(m.calls).not.toContain("bericht_daten.json");
  if (when === "entry") expect(m.write).not.toHaveBeenCalled();
});
it("refuses an old caller snapshot after newer local content invalidation", async () => {
  const report: ReportData = { id: "r", title: "Test", date: "2026-11-01", summary: "", transcription: "Old", todos: [], takeaways: [], home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } };
  m.local = { report: { ...report, transcriptStale: true }, dirty: false };
  m.write.mockClear();
  await expect(syncMicrosoftReport(report)).rejects.toThrow(/wiederherstellen|Transkript/);
  expect(m.write).not.toHaveBeenCalled();
  m.local = undefined;
});
it("refuses stale cached text before writing any OneDrive file", async () => {
  m.write.mockClear();
  await expect(syncMicrosoftReport({ id: "r", title: "Test", date: "2026-11-01", summary: "", transcription: "Stale text", transcriptStale: true, todos: [], takeaways: [], home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } })).rejects.toThrow(/wiederherstellen|Transkript/);
  expect(m.write).not.toHaveBeenCalled();
});
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

it.each([false, true])("restores Microsoft archive with existing indexed copy=%s without inventing acknowledgement", async indexed => {
  const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", folderId: "f", reportId: "j" };
  const report: ReportData = { id: "r", title: "Archiv", date: "2026-11-01", updatedAt: "2026-11-01T00:00:00.000Z", summary: "Bericht", transcription: "Archivtext", todos: [], takeaways: [], home };
  if (indexed) m.local = { report: { ...report, transcription: "" }, dirty: false };
  m.items.mockImplementation(async (_home: unknown, id: string) => id === "root" ? [{ id: "f", name: "Meeting", folder: {} }] : [{ id: "j", name: "bericht_daten.json" }]);
  m.download.mockResolvedValue(new Blob([JSON.stringify(report)]));
  expect(await restoreMicrosoftArchive(home)).toEqual({ count: 1, errors: [] });
  expect(m.local).toMatchObject({ report: { transcription: "Archivtext" }, dirty: !indexed });
  expect(m.stored).toHaveBeenLastCalledWith("u", expect.any(Object), !indexed, indexed ? report.updatedAt : null);
});

it("restores Microsoft beside a same-ID Google copy without treating that copy as the index", async () => {
  const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", folderId: "f", reportId: "j" };
  const report: ReportData = { id: "r", title: "Archiv", date: "2026-11-01", summary: "Bericht", transcription: "Archivtext", todos: [], takeaways: [], home };
  m.read.mockImplementation(async (_u: string, _id: string, options?: { index: string }) => options?.index === "meetings" ? undefined : { report: { ...report, home: undefined }, dirty: true });
  m.items.mockImplementation(async (_home: unknown, id: string) => id === "root" ? [{ id: "f", name: "Meeting", folder: {} }] : [{ id: "j", name: "bericht_daten.json" }]);
  m.download.mockResolvedValue(new Blob([JSON.stringify(report)]));
  expect(await restoreMicrosoftArchive(home)).toEqual({ count: 1, errors: [] });
  expect(m.local).toMatchObject({ report: { home }, dirty: true });
});

it("keeps archive-only Microsoft recovery through actual empty authoritative index reconciliation", async () => {
  const local = await vi.importActual<typeof import("./local")>("./local");
  m.read.mockImplementation(local.getLocal);
  m.stored.mockImplementation(local.putLocal);
  const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", folderId: "f", reportId: "j" };
  const report: ReportData = { id: "r", title: "Archiv", date: "2026-11-01", summary: "Bericht", transcription: "Archivtext", todos: [], takeaways: [], home };
  m.items.mockImplementation(async (_home: unknown, id: string) => id === "root" ? [{ id: "f", name: "Meeting", folder: {} }] : [{ id: "j", name: "bericht_daten.json" }]);
  m.download.mockResolvedValue(new Blob([JSON.stringify(report)]));
  expect(await restoreMicrosoftArchive(home)).toEqual({ count: 1, errors: [] });
  const { watchReports } = await vi.importActual<typeof import("./reports")>("./reports");
  const received = vi.fn();
  const stop = watchReports(received, error => { throw error; });
  try {
    const empty = { metadata: { fromCache: false, hasPendingWrites: false }, docs: [] };
    m.snapshots.get("users/u/meetings")!(empty);
    m.snapshots.get("users/u/reports")!(empty);
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(3));
    expect(received.mock.calls.at(-1)?.[0]).toMatchObject([{ id: "r", home }]);
    expect(await local.getLocal("u", "r", { index: "meetings" })).toMatchObject({ report: { transcription: "Archivtext" }, dirty: true });
  } finally { stop(); }
});
