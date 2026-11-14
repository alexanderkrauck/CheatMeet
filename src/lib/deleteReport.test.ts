import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[], effects: [] as (() => void)[] }));
const scoped = vi.hoisted(() => ({ draft: vi.fn(), local: vi.fn(), oneDrive: vi.fn(), job: vi.fn(), clear: vi.fn(), forget: vi.fn() }));
vi.mock("./onedrive", () => ({ trashOneDrive: scoped.oneDrive }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useRef: (initial: unknown) => { const n = hooks.cursor++; return hooks.values[n] ||= { current: initial }; },
    useState: (initial: unknown) => { const n = hooks.cursor++; if (!(n in hooks.values)) hooks.values[n] = initial; return [hooks.values[n], (value: unknown) => { hooks.values[n] = value; }]; },
    useEffect: (effect: () => void) => { hooks.effects.push(effect); },
  };
});
vi.mock("react-dom", () => ({ createPortal: (children: unknown) => children }));
vi.mock("./reports", () => ({ uid: () => "u1" }));
const calls: string[] = [];
let cloudWait: Promise<void> | undefined;
let driveFails = false;
let firestoreFails = false;
let token: string | null = "t";
let forgetFails = false;

vi.mock("./pipeline", () => ({ jobFor: scoped.job, clearJob: scoped.clear }));
vi.mock("./serverProcessing", () => ({ forgetServerProcessing: async (...args:unknown[]) => {
  scoped.forget(...args);
  if (forgetFails) throw new Error("Dieses Meeting wird noch verarbeitet.");
  calls.push("forget:r1");
} }));

vi.mock("./firebase", () => ({ db: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  deleteDoc: async (path: string) => {
    if (cloudWait) await cloudWait;
    if (firestoreFails) throw new Error("offline");
    calls.push(`firestore:${path}`);
  },
}));
vi.mock("./drive", () => ({
  trashDriveFile: async (id: string) => {
    if (driveFails)
      throw new Error("Der Drive-Ordner konnte nicht gelöscht werden (500).");
    calls.push(`drive:${id}`);
  },
}));
vi.mock("./local", () => ({
  getLocal: async () => undefined,
  deleteDraft: async (u: string, id: string, options?: unknown) => { scoped.draft(u, id, options); calls.push(`draft:${id}`); },
  dropLocal: async (u: string, id: string, options?: unknown) => { scoped.local(u, id, options); calls.push(`local:${id}`); },
}));
vi.mock("./session", () => ({ ensureDriveToken: async () => token }));

const { deleteReport } = await import("./deleteReport");

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: "2026-09-14T08:00:00.000Z",
  title: "Weekly",
  summary: "",
  transcription: "",
  todos: [],
  takeaways: [],
  driveFolderId: "folder-1",
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  cloudWait = undefined;
  hooks.cursor = 0; hooks.values = []; hooks.effects = [];
  driveFails = false;
  firestoreFails = false;
  token = "t";
  forgetFails = false;
  scoped.draft.mockClear(); scoped.local.mockClear(); scoped.oneDrive.mockReset().mockResolvedValue(undefined);
  scoped.job.mockReset();scoped.clear.mockClear();scoped.forget.mockClear();
});

it("locks pending deletion against Cancel/Escape/re-entry and restores the visible collapsed-menu trigger", async () => {
  const DeleteMeeting = (await import("../components/DeleteMeeting")).default;
  vi.stubGlobal("document", { body: {} });
  const onDeleted = vi.fn();
  const focus = vi.fn();
  const summary = { isConnected: true, focus, closest: () => null, getClientRects: () => [{}], hasAttribute: () => false, tagName: "SUMMARY" };
  const trigger = { closest: () => ({ querySelector: () => summary }), isConnected: true };
  const walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : [];
  const render = () => { hooks.cursor = 0; return walk(DeleteMeeting({ id: "r1", title: "Weekly", onDeleted })); };
  let nodes = render();
  const dialog = nodes.find(n => n.type === "dialog");
  const listeners = new Map<string, () => void>();
  const native = { showModal: vi.fn(), close: vi.fn(() => listeners.get("close")?.()), addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: vi.fn() };
  dialog.props.ref.current = native;
  hooks.effects.forEach(effect => effect()); hooks.effects = [];
  nodes.find(n => n.type === "button" && n.props.className === "danger").props.onClick({ currentTarget: trigger });
  let release!: () => void;
  cloudWait = new Promise(resolve => { release = resolve; });
  nodes.find(n => n.type === "button" && n.props.className === "btn btn-danger").props.onClick();
  nodes = render();
  expect(nodes.find(n => n.type === "button" && n.props.children === "Abbrechen").props.disabled).toBe(true);
  const preventDefault = vi.fn();
  nodes.find(n => n.type === "dialog").props.onCancel({ preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  nodes.find(n => n.type === "button" && n.props.className === "btn btn-danger").props.onClick();
  release();
  await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  expect(calls.filter(c => c.startsWith("firestore:"))).toHaveLength(1);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(onDeleted).toHaveBeenCalledWith({ removed: true, warnings: [] });
  vi.unstubAllGlobals();
});

describe("deleteReport", () => {
  it.each(["reports", "meetings"] as const)("scopes draft and report cleanup to the selected %s namespace", async index => {
    const home = { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings", folderId: "ms-folder" };
    const selected = report(index === "meetings" ? { home, driveFolderId: undefined } : {});
    expect(await deleteReport("u1", selected, { fromDrive: true })).toEqual({ removed: true, warnings: [] });
    expect(scoped.job).toHaveBeenCalledWith(selected.id,selected);
    expect(scoped.forget).toHaveBeenCalledWith('u1',selected.id,selected);
    expect(scoped.clear).toHaveBeenCalledWith(selected.id,selected);
    expect(scoped.draft).toHaveBeenCalledWith("u1", "r1", { index });
    expect(scoped.local).toHaveBeenCalledWith("u1", "r1", { index });
    expect(calls).toContain(`firestore:users/u1/${index}/r1`);
    if (index === "meetings") {
      expect(scoped.oneDrive).toHaveBeenCalledWith(home, "ms-folder");
      expect(calls.some(call => call.startsWith("drive:"))).toBe(false);
    } else expect(scoped.oneDrive).not.toHaveBeenCalled();
  });
  it("does not touch archives or indexes if the processing job cannot be safely forgotten", async () => {
    forgetFails = true;
    const result = await deleteReport("u1", report(), { fromDrive: true });
    expect(result).toEqual({ removed: false, warnings: ["Dieses Meeting wird noch verarbeitet."] });
    expect(calls).toEqual([]);
    forgetFails = false;
  });
  it("removes the meeting from all three stores", async () => {
    const result = await deleteReport("u1", report(), { fromDrive: true });
    expect(result).toMatchObject({ removed: true, warnings: [] });
    expect(calls).toEqual([
      "forget:r1",
      "drive:folder-1",
      "firestore:users/u1/reports/r1",
      "draft:r1",
      "local:r1",
    ]);
  });

  it("leaves Drive alone when the user kept the files", async () => {
    await deleteReport("u1", report(), { fromDrive: false });
    expect(calls.some((c) => c.startsWith("drive:"))).toBe(false);
    expect(calls).toContain("local:r1");
  });

  it("keeps everything when Drive refuses, so the delete can be retried", async () => {
    driveFails = true;
    const result = await deleteReport("u1", report(), { fromDrive: true });
    expect(result).toMatchObject({ removed: false });
    expect(result.warnings[0]).toContain("Drive-Ordner");
    // Dropping the local copy here would throw away the folder id and strand
    // the Drive files forever.
    expect(calls).toEqual(["forget:r1"]);
  });

  it("does not claim a Drive delete it could not even attempt", async () => {
    token = null;
    const result = await deleteReport("u1", report(), { fromDrive: true });
    expect(result.warnings[0]).toContain("nicht verbunden");
    expect(calls).toEqual(["forget:r1"]);
  });

  it("says so when Drive was asked for but no folder is known", async () => {
    const result = await deleteReport(
      "u1",
      report({ driveFolderId: undefined }),
      {
        fromDrive: true,
      },
    );
    expect(result.warnings[0]).toContain("kein Drive-Ordner");
    expect(calls).toEqual(["forget:r1"]);
  });

  it("warns that a failed cloud delete can resurface on another device", async () => {
    firestoreFails = true;
    const result = await deleteReport("u1", report(), { fromDrive: true });
    // Removed locally even though the cloud entry survives — the caller must
    // be able to tell that apart from "nothing happened".
    expect(result.removed).toBe(true);
    expect(result.warnings[0]).toContain("anderen Gerät");
    expect(calls).toContain("local:r1");
  });

  it("removes a meeting that never reached Drive when Drive was not asked for", async () => {
    const result = await deleteReport(
      "u1",
      report({ driveFolderId: undefined }),
      {
        fromDrive: false,
      },
    );
    expect(result.warnings).toEqual([]);
    expect(calls).toEqual([
      "forget:r1",
      "firestore:users/u1/reports/r1",
      "draft:r1",
      "local:r1",
    ]);
  });
});
