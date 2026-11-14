import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

const db = vi.hoisted(() => new Map<string, unknown>());
vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: async (key: string) => db.get(key),
  set: async (key: string, value: unknown) => {
    db.set(key, structuredClone(value));
  },
  del: async (key: string) => {
    db.delete(key);
  },
  keys: async () => [...db.keys()],
  getMany: async (keys: string[]) => keys.map(key => db.get(key)),
  setMany: async (entries: [string, unknown][]) => { for (const [key, value] of entries) db.set(key, structuredClone(value)); },
  delMany: async (keys: string[]) => { for (const key of keys) db.delete(key); },
  // An IDB readwrite transaction serializes reads and writes from competing tabs.
  update: async (key: string, change: (value: unknown) => unknown) => {
    db.set(key, structuredClone(change(db.get(key))));
  },
}));
import { deleteDraft, dropLocal, getDraft, getLocal, putLocal, watchLocalReports } from "./local";
const report = (updatedAt?: string): ReportData => ({
  id: "r",
  title: "Test",
  date: "2026-11-14",
  updatedAt,
  summary: "",
  transcription: "Text",
  todos: [],
  takeaways: [],
});
beforeEach(() => db.clear());

it("atomically rejects a competing revision without broadcasting or overwriting, in both provider namespaces", async () => {
  for (const home of [
    undefined,
    {
      provider: "microsoft" as const,
      connectionId: "c",
      driveId: "d",
      rootId: "root",
      rootName: "Meetings",
    },
  ]) {
    db.clear();
    const base = { ...report("v1"), home };
    await putLocal("u", base, false, null);
    const changed = vi.fn();
    const stop = watchLocalReports("u", changed);
    const results = await Promise.allSettled([
      putLocal("u", { ...base, title: "First", updatedAt: "v2" }, true, "v1"),
      putLocal("u", { ...base, title: "Second", updatedAt: "v3" }, true, "v1"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.name).toBe(
      "ReportConflictError",
    );
    expect((await getLocal("u", "r"))?.report.title).toBe("First");
    expect(changed).toHaveBeenCalledOnce();
    expect([...db.keys()]).toEqual([
      home ? "u:microsoft:report:r" : "u:report:r",
    ]);
    stop();
  }
});

it("keeps unguarded calls compatible and treats null as no existing updatedAt", async () => {
  await putLocal("u", report(), false, null);
  await putLocal("u", report("v1"), false, null);
  await expect(putLocal("u", report("v2"), false, null)).rejects.toMatchObject({
    name: "ReportConflictError",
  });
  await putLocal("u", report("v3"));
  expect(await getLocal("u", "r")).toMatchObject({
    dirty: true,
    report: {
      updatedAt: "v3",
      transcriptRevision: expect.stringMatching(/^sha256:/),
    },
  });
});

it("only removes the exact clean provider revision from an authoritative missing-index snapshot", async () => {
  const google = report("v1");
  const ms = {
    ...google,
    home: {
      provider: "microsoft" as const,
      connectionId: "c",
      driveId: "d",
      rootId: "root",
      rootName: "Meetings",
    },
  };
  await putLocal("u", google, false);
  await putLocal("u", ms, true);
  await dropLocal("u", "r", {
    onlyIfClean: true,
    index: "meetings",
    expectedUpdatedAt: "v1",
  });
  expect(await getLocal("u", "r", { index: "meetings" })).toMatchObject({ report: ms, dirty: true });
  await dropLocal("u", "r", {
    onlyIfClean: true,
    index: "reports",
    expectedUpdatedAt: "older",
  });
  expect(db.get("u:report:r")).toBeTruthy();
  await dropLocal("u", "r", {
    onlyIfClean: true,
    index: "reports",
    expectedUpdatedAt: "v1",
  });
  expect(db.get("u:report:r")).toBeUndefined();
  expect(db.get("u:microsoft:report:r")).toBeTruthy();
  await dropLocal("u", "r");
  expect(await getLocal("u", "r")).toBeUndefined();
});

it("selects exactly one same-ID provider report and rejects ambiguous legacy reads", async () => {
  const google = report("v1");
  const microsoft = { ...report("v2"), home: { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } };
  await putLocal("u", google);
  await putLocal("u", microsoft);
  expect((await getLocal("u", "r", { index: "reports" }))?.report.home).toBeUndefined();
  expect((await getLocal("u", "r", { index: "meetings" }))?.report.home).toEqual(microsoft.home);
  await expect(getLocal("u", "r")).rejects.toThrow(/mehrdeutig/);
  await expect(dropLocal("u", "r")).rejects.toThrow(/mehrdeutig/);
  expect((await getLocal("u", "r", { index: "reports" }))?.report.updatedAt).toBe("v1");
  expect((await getLocal("u", "r", { index: "meetings" }))?.report.updatedAt).toBe("v2");
  await dropLocal("u", "r", { index: "reports" });
  expect(await getLocal("u", "r", { index: "reports" })).toBeUndefined();
  expect(await getLocal("u", "r", { index: "meetings" })).toBeTruthy();
  expect((await getLocal("u", "r"))?.report.home).toEqual(microsoft.home);
});

it("rejects ambiguous ID-specific draft recovery but permits a qualified draft", async () => {
  const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" };
  db.set("u:draft:r", { report: report("v1") });
  db.set("u:microsoft:draft:r", { report: { ...report("v2"), home } });
  await expect(getDraft("u", "r")).rejects.toThrow(/mehrdeutig/);
  expect((await getDraft("u", "r", true))?.report.home).toBeUndefined();
  expect((await getDraft("u:microsoft", "r", true))?.report.home).toEqual(home);
});

it.each(["reports", "meetings"] as const)("deletes only the selected %s draft, journal and active pointer for equal IDs", async index => {
  const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" };
  for (const [namespace, reportHome] of [["u", undefined], ["u:microsoft", home]] as const) {
    db.set(`${namespace}:draft:r`, { report: { ...report("2026-11-14"), home: reportHome } });
    db.set(`${namespace}:active-draft`, "r");
    db.set(`${namespace}:audio-chunk:r:0`, { sequence: 0, durationMs: 10, blob: new Blob(["audio"]) });
    db.set(`${namespace}:capture-progress:r`, { durationMs: 10 });
  }
  const selected = index === "reports" ? "u" : "u:microsoft";
  const other = index === "reports" ? "u:microsoft" : "u";
  await deleteDraft("u", "r", { index });
  expect(db.get(`${selected}:draft:r`)).toBeUndefined();
  expect(db.get(`${selected}:audio-chunk:r:0`)).toBeUndefined();
  expect(db.get(`${selected}:capture-progress:r`)).toBeUndefined();
  expect(db.get(`${selected}:active-draft`)).toBeUndefined();
  expect(db.get(`${other}:draft:r`)).toBeTruthy();
  expect(db.get(`${other}:audio-chunk:r:0`)).toBeTruthy();
  expect(db.get(`${other}:capture-progress:r`)).toBeTruthy();
  expect(db.get(`${other}:active-draft`)).toBe("r");
});
