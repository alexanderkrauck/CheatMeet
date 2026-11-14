import React from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";
import type { Workspace } from "../lib/useReports";

const h = vi.hoisted(() => ({
  auth: { currentUser: { uid: "A" } as { uid: string } | null },
  read: vi.fn(), save: vi.fn(), job: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("react-router-dom", () => ({ Link: "a" }));
vi.mock("../lib/firebase", () => ({ auth: h.auth }));
vi.mock("../lib/local", () => ({ getLocal: h.read }));
vi.mock("../lib/pipeline", () => ({ jobFor: h.job }));
vi.mock("../lib/reports", () => ({
  saveReport: h.save,
  reportHref: (r: { id: string; home?: unknown }) => `/report/${r.id}?index=${r.home ? "meetings" : "reports"}`,
}));
vi.mock("../lib/capture", () => ({ captureSnapshot: () => ({ state: "ready" }), subscribeCapture: () => () => {} }));
vi.mock("../lib/session", () => ({ errorMessage: String }));
import AttentionQueue from "./AttentionQueue";
import { summarise } from "../lib/meetingMeta";

type Element = React.ReactElement<any>;
function nodes(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement(node)) return [];
  return [node, ...nodes((node as Element).props.children)];
}
const report = (microsoft: boolean): ReportData => ({
  id: "same", title: microsoft ? "Microsoft" : "Google", date: "2026-11-14",
  updatedAt: "2026-11-14T01:00:00.000Z", summary: "Notes", transcription: "Words", todos: [], takeaways: [],
  ...(microsoft ? { home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } } : {}),
});
function sync(reports: ReportData[]) {
  const workspace: Workspace = {
    reports: reports.map(summarise),
    dirty: ["same", "/report/same?index=meetings"],
    drafts: [], draftsError: "", error: "", running: new Set(), loading: false, reload: vi.fn(),
  };
  const tree = AttentionQueue({ workspace });
  const button = nodes(tree).find(n => n.type === "button" && n.props.onClick && String(n.props.children).includes("In der Cloud speichern"));
  expect(button).toBeDefined();
  button!.props.onClick();
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => {
  vi.clearAllMocks(); h.auth.currentUser = { uid: "A" }; h.save.mockResolvedValue(null); h.job.mockReset();
});
it("saves only the dirty Microsoft namespace and forwards its observed revision", async () => {
  const selected = report(true);
  h.read.mockResolvedValue({ report: selected, dirty: true });
  sync([report(false), selected]);
  await settle();
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(h.read).toHaveBeenCalledWith("A", "same", { index: "meetings" });
  expect(h.save).toHaveBeenCalledWith(selected, { expectedUpdatedAt: selected.updatedAt });
});
it("does not save A's report as B after a switch during the local read", async () => {
  let resolve!: (value: unknown) => void;
  h.read.mockReturnValue(new Promise(done => { resolve = done; }));
  sync([report(true)]);
  h.auth.currentUser = { uid: "B" };
  resolve({ report: report(true), dirty: true });
  await settle();
  expect(h.save).not.toHaveBeenCalled();
});
it.each([false, true])("hides recovery only for its exact active source (matching=%s)", matching => {
  const active = { ...report(false), driveFolderId: "active", driveReportId: "json" };
  const recovered = matching ? active : { ...active, driveFolderId: "sibling" };
  h.job.mockImplementation((_id: string, known: ReportData) => known.driveFolderId === "active" ? { owner: "A", stage: "uploading" } : undefined);
  const workspace: Workspace = { reports: [summarise(active)], dirty: [], drafts: [{ report: recovered, audio: new Blob(["sole recording"]) }], draftsError: "", error: "", running: new Set(["/report/same?index=reports"]), loading: false, reload: vi.fn() };
  const links = nodes(AttentionQueue({ workspace })).filter(node => node.props.to === "/record?draft=same");
  expect(links).toHaveLength(matching ? 0 : 1);
});
