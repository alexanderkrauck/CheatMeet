import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

const m = vi.hoisted(() => ({
  cursor: 0, values: [] as any[], owner: "u", events: [] as string[], switchAt: "",
  db: new Map<string, any>(), beforeCommit: undefined as (() => void) | undefined,
  reports: [] as ReportData[], token: "token" as string | null,
}));
function boundary(name: string) {
  m.events.push(name);
  if (m.switchAt === name) m.owner = "other";
}
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: any) => { const n = m.cursor++; if (!(n in m.values)) m.values[n] = typeof initial === "function" ? initial() : initial; return [m.values[n], (value: any) => { m.values[n] = value; }]; },
  useEffect: () => {},
}));
vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: async (key: string) => { const value = m.db.get(key); boundary("read"); return value; },
  set: async (key: string, value: any) => { const before = m.beforeCommit; m.beforeCommit = undefined; before?.(); m.db.set(key, structuredClone(value)); boundary("write"); },
  update: async (key: string, change: (value: any) => any) => { const before = m.beforeCommit; m.beforeCommit = undefined; before?.(); m.db.set(key, structuredClone(change(m.db.get(key)))); boundary("write"); },
}));
vi.mock("../lib/reports", () => ({ uid: () => m.owner }));
vi.mock("../lib/session", () => ({
  ensureDriveToken: async () => { boundary("token"); return m.token; },
  connectGoogle: async () => { boundary("connect"); return "token"; },
  errorMessage: (e: unknown) => e instanceof Error ? e.message : String(e),
}));
vi.mock("../lib/driveSettings", () => ({
  savedDriveFolder: () => null, loadDriveFolder: vi.fn(), saveDriveFolder: vi.fn(), chooseDriveFolder: vi.fn(),
  getRootFolder: async () => { boundary("root"); return "root"; },
}));
vi.mock("../lib/drive", () => ({
  DEFAULT_FOLDER_NAME: "Meetings", findOrCreateRootFolder: vi.fn(),
  listDriveReports: async () => { boundary("list"); return { reports: m.reports, warnings: [] }; },
}));
vi.mock("../lib/providerSettings", () => ({ savedMeetingHome: () => null, saveMeetingHome: vi.fn(), loadProviderSettings: vi.fn() }));
import DriveSettings from "./DriveSettings";

const report = (id = "r"): ReportData => ({ id, title: "Archiv", date: "2026-11-01", updatedAt: "v1", summary: "Bericht", transcription: "Gespeicherter Text", todos: [], takeaways: [], driveFolderId: "folder", driveReportId: "json" });
const walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : [];
async function recover(onImported = vi.fn()) {
  m.cursor = 0;
  const nodes = walk(DriveSettings({ onImported }));
  nodes.find(n => n.type === "button" && n.props.children === "Berichte aus Drive wiederherstellen").props.onClick();
  await vi.waitFor(() => expect(m.values[1]).toBe(false));
  return onImported;
}
beforeEach(() => { m.cursor = 0; m.values = []; m.owner = "u"; m.events = []; m.switchAt = ""; m.db.clear(); m.beforeCommit = undefined; m.reports = [report()]; m.token = "token"; });

it("retains a concurrent local edit when bulk restore commits after its read", async () => {
  m.db.set("u:report:r", { report: { ...report(), transcription: "" }, dirty: false });
  const newer = { report: { ...report(), title: "Neue Bearbeitung", updatedAt: "v2" }, dirty: true };
  m.beforeCommit = () => m.db.set("u:report:r", structuredClone(newer));
  await recover();
  expect(m.db.get("u:report:r")).toEqual(newer);
  expect(m.values[2]).toContain("0 Bericht(e)");
  expect(m.values[2]).toContain("1 neuere");
});

it.each(["token", "connect", "root", "list", "read", "write"])("stops the pinned restore after the %s boundary changes owner", async at => {
  m.switchAt = at;
  if (at === "connect") m.token = null;
  m.reports.push(report("second"));
  const imported = await recover();
  expect(imported).not.toHaveBeenCalled();
  expect(m.values[2]).toContain("Konto");
  expect(m.events.at(-1)).toBe(at);
  expect(m.db.has("u:report:second")).toBe(false);
});

it("keeps an archive-only Google recovery dirty without claiming index acknowledgement", async () => {
  await recover();
  expect(m.db.get("u:report:r")).toMatchObject({ report: report(), dirty: true });
});

it("restores a Google archive beside a dirty same-ID Microsoft report", async () => {
  const sibling = { report: { ...report(), home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } }, dirty: true };
  m.db.set("u:microsoft:report:r", structuredClone(sibling));
  await recover();
  expect(m.db.get("u:report:r")).toMatchObject({ report: report(), dirty: true });
  expect(m.db.get("u:microsoft:report:r")).toEqual(sibling);
});
