import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";
const m = vi.hoisted(() => ({ cursor: 0, values: [] as any[], records: new Map<string, ReportData>(), read: vi.fn(), remove: vi.fn(), owner: "u" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const n = m.cursor++; return m.values[n] ||= { current: initial }; },
  useState: (initial: unknown) => { const n = m.cursor++; if (!(n in m.values)) m.values[n] = initial; return [m.values[n], (value: unknown) => { m.values[n] = value; }]; },
  useEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (children: unknown) => children }));
vi.mock("../lib/firebase", () => ({ auth: { get currentUser() { return { uid: m.owner }; } } }));
vi.mock("../lib/local", () => ({ getLocal: m.read }));
vi.mock("../lib/deleteReport", () => ({ deleteReport: m.remove }));
vi.mock("../lib/session", () => ({ errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
import DeleteMeeting from "./DeleteMeeting";
afterEach(() => vi.unstubAllGlobals());
const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", folderId: "ms-folder", reportId: "ms-json" };
const google: ReportData = { id: "r", title: "Google", date: "2026-11-01", summary: "", transcription: "", todos: [], takeaways: [], driveFolderId: "g-folder" };
const microsoft = { ...google, title: "Microsoft", driveFolderId: undefined, home };
const walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : [];
async function confirm(selected: ReportData, fromDrive = true) {
  const onDeleted = vi.fn();
  const render = () => { m.cursor = 0; return walk(DeleteMeeting({ id: selected.id, title: selected.title, driveFolderId: selected.driveFolderId, home: selected.home, onDeleted })); };
  let nodes = render();
  if (fromDrive) nodes.find(n => n.type === "input").props.onChange({ target: { checked: true } });
  nodes = render();
  nodes.find(n => n.type === "button" && n.props.className === "btn btn-danger").props.onClick();
  await vi.waitFor(() => expect(m.values[4]).toBe(false));
  return onDeleted;
}
beforeEach(() => {
  vi.stubGlobal("document", { body: {} });
  m.cursor = 0; m.values = []; m.owner = "u"; m.records.clear();
  m.records.set("reports", google); m.records.set("meetings", microsoft);
  m.read.mockReset().mockImplementation(async (_u: string, _id: string, options?: { index: string }) => {
    const report = m.records.get(options?.index || "meetings");
    return report && { report, dirty: true };
  });
  m.remove.mockReset().mockResolvedValue({ removed: true, warnings: [] });
});
it.each([google, microsoft])("deletes the clicked $title row rather than the same-ID sibling", async selected => {
  const deleted = await confirm(selected);
  expect(m.read).toHaveBeenCalledWith("u", "r", { index: selected.home ? "meetings" : "reports" });
  expect(m.remove).toHaveBeenCalledWith("u", expect.objectContaining({ title: selected.title, driveFolderId: selected.driveFolderId }), { fromDrive: true });
  expect(m.remove.mock.calls[0][1].home).toEqual(selected.home);
  expect(deleted).toHaveBeenCalledOnce();
});
it.each([
  [google, microsoft],
  [google, { ...google, driveFolderId: "different" }],
  [microsoft, { ...microsoft, home: { ...home, driveId: "different" } }],
  [microsoft, { ...microsoft, home: { ...home, folderId: "different" } }],
])("rejects mismatched stored binding instead of replacing the clicked archive", async (selected, stored) => {
  m.read.mockResolvedValue({ report: stored, dirty: false });
  const deleted = await confirm(selected);
  expect(m.remove).not.toHaveBeenCalled();
  expect(deleted).not.toHaveBeenCalled();
  expect(m.values[5]).toMatch(/Speicherort|Archiv/);
});
it("retains the row binding when that exact local namespace is absent", async () => {
  m.records.delete("reports");
  await confirm(google);
  expect(m.remove).toHaveBeenCalledWith("u", expect.objectContaining({ driveFolderId: "g-folder" }), { fromDrive: true });
  expect(m.remove.mock.calls[0][1].home).toBeUndefined();
});
it("does not start deletion after the local read changes the owner", async () => {
  m.read.mockImplementation(async () => { m.owner = "other"; return { report: google, dirty: true }; });
  await confirm(google);
  expect(m.remove).not.toHaveBeenCalled();
});
