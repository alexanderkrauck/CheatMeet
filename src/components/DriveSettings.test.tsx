import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

const m = vi.hoisted(() => ({
  cursor: 0,
  values: [] as any[],
  owner: "u",
  events: [] as string[],
  switchAt: "",
  db: new Map<string, any>(),
  beforeCommit: undefined as (() => void) | undefined,
  reports: [] as ReportData[],
  token: "token" as string | null,
}));
function boundary(name: string) {
  m.events.push(name);
  if (m.switchAt === name) m.owner = "other";
}
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: any) => {
    const n = m.cursor++;
    if (!(n in m.values))
      m.values[n] = typeof initial === "function" ? initial() : initial;
    return [
      m.values[n],
      (value: any) => {
        m.values[n] = value;
      },
    ];
  },
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
    getSnapshot(),
}));
vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: async (key: string) => {
    const value = m.db.get(key);
    boundary("read");
    return value;
  },
  set: async (key: string, value: any) => {
    const before = m.beforeCommit;
    m.beforeCommit = undefined;
    before?.();
    m.db.set(key, structuredClone(value));
    boundary("write");
  },
  update: async (key: string, change: (value: any) => any) => {
    const before = m.beforeCommit;
    m.beforeCommit = undefined;
    before?.();
    m.db.set(key, structuredClone(change(m.db.get(key))));
    boundary("write");
  },
}));
vi.mock("../lib/reports", () => ({ uid: () => m.owner }));
vi.mock("../lib/session", () => ({
  driveToken: () => m.token,
  subscribeDriveSession: () => () => {},
  ensureDriveToken: async () => {
    boundary("token");
    return m.token;
  },
  connectGoogle: async () => {
    boundary("connect");
    return "token";
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../lib/driveSettings", () => ({
  savedDriveFolder: () => null,
  loadDriveFolder: vi.fn(),
  saveDriveFolder: vi.fn(),
  chooseDriveFolder: vi.fn(),
  getRootFolder: async () => {
    boundary("root");
    return "root";
  },
}));
vi.mock("../lib/drive", () => ({
  DEFAULT_FOLDER_NAME: "Meetings",
  findOrCreateRootFolder: vi.fn(),
  listDriveReports: async () => {
    boundary("list");
    return { reports: m.reports, warnings: [] };
  },
}));
vi.mock("../lib/providerSettings", () => ({
  savedMeetingHome: () => null,
  saveMeetingHome: vi.fn(),
  loadProviderSettings: vi.fn(),
}));
import DriveSettings from "./DriveSettings";
import { saveMeetingHome } from "../lib/providerSettings";

const report = (id = "r"): ReportData => ({
  id,
  title: "Archiv",
  date: "2026-11-01",
  updatedAt: "v1",
  summary: "Bericht",
  transcription: "Gespeicherter Text",
  todos: [],
  takeaways: [],
  driveFolderId: "folder",
  driveReportId: "json",
});
const walk = (node: any): any[] =>
  Array.isArray(node)
    ? node.flatMap(walk)
    : node?.props
      ? [node, ...walk(node.props.children)]
      : [];
async function recover(onImported = vi.fn()) {
  m.cursor = 0;
  const nodes = walk(DriveSettings({ onImported }));
  nodes
    .find(
      (n) =>
        n.type === "button" &&
        n.props.children === "Berichte aus Drive wiederherstellen",
    )
    .props.onClick();
  await vi.waitFor(() => expect(m.values[1]).toBe(false));
  return onImported;
}
beforeEach(() => {
  vi.clearAllMocks();
  m.cursor = 0;
  m.values = [];
  m.owner = "u";
  m.events = [];
  m.switchAt = "";
  m.db.clear();
  m.beforeCommit = undefined;
  m.reports = [report()];
  m.token = "token";
});

it("discloses archive recovery without burying the everyday folder and default actions", () => {
  const nodes = walk(DriveSettings({}));
  const advanced = nodes.find((n) => n.type === "details");
  expect(advanced).toBeDefined();
  const advancedNodes = walk(advanced);
  expect(
    advancedNodes.some(
      (n) =>
        n.type === "button" &&
        n.props.children === "Berichte aus Drive wiederherstellen",
    ),
  ).toBe(true);
  expect(
    advancedNodes.some(
      (n) =>
        n.type === "button" && n.props.children === "Standardordner verwenden",
    ),
  ).toBe(true);
  const primary = nodes.filter(
    (n) => n.type === "button" && !advancedNodes.includes(n),
  );
  expect(
    primary.some(
      (n) =>
        n.props["aria-label"] === "Google Drive als Standardspeicher verwenden",
    ),
  ).toBe(true);
  expect(
    primary.some((n) => n.props["aria-label"] === "Ordner auswählen"),
  ).toBe(true);
});

it("offers a direct connect action when Google access is not currently available", () => {
  m.token = null;
  const nodes = walk(DriveSettings({}));
  const advancedNodes = walk(nodes.find((n) => n.type === "details"));
  const connect = nodes.find(
    (n) => n.type === "button" && n.props.children === "Google Drive verbinden",
  );
  expect(connect).toBeDefined();
  expect(advancedNodes).not.toContain(connect);
});

it("keeps a long folder name intact and the external folder action separate", () => {
  const name =
    "Archiv – Jahresplanung und ausführliche Besprechungen mit dem gesamten Projektteam ".repeat(
      3,
    );
  m.values[0] = { id: "folder/with spaces", name };
  const nodes = walk(DriveSettings({}));
  expect(
    nodes.some((n) => n.type === "strong" && n.props.children === name),
  ).toBe(true);
  expect(
    nodes.find(
      (n) =>
        n.type === "a" &&
        n.props["aria-label"] === "Speicherordner in Google Drive öffnen",
    )?.props.href,
  ).toBe("https://drive.google.com/drive/folders/folder%2Fwith%20spaces");
});

it("retains the setup readiness gate without showing an unconfirmed default as selected", () => {
  const nodes = walk(DriveSettings({ defaultSelectionDisabled: true }));
  const choice = nodes.find(
    (n) =>
      n.type === "button" &&
      n.props["aria-label"] === "Google Drive als Standardspeicher verwenden",
  );
  expect(choice.props.disabled).toBe(true);
  expect(choice.props["aria-pressed"]).toBe(false);
});

it("selects Google for a meeting without exposing archive management or saving a future default", async () => {
  const onSelected = vi.fn();
  const nodes = walk(DriveSettings({ meetingOnly: true, onSelected }));
  expect(nodes.some((n) => n.type === "details")).toBe(false);
  const buttons = nodes.filter((n) => n.type === "button");
  expect(buttons).toHaveLength(1);
  buttons[0].props.onClick();
  await vi.waitFor(() => expect(m.values[1]).toBe(false));
  expect(onSelected).toHaveBeenCalledOnce();
  expect(saveMeetingHome).not.toHaveBeenCalled();
  expect(m.values[2]).toBe("Google Drive für dieses Meeting gewählt.");
});

it("does not select a meeting home after authorization changed the owner", async () => {
  m.switchAt = "token";
  const onSelected = vi.fn();
  const nodes = walk(DriveSettings({ meetingOnly: true, onSelected }));
  nodes.find((n) => n.type === "button").props.onClick();
  await vi.waitFor(() => expect(m.values[1]).toBe(false));
  expect(onSelected).not.toHaveBeenCalled();
  expect(saveMeetingHome).not.toHaveBeenCalled();
  expect(m.values[2]).toContain("Konto");
});

it("retains the explicit future-default operation and selection callback", async () => {
  const onSelected = vi.fn();
  const nodes = walk(DriveSettings({ onSelected }));
  nodes
    .find(
      (n) =>
        n.type === "button" &&
        n.props["aria-label"] === "Google Drive als Standardspeicher verwenden",
    )
    .props.onClick();
  await vi.waitFor(() => expect(m.values[1]).toBe(false));
  expect(saveMeetingHome).toHaveBeenCalledExactlyOnceWith(null);
  expect(onSelected).toHaveBeenCalledOnce();
  expect(m.values[2]).toContain("Bestehende Meetings bleiben unverändert.");
});

it("retains a concurrent local edit when bulk restore commits after its read", async () => {
  m.db.set("u:report:r", {
    report: { ...report(), transcription: "" },
    dirty: false,
  });
  const newer = {
    report: { ...report(), title: "Neue Bearbeitung", updatedAt: "v2" },
    dirty: true,
  };
  m.beforeCommit = () => m.db.set("u:report:r", structuredClone(newer));
  await recover();
  expect(m.db.get("u:report:r")).toEqual(newer);
  expect(m.values[2]).toContain("0 Bericht(e)");
  expect(m.values[2]).toContain("1 neuere");
});

it.each(["token", "connect", "root", "list", "read", "write"])(
  "stops the pinned restore after the %s boundary changes owner",
  async (at) => {
    m.switchAt = at;
    if (at === "connect") m.token = null;
    m.reports.push(report("second"));
    const imported = await recover();
    expect(imported).not.toHaveBeenCalled();
    expect(m.values[2]).toContain("Konto");
    expect(m.events.at(-1)).toBe(at);
    expect(m.db.has("u:report:second")).toBe(false);
  },
);

it("keeps an archive-only Google recovery dirty without claiming index acknowledgement", async () => {
  await recover();
  expect(m.db.get("u:report:r")).toMatchObject({
    report: report(),
    dirty: true,
  });
});

it("restores a Google archive beside a dirty same-ID Microsoft report", async () => {
  const sibling = {
    report: {
      ...report(),
      home: {
        provider: "microsoft",
        connectionId: "c",
        driveId: "d",
        rootId: "root",
        rootName: "Meetings",
      },
    },
    dirty: true,
  };
  m.db.set("u:microsoft:report:r", structuredClone(sibling));
  await recover();
  expect(m.db.get("u:report:r")).toMatchObject({
    report: report(),
    dirty: true,
  });
  expect(m.db.get("u:microsoft:report:r")).toEqual(sibling);
});
