import React from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

const h = vi.hoisted(() => ({
  auth: { currentUser: { uid: "A" } as { uid: string } | null },
  getLocal: vi.fn(),
  putLocal: vi.fn(),
  cloud: vi.fn(),
  people: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("react-router-dom", () => ({ Link: "a" }));
vi.mock("../lib/firebase", () => ({ auth: h.auth, db: {} }));
vi.mock("firebase/firestore", () => ({ doc: (...parts: unknown[]) => parts, setDoc: h.cloud }));
vi.mock("../lib/local", () => ({ getLocal: h.getLocal, putLocal: h.putLocal }));
vi.mock("../lib/people", () => ({ rememberPeople: h.people }));
vi.mock("../lib/calendar", () => ({ hasAnyCalendarGrant: () => false, subscribeCalendar: () => () => {} }));
vi.mock("../lib/pipeline", () => ({ jobFor: () => undefined }));
vi.mock("../lib/session", () => ({ errorMessage: (e: Error) => e.message }));
vi.mock("./AssignEvent", () => ({ default: () => null }));
vi.mock("./DeleteMeeting", () => ({ default: () => null }));
vi.mock("./EventRow", () => ({ MIME: "fixture/meeting" }));
vi.mock("./UI", () => ({ dateTimeLabel: (date: string) => date, Status: () => null, CalendarStatus: () => null }));
import MeetingRow from "./MeetingRow";
import { summarise } from "../lib/meetingMeta";

type Element = React.ReactElement<any>;
function nodes(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement(node)) return [];
  return [node, ...nodes((node as Element).props.children)];
}
const storedReport = (): ReportData => ({
  id: "fixture", title: "Nur A", date: "2026-11-13", summary: "Bericht",
  transcription: "Vollständiger lokaler Text", todos: [], takeaways: [],
  updatedAt: "2026-11-13T10:00:00.000Z",
});
function retry(report = storedReport()) {
  const tree = MeetingRow({ report: summarise(report), dirty: true });
  nodes(tree).find(node => node.type === "button" && node.props.children?.includes("In der Cloud speichern"))!.props.onClick();
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => {
  vi.clearAllMocks();
  h.auth.currentUser = { uid: "A" };
  h.putLocal.mockResolvedValue(undefined);
  h.cloud.mockResolvedValue(undefined);
  h.people.mockResolvedValue(undefined);
});

it("does not save A's row locally or to the cloud after switching to B during its local read", async () => {
  const report = storedReport();
  let resolve!: (value: { report: ReportData; dirty: boolean }) => void;
  h.getLocal.mockReturnValue(new Promise(done => { resolve = done; }));
  retry(report);
  expect(h.getLocal).toHaveBeenCalledWith("A", report.id, { index: "reports" });
  expect(h.cloud).not.toHaveBeenCalled();
  h.auth.currentUser = { uid: "B" };
  resolve({ report, dirty: true });
  await settle();
  expect(h.cloud).not.toHaveBeenCalled();
  expect(h.people).not.toHaveBeenCalled();
  expect(h.putLocal).not.toHaveBeenCalled();
});

it("keeps stale recovery words out of the actual row's highlighted snippet", () => {
  const report = { ...storedReport(), transcriptStale: true, summary: "Aktuelle Zusammenfassung", participants: ["Aktuell"], speakerReviewPending: false };
  const tree = MeetingRow({ report: summarise(report), query: "vollständiger" });
  expect(nodes(tree).filter(node => node.type === "mark")).toEqual([]);
  const prose = nodes(tree).filter(node => node.props.className === "row-text").map(node => node.props.children);
  expect(prose).toEqual(["Aktuelle Zusammenfassung"]);
  expect(report.transcription).toBe("Vollständiger lokaler Text");
});

it("qualifies clicked links, drag payloads and retry reads with the row namespace", async () => {
  const google = storedReport();
  const microsoft = { ...google, title: "Microsoft sibling", home: { provider: "microsoft" as const, connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } };
  for (const report of [google, microsoft]) {
    const index = report.home ? "meetings" : "reports";
    const tree = MeetingRow({ report: summarise(report), dirty: true, draggable: true });
    const link = nodes(tree).find(n => n.props.className === "meeting-row-main")!;
    expect(link.props.to).toBe(`/report/fixture?index=${index}`);
    const transfer = { setData: vi.fn(), effectAllowed: "" };
    tree.props.onDragStart({ dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith("fixture/meeting", link.props.to);
    h.getLocal.mockResolvedValue({ report, dirty: true });
    retry(report); await settle();
    expect(h.getLocal).toHaveBeenCalledWith("A", report.id, { index });
    expect(h.putLocal).toHaveBeenCalledWith("A", expect.objectContaining({ title: report.title }), true, report.updatedAt);
  }
});

it("does not send a cloud write when the local CAS rejects a concurrent edit", async () => {
  h.getLocal.mockResolvedValue({ report: storedReport(), dirty: true });
  h.putLocal.mockRejectedValueOnce(new Error("Dieses Meeting wurde inzwischen geändert."));
  retry();
  await settle();
  expect(h.putLocal).toHaveBeenCalledWith("A", expect.anything(), true, storedReport().updatedAt);
  expect(h.cloud).not.toHaveBeenCalled();
  expect(h.people).not.toHaveBeenCalled();
});

it.each(["2026-11-13T10:00:00.000Z", undefined])("passes the observed local revision %s to the cloud-save CAS", async updatedAt => {
  const report = { ...storedReport(), updatedAt };
  h.getLocal.mockResolvedValue({ report, dirty: true });
  retry(report);
  await settle();
  expect(h.putLocal).toHaveBeenCalledWith("A", expect.objectContaining({ transcription: report.transcription }), true, updatedAt ?? null);
  expect(h.cloud).toHaveBeenCalledTimes(1);
});
