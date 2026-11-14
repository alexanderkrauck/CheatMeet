import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

const written: { path: string; data: Record<string, unknown> }[] = [];
const local: ReportData[] = [];
let cached: { report: ReportData; dirty: boolean }[] = [];
const snapshots = new Map<string, (snapshot: any) => void>();
const remoteDocs = new Map<string, ReportData>();
let cloudWriteWait: Promise<void> | undefined;

vi.mock("./firebase", () => ({ auth: { currentUser: { uid: "u1" } }, db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  collection: (_db: unknown, ...path: string[]) => path.join("/"),
  onSnapshot: (path: string, _options: unknown, callback: (snapshot: any) => void) => {
    snapshots.set(path, callback);
    return () => snapshots.delete(path);
  },
  getDocFromServer: vi.fn(async (path: string) => ({ exists: () => remoteDocs.has(path), data: () => remoteDocs.get(path), id: path.split("/").at(-1) })),
  setDoc: async (path: string, data: Record<string, unknown>) => {
    if (cloudWriteWait) await cloudWriteWait;
    written.push({ path, data });
  },
}));
vi.mock("./local", () => ({
  putLocal: vi.fn(async (_u: string, report: ReportData, _dirty?: boolean, _expected?: string | null) => void local.push(report)),
  listLocal: async () => cached,
  getLocal: vi.fn(async (_owner: string, id: string, options?: { index: "reports" | "meetings" }) => cached.find(v => v.report.id === id && (!options || (v.report.home ? "meetings" : "reports") === options.index))),
  acceptRemoteReport: async (_owner: string, report: ReportData) => {
    const same = (v: { report: ReportData }) => v.report.id === report.id && !!v.report.home === !!report.home;
    if (cached.some(v => same(v) && v.dirty)) return;
    cached = [...cached.filter(v => !same(v)), { report, dirty: false }];
  },
  dropLocal: vi.fn(async (_owner: string, id: string, options?: { onlyIfClean?: boolean; index?: string }) => {
    cached = cached.filter(v => v.report.id !== id || options?.onlyIfClean && v.dirty);
  }),
  watchLocalReports: () => () => {},
}));
vi.mock("./people", () => ({ rememberPeople: async () => {} }));

const { saveReport, getReport, watchReports, reportHref, reportForDrop } = await import("./reports");

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: "2026-09-15T12:00:00.000Z",
  title: "Weekly Sync",
  summary: "Roadmap besprochen.",
  transcription: "Jedes gesprochene Wort dieses Meetings.",
  speech: {
    provider: "assemblyai",
    phase: "final",
    languages: ["de"],
    speakerNames: {},
    turns: [
      {
        id: "mic:0:0",
        speaker: "mic:0:A",
        text: "Hallo",
        startMs: 0,
        endMs: 1000,
        final: true,
      },
    ],
  },
  todos: [],
  takeaways: [],
  driveReportId: "json-id",
  driveSyncedAt: "2026-09-15T12:00:00.000Z",
  ...over,
});

beforeEach(() => {
  written.length = 0;
  local.length = 0;
  cached = [];
  remoteDocs.clear();
  cloudWriteWait = undefined;
  snapshots.clear();
  vi.clearAllMocks();
});

describe("report recovery", () => {
  it("resolves the row's qualified calendar drop and rejects ambiguous legacy drops", () => {
    const google = report({ title: "Google" });
    const microsoft = report({ title: "Microsoft", home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } });
    const both = [microsoft, google];
    expect(reportForDrop(both, reportHref(google))).toBe(google);
    expect(reportForDrop(both, reportHref(microsoft))).toBe(microsoft);
    expect(() => reportForDrop(both, "r1")).toThrow(/mehrdeutig/);
    expect(reportForDrop([google], "r1")).toBe(google);
    expect(reportForDrop(both, "/report/r1?index=other")).toBeUndefined();
  });
  it("rejects cold ambiguous IDs before caching either provider and reads a qualified index only", async () => {
    const { getDocFromServer } = await import("firebase/firestore");
    const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" };
    remoteDocs.set("users/u1/reports/r1", report({ title: "Google" }));
    remoteDocs.set("users/u1/meetings/r1", report({ title: "Microsoft", home }));
    await expect(getReport("u1", "r1")).rejects.toThrow(/mehrdeutig/);
    expect(cached).toEqual([]);
    vi.mocked(getDocFromServer).mockClear();
    expect((await getReport("u1", "r1", { index: "reports" }))?.report.title).toBe("Google");
    expect(vi.mocked(getDocFromServer).mock.calls.map(c => c[0])).toEqual(["users/u1/reports/r1"]);
    expect((await getReport("u1", "r1", { index: "meetings" }))?.report.title).toBe("Microsoft");
    expect(cached.map(v => v.report.title).sort()).toEqual(["Google", "Microsoft"]);
  });
  it("reconciles only authoritative provider-scoped omissions while retaining dirty edits", async () => {
    const { dropLocal } = await import("./local");
    const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" };
    cached = [
      { report: report({ id: "clean" }), dirty: false },
      { report: report({ id: "edit" }), dirty: true },
      { report: report({ id: "ms", home }), dirty: false },
    ];
    const onData = vi.fn();
    const stop = watchReports(onData, error => { throw error; });
    try {
      snapshots.get("users/u1/reports")!({ metadata: { fromCache: true, hasPendingWrites: false }, docs: [] });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(dropLocal).not.toHaveBeenCalled();
      snapshots.get("users/u1/reports")!({ metadata: { fromCache: false, hasPendingWrites: false }, docs: [] });
      await vi.waitFor(() => expect(cached.map(v => v.report.id)).toEqual(["edit", "ms"]));
      expect(dropLocal).toHaveBeenCalledWith("u1", "clean", { onlyIfClean: true, index: "reports", expectedUpdatedAt: null });
      expect(onData.mock.calls.at(-1)?.[1]).toEqual(["/report/edit?index=reports"]);
    } finally { stop(); }
  });
  it("opens a cold per-ID Microsoft index without scanning either collection or overwriting a dirty local copy", async () => {
    const { getDocFromServer } = await import("firebase/firestore");
    const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", folderId: "f", reportId: "j" };
    remoteDocs.set("users/u1/meetings/r1", report({ home, transcription: "" }));
    expect((await getReport("u1", "r1"))?.report.home).toEqual(home);
    expect(vi.mocked(getDocFromServer).mock.calls.map(c => c[0])).toEqual(["users/u1/reports/r1", "users/u1/meetings/r1"]);
    cached = [{ report: report({ title: "Unsynced edit" }), dirty: true }];
    expect((await getReport("u1", "r1"))?.report.title).toBe("Unsynced edit");
    expect(getDocFromServer).toHaveBeenCalledTimes(2);
    await expect(getReport("other-owner", "r1")).rejects.toThrow("Konto");
  });
});

describe("saveReport", () => {
  it("does not recreate a removed cache from a late save acknowledgement", async () => {
    let release!: () => void;
    cloudWriteWait = new Promise(resolve => { release = resolve; });
    const saving = saveReport(report());
    await vi.waitFor(() => expect(local).toHaveLength(1));
    cached = []; // A confirmed delete has removed the cache while the write was pending.
    release();
    await saving;
    expect(cached).toEqual([]);
  });
  it("passes the optional base revision into the atomic local write and stops on conflicts", async () => {
    const { putLocal } = await import("./local");
    const conflict = Object.assign(new Error("Neuerer Bericht"), { name: "ReportConflictError" });
    vi.mocked(putLocal).mockRejectedValueOnce(conflict);
    await expect(saveReport(report(), { expectedUpdatedAt: "base-v1" })).rejects.toBe(conflict);
    expect(putLocal).toHaveBeenLastCalledWith("u1", expect.any(Object), true, "base-v1");
    expect(written).toEqual([]);
  });
  it("writes Microsoft only to the new index with explicit home references",async()=>{
    const home={provider:"microsoft" as const,connectionId:"c",driveId:"d",rootId:"root",rootName:"Meetings",folderId:"f",reportId:"j"};
    await saveReport(report({home,driveReportId:undefined,driveSyncedAt:undefined}));
    expect(written[0].path).toBe("users/u1/meetings/r1");expect(written[0].data.home).toEqual(home);expect(written[0].data.speech).toBeUndefined();
  });
  it("sends the cloud an index, never the transcript", async () => {
    await saveReport(report());

    expect(written).toHaveLength(1);
    const data = written[0].data;
    // The two unbounded fields are what would eventually break syncing.
    expect(data.transcription).toBe("");
    expect(data).not.toHaveProperty("speech");
    // Everything a second device needs to find the real copy survives.
    expect(data.driveReportId).toBe("json-id");
    expect(data.transcriptChars).toBe(
      "Jedes gesprochene Wort dieses Meetings.".length,
    );
    expect(written[0].path).toBe("users/u1/reports/r1");
  });

  it("keeps the whole meeting on the device that recorded it", async () => {
    await saveReport(report());

    expect(local).toHaveLength(1);
    expect(local[0].transcription).toBe(
      "Jedes gesprochene Wort dieses Meetings.",
    );
    expect(local[0].speech?.turns).toHaveLength(1);
  });

  it("carries the consent record to the other device", async () => {
    await saveReport(
      report({
        consent: {
          version: 1,
          templateVersion: "1",
          facts: {
            language: "de",
            address: "du",
            sources: ["mic"],
            processors: [],
            storage: { service: "Google Drive", folder: "Ordner" },
            recipients: [],
            retention: { audioDays: 30, textDays: null },
          },
          parts: null,
          text: "Hinweis",
          obtainedAt: "2026-09-15T11:59:00.000Z",
          method: "spoken",
          participants: [{ name: "Sergio", stance: "agreed" as const }],
        },
      }),
    );

    // The deletion deadline travels with it, so any device can enforce it.
    expect(written[0].data.consent).toMatchObject({
      obtainedAt: "2026-09-15T11:59:00.000Z",
    });
  });
});
