import React from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

// Execute the real page callbacks with controlled hooks and owned local IO.
const h = vi.hoisted(() => ({
  slots: [] as any[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  routeId: "fixture",
  routeSearch: "",
  processing: true,
  stored: undefined as undefined | { report: ReportData; dirty: boolean },
  sibling: undefined as undefined | { report: ReportData; dirty: boolean },
  read: vi.fn(),
  job: vi.fn(),
  listener: undefined as undefined | (() => void),
  save: vi.fn(),
  calendar: vi.fn(),
  calendarGrant: vi.fn(),
  sync: vi.fn(),
  handoff: vi.fn(),
  restore: vi.fn(),
  prepare: vi.fn(),
  analyze: vi.fn(),
  download: vi.fn(),
  navigate: vi.fn(),
  storage: new Map<string, string>(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: any) => {
    const i = h.cursor++;
    if (!(i in h.slots))
      h.slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[i],
      (next: any) => {
        h.slots[i] = typeof next === "function" ? next(h.slots[i]) : next;
      },
    ];
  },
  useRef: (initial: any) => {
    const i = h.cursor++;
    return (h.slots[i] ??= { current: initial });
  },
  useEffect: (effect: () => unknown, deps?: any[]) => {
    const i = h.cursor++;
    const old = h.slots[i];
    if (!old || !deps || deps.some((d, j) => d !== old[j])) {
      h.slots[i] = deps;
      h.effects.push(effect);
    }
  },
  useMemo: (fn: () => unknown) => fn(),
  useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ id: h.routeId }),
  useSearchParams: () => [new URLSearchParams(h.routeSearch), vi.fn()],
  useNavigate: () => h.navigate,
  Link: "a",
}));
vi.mock("../lib/session", () => ({
  connectGoogle: async () => "token",
  ensureDriveToken: async () => "token",
  errorMessage: (e: Error) => e.message,
}));
vi.mock("../lib/reports", () => ({
  uid: () => "owner",
  saveReport: h.save,
  getReport: async () => h.stored,
}));
vi.mock("../lib/restoreTranscript", () => ({
  restoreReportTranscript: h.restore,
}));
vi.mock("../lib/local", () => ({
  ReportConflictError: class extends Error { constructor() { super("Revision conflict"); this.name = "ReportConflictError"; } },
  getLocal: h.read,
  getDraft: async () => undefined,
  putDraft: vi.fn(),
  deleteDraft: vi.fn(async () => {}),
  watchLocalReports: (_: string, cb: () => void) => {
    h.listener = cb;
    return () => {};
  },
}));
vi.mock("../lib/calendar", () => ({
  hasAnyCalendarGrant: h.calendarGrant,
  subscribeCalendar: () => () => {},
}));
vi.mock("../lib/calendarSync", () => ({ syncReportToCalendar: h.calendar }));
vi.mock("../lib/workflow", () => ({
  syncReport: h.sync,
  backupDraft: vi.fn(),
  analyzeDraft: h.analyze,
  restoreDraft: vi.fn(),
}));
vi.mock("../lib/pipeline", () => ({
  clearJob: vi.fn(),
  jobFor: h.job,
  subscribeJobs: () => () => {},
  handoffServerProcessing: h.handoff,
  startProcessing: vi.fn(),
}));
vi.mock("../lib/serverProcessing", () => ({
  processingAvailable: async () => h.processing,
}));
vi.mock("../lib/prepareTranscript", () => ({ prepareTranscript: h.prepare }));
vi.mock("../lib/microsoft", () => ({
  ensureMicrosoftToken: async () => ({ accessToken: "token" }),
}));
vi.mock("../lib/onedrive", () => ({ downloadOneDrive: h.download }));
vi.mock("../lib/microsoftWorkflow", () => ({
  restoreMicrosoftReport: vi.fn(),
}));
vi.mock("../lib/drive", () => ({ downloadDriveFile: h.download }));
vi.mock("../lib/share", () => ({ shareReport: vi.fn() }));
vi.mock("../lib/markdown", () => ({ reportToMarkdown: () => "markdown" }));
vi.mock("../components/DeleteMeeting", () => ({ default: () => null }));
vi.mock("../components/AssignEvent", () => ({ default: () => null }));
import ReportRoute, { ReportDetail as ReportPage } from "./ReportPage";
import SpeakerEditor from "../components/SpeakerEditor";
import TranscriptTimeline from "../components/TranscriptTimeline";
import DeleteMeeting from "../components/DeleteMeeting";
import { AudioPreview, CalendarStatus } from "../components/UI";
import TranscriptChat from "../components/TranscriptChat";

type Element = React.ReactElement<any>;
function nodes(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement(node)) return [];
  return [node, ...nodes((node as Element).props.children)];
}
function text(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return React.isValidElement(node)
    ? text((node as Element).props.children)
    : "";
}
const fixture = (): ReportData => ({
  id: "fixture",
  title: "Fixture",
  date: "2026-11-13T10:00:00Z",
  updatedAt: "2026-11-13T12:00:00Z",
  summary: "Saved summary",
  transcription: "Original text",
  todos: [{ text: "Task", owner: "Alex" }],
  takeaways: [],
  status: "completed",
  driveSyncedAt: "2026-11-13T12:00:00Z",
  driveReportId: "json",
  rawAudioUrl: "audio",
});
let initial: ReportData;
function view() {
  h.cursor = 0;
  return ReportPage({ report: initial });
}
async function flush() {
  for (let i = 0; i < 4; i++) {
    const effects = h.effects.splice(0);
    for (const effect of effects) effect();
    await Promise.resolve();
  }
}
function button(label: string, tree = view()) {
  const node = nodes(tree).find(
    (n) => n.type === "button" && text(n.props.children).trim() === label,
  );
  expect(node, label).toBeDefined();
  return node!;
}
function field(name: string) {
  const node = nodes(view()).find(
    (n) => n.type === "textarea" && n.props["aria-label"] === name,
  );
  expect(node, name).toBeDefined();
  return node!;
}
beforeEach(() => {
  vi.clearAllMocks();
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
  h.storage.clear();
  h.listener = undefined;
  h.routeId = "fixture";
  h.routeSearch = "";
  h.processing = true;
  initial = fixture();
  h.stored = { report: structuredClone(initial), dirty: false };
  h.sibling = undefined;
  h.job.mockReturnValue(undefined);
  h.read.mockImplementation(async (_owner: string, _id: string, options?: { index: "reports" | "meetings" }) => {
    if (!options && h.sibling) throw Error("Meeting-ID mehrdeutig");
    return structuredClone([h.stored, h.sibling].find(v => v && (!options || (v.report.home ? "meetings" : "reports") === options.index)));
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    confirm: vi.fn(() => true),
  });
  vi.stubGlobal("document", { title: "Meeting-Bericht · CheatMeet", activeElement: { focus: vi.fn() } });
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => h.storage.get(k) ?? null,
    setItem: (k: string, v: string) => h.storage.set(k, v),
    removeItem: (k: string) => h.storage.delete(k),
  });
  h.save.mockImplementation(
    async (
      report: ReportData,
      options?: { expectedUpdatedAt?: string | null },
    ) => {
      if (
        options &&
        options.expectedUpdatedAt !== (h.stored?.report.updatedAt ?? null)
      )
        throw Object.assign(new Error("Revision conflict"), {
          name: "ReportConflictError",
        });
      h.stored = {
        report: {
          ...structuredClone(report),
          updatedAt: "2026-11-14T00:00:00Z",
        },
        dirty: false,
      };
      return null;
    },
  );
  h.sync.mockImplementation(async (report: ReportData) => {
    if (report.updatedAt !== h.stored?.report.updatedAt) throw Error("Stale archive source");
    // The archive writer's final index save advances the local revision again.
    h.stored = {
      report: { ...report, updatedAt: `${report.updatedAt}:archive` },
      dirty: false,
    };
    return { report: h.stored.report, warning: null };
  });
  h.calendar.mockResolvedValue({ calendarSyncedAt: "now" });
  h.calendarGrant.mockReturnValue(true);
});

it("cannot publish unsaved edits through the calendar action", async () => {
  button("Bearbeiten").props.onClick();
  const calendar = button("Neuen Termin anlegen");
  expect(calendar.props.disabled).toBe(true);
  await calendar.props.onClick();
  expect(h.calendar).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
});

it("distinguishes manual calendar success, app-index save and pending file archive for both homes", async () => {
  for (const microsoft of [false, true]) {
    for (const existing of [false, true]) {
      h.slots = []; h.effects = []; h.calendar.mockClear(); h.sync.mockClear();
      initial = { ...fixture(), calendarEventId: existing ? "existing-event" : undefined,
        ...(microsoft ? { driveReportId: undefined, driveSyncedAt: undefined,
          home: { provider: "microsoft" as const, connectionId: "archive-account", driveId: "drive", rootId: "root", rootName: "Archiv", reportId: "json", syncedAt: "2026-11-13T12:00:00Z" } } : {}) };
      h.stored = { report: initial, dirty: false };
      h.calendar.mockResolvedValueOnce({ calendarEventId: existing ? "existing-event" : "created-event", calendarId: "team", calendarProvider: microsoft ? "microsoft" : "google", calendarSyncedAt: "now" });
      view(); await flush();
      const save = h.save.getMockImplementation()!;
      if (existing) h.save.mockImplementationOnce(async (...args: any[]) => {
        await save(...args); h.stored!.dirty = true;
        return "Cloud-Index nicht erreichbar; lokal gespeichert.";
      });
      await button(existing ? "Kalender aktualisieren" : "Neuen Termin anlegen").props.onClick();
      const message = text(view());
      expect(message).toContain(existing ? "Kalendereintrag aktualisiert." : "Termin im Kalender angelegt.");
      expect(message).toContain("auf diesem Gerät gespeichert");
      expect(message).toContain(existing ? "Cloud-Index nicht erreichbar" : "im Cloud-Index gesichert");
      expect(message).toContain("Dateiarchiv noch nicht aktualisiert");
      expect(microsoft ? h.stored!.report.home?.syncedAt : h.stored!.report.driveSyncedAt).toBeFalsy();
      expect(h.stored!.report).toMatchObject({ archiveBaseSyncedAt: "2026-11-13T12:00:00Z" });
      expect(button(microsoft ? "In OneDrive speichern" : "In Drive speichern")).toBeDefined();
      expect(h.sync).not.toHaveBeenCalled();
    }
  }
});

it("checks the linked Outlook account independently from the current reassignment picker", async () => {
  initial = { ...fixture(), calendarEventId: "event", calendarId: "primary", calendarProvider: "microsoft", calendarConnectionId: "linked-account" };
  h.stored = { report: initial, dirty: false };
  h.calendarGrant.mockImplementation((provider, connection) => provider === "microsoft" && connection === "linked-account");
  view(); await flush();
  await button("Kalender aktualisieren").props.onClick();
  expect(h.calendar).toHaveBeenCalledWith(expect.objectContaining({ calendarConnectionId: "linked-account" }));
  expect(CalendarStatus({ report: initial })).not.toBeNull();
  expect(h.calendarGrant).toHaveBeenLastCalledWith("microsoft", "linked-account");
  h.calendarGrant.mockImplementation(provider => provider === undefined);
  expect(nodes(view()).find(n => n.type === "button" && text(n.props.children).trim() === "Kalender aktualisieren")).toBeUndefined();
  expect(button("Termin zuordnen")).toBeDefined();
  expect(CalendarStatus({ report: initial })).toBeNull();
});

it("keys report editor lifetime to the exact route so another report cannot inherit its draft", () => {
  const first = ReportRoute({});
  h.routeId = "other-meeting";
  const next = ReportRoute({});
  expect(first.key).toBe("fixture");
  expect(next.key).toBe("other-meeting");
});

it("remounts equal-ID provider routes instead of carrying the sibling editor", () => {
  h.routeSearch = "index=reports";
  const google = ReportRoute({});
  h.routeSearch = "index=meetings";
  expect(ReportRoute({}).key).not.toBe(google.key);
});

it("loads, subscribes and edits only the qualified Google route with an equal-ID Microsoft sibling", async () => {
  h.routeSearch = "index=reports";
  h.sibling = { report: { ...fixture(), title: "Microsoft sibling", summary: "Other provider notes", home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } }, dirty: false };
  const sibling = structuredClone(h.sibling);
  const page = () => { h.cursor = 0; return ReportPage({}); };
  page(); await flush(); page(); await flush();
  expect(text(page())).toContain("Saved summary");
  h.stored!.report = { ...h.stored!.report, title: "Google update", updatedAt: "new-revision" };
  h.listener!(); await flush();
  expect(text(page())).toContain("Google update");
  expect(text(page())).not.toContain("Microsoft sibling");
  expect(h.job).toHaveBeenLastCalledWith("fixture", expect.objectContaining({ title: "Google update" }));
  expect(h.job.mock.calls.at(-1)?.[1].home).toBeUndefined();
  const checkbox = nodes(page()).find(n => n.type === "input" && n.props.type === "checkbox")!;
  await checkbox.props.onChange({ target: { checked: true } });
  expect(h.stored!.report.todos[0].done).toBe(true);
  expect(h.sibling).toEqual(sibling);
  expect(h.read.mock.calls.every(c => c[2]?.index === "reports")).toBe(true);
});

it.each(["summary", "title", "task"])("invalidates only changed calendar notes on an ordinary %s save", async kind => {
  initial = { ...fixture(), calendarEventId: "linked", calendarSyncedAt: "previous-success" };
  h.stored = { report: initial, dirty: false };
  view(); await flush();
  button("Bearbeiten").props.onClick();
  if (kind === "summary") field("Zusammenfassung bearbeiten").props.onChange({ target: { value: "Corrected notes" } });
  else if (kind === "task") field("Aufgaben bearbeiten").props.onChange({ target: { value: "Changed task @Bea bis 2026-11-20" } });
  else nodes(view()).find(n => n.type === "input" && n.props["aria-label"] === "Titel des Meetings")!.props.onChange({ target: { value: "New title" } });
  await button("Speichern").props.onClick();
  expect(h.stored!.report.calendarEventId).toBe("linked");
  expect(h.stored!.report.calendarSyncedAt).toBe(kind === "title" ? "previous-success" : undefined);
  expect(h.calendar).not.toHaveBeenCalled();
  if (kind === "summary") {
    await button("Kalender aktualisieren").props.onClick();
    expect(h.stored!.report.calendarSyncedAt).toBe("now");
    expect(h.calendar).toHaveBeenCalledWith(expect.objectContaining({ summary: "Corrected notes" }));
  }
});

it("keeps the original archive baseline across edits whose archive uploads fail for either home", async () => {
  for (const microsoft of [false, true]) {
    h.slots = []; h.effects = []; h.save.mockClear(); h.sync.mockClear();
    h.sync.mockRejectedValue(new Error("Archive offline"));
    initial = { ...fixture(), ...(microsoft ? { driveReportId: undefined, driveSyncedAt: undefined,
      home: { provider: "microsoft" as const, connectionId: "archive-account", driveId: "drive", rootId: "root", rootName: "Archiv", reportId: "json", syncedAt: fixture().driveSyncedAt } } : {}) };
    h.stored = { report: initial, dirty: false };
    view(); await flush();
    for (const summary of ["First correction", "Second correction"]) {
      button("Bearbeiten").props.onClick();
      field("Zusammenfassung bearbeiten").props.onChange({ target: { value: summary } });
      await button("Speichern").props.onClick();
      expect(h.stored!.report).toMatchObject({ summary, archiveBaseSyncedAt: "2026-11-13T12:00:00Z" });
      expect(microsoft ? h.stored!.report.home?.syncedAt : h.stored!.report.driveSyncedAt).toBeFalsy();
    }
    expect(h.sync).toHaveBeenCalledTimes(2);
  }
});

it("sets the document title from the loaded saved report, never an unpublished editor title", async () => {
  const page = () => { h.cursor = 0; return ReportPage({}); };
  page(); await flush(); page(); await flush();
  expect(document.title).toBe("Fixture · CheatMeet");
  button("Bearbeiten", page()).props.onClick();
  const title = nodes(page()).find(n => n.type === "input" && n.props["aria-label"] === "Titel des Meetings")!;
  title.props.onChange({ target: { value: "Private unsaved title" } });
  page(); await flush();
  expect(document.title).toBe("Fixture · CheatMeet");
  expect(h.save).not.toHaveBeenCalled(); expect(h.calendar).not.toHaveBeenCalled();
  expect((document.activeElement as HTMLElement)?.focus).not.toHaveBeenCalled();
  h.stored!.report = { ...h.stored!.report, title: "New saved title", updatedAt: "new-revision" };
  h.listener!(); await flush(); page(); await flush();
  expect(document.title).toBe("New saved title · CheatMeet");
});

it("marks a task tick as pending archive work without losing its canonical baseline", async () => {
  view(); await flush();
  const checkbox = nodes(view()).find(n => n.type === "input" && n.props.type === "checkbox")!;
  await checkbox.props.onChange({ target: { checked: true } });
  expect(h.stored!.report).toMatchObject({ archiveBaseSyncedAt: "2026-11-13T12:00:00Z", driveSyncedAt: "", todos: [{ text: "Task", owner: "Alex", done: true }] });
  expect(button("In Drive speichern").props.disabled).toBeFalsy();
  expect(h.sync).not.toHaveBeenCalled();
});

it("recovers an unsaved report draft after unmount/reload without changing the saved report", async () => {
  view();
  await flush();
  button("Bearbeiten").props.onClick();
  field("Zusammenfassung bearbeiten").props.onChange({
    target: { value: "Private correction" },
  });
  view();
  await flush();
  expect(h.stored!.report.summary).toBe("Saved summary");
  expect(h.save).not.toHaveBeenCalled();
  h.slots = [];
  h.effects = [];
  view();
  await flush();
  expect(field("Zusammenfassung bearbeiten").props.value).toBe(
    "Private correction",
  );
  expect(text(view())).toContain("wiederhergestellt");
});

it("subscribes to exact local revisions, preserves a conflicted draft and patches tasks on the latest report", async () => {
  view();
  await flush();
  h.stored!.report = {
    ...h.stored!.report,
    title: "Other tab",
    updatedAt: "revision-b",
  };
  h.listener!();
  await flush();
  expect(text(view())).toContain("Other tab");
  button("Bearbeiten").props.onClick();
  field("Zusammenfassung bearbeiten").props.onChange({
    target: { value: "My draft" },
  });
  view();
  await flush();
  h.stored!.report = {
    ...h.stored!.report,
    title: "Newer title",
    updatedAt: "revision-c",
  };
  h.listener!();
  await flush();
  expect(field("Zusammenfassung bearbeiten").props.value).toBe("My draft");
  expect(text(view())).toContain("neuere gespeicherte Fassung");
  await button("Speichern").props.onClick();
  expect(h.stored!.report.title).toBe("Newer title");
  expect(h.sync).not.toHaveBeenCalled();
  button("Abbrechen").props.onClick();
  h.stored!.report = {
    ...h.stored!.report,
    title: "Latest before tick",
    updatedAt: "revision-d",
  };
  const checkbox = nodes(view()).find(
    (n) => n.type === "input" && n.props.type === "checkbox",
  )!;
  await checkbox.props.onChange({ target: { checked: true } });
  await flush();
  expect(h.stored!.report.title).toBe("Latest before tick");
  expect(h.stored!.report.todos[0].done).toBe(true);
  expect(h.save).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Latest before tick" }),
    { expectedUpdatedAt: "revision-d" },
  );
});

it("persists text-only regeneration intent through save/reload and requests it only on explicit analysis", async () => {
  view();
  await flush();
  button("Bearbeiten").props.onClick();
  field("Transkript bearbeiten").props.onChange({
    target: { value: "Corrected text" },
  });
  await button("Speichern").props.onClick();
  expect(h.stored!.report.summaryNeedsRefresh).toBe(true);
  expect(h.handoff).not.toHaveBeenCalled();
  expect(h.sync.mock.calls[0][0].updatedAt).toBe("2026-11-14T00:00:00Z");
  initial = structuredClone(h.stored!.report);
  h.slots = [];
  h.effects = [];
  view();
  await flush();
  await button("Zusammenfassung aktualisieren").props.onClick();
  expect(h.handoff).toHaveBeenCalledWith(
    "owner",
    expect.objectContaining({ transcription: "Corrected text" }),
    expect.objectContaining({
      analyze: true,
      regenerate: true,
      retranscribe: false,
    }),
  );
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.download).not.toHaveBeenCalled();
  initial = {
    ...initial,
    speech: {
      provider: "assemblyai",
      phase: "final",
      languages: [],
      speakerNames: { a: "Corrected name" },
      speakerReview: "pending",
      turns: [
        {
          id: "review-turn",
          speaker: "a",
          text: "Corrected text",
          startMs: 0,
          endMs: 1000,
          final: true,
        },
      ],
    },
  };
  h.stored = { report: initial, dirty: false };
  h.slots = [];
  h.effects = [];
  h.handoff.mockClear();
  view();
  await flush();
  await button("Weiter zur Zusammenfassung").props.onClick();
  expect(h.handoff).toHaveBeenCalledWith(
    "owner",
    expect.anything(),
    expect.objectContaining({ regenerate: true, retranscribe: false }),
  );
  expect(h.handoff.mock.calls[0][1].updatedAt).toBe(h.stored!.report.updatedAt);
});

it("does not replace a newer human report when browser analysis settles late", async () => {
  h.processing = false;
  initial = { ...fixture(), status: "error" };
  h.stored = { report: initial, dirty: false };
  let finish!: () => void;
  h.analyze.mockImplementationOnce((draft) => new Promise(resolve => {
    const result = { ...draft.report, summary: "Late AI result", status: "completed" };
    finish = () => resolve(result);
  }));
  view(); await flush();
  const pending = button("Bericht erstellen").props.onClick();
  await vi.waitFor(() => expect(h.analyze).toHaveBeenCalledOnce());
  const human = { report: { ...initial, title: "New human title", summary: "Keep my newer notes", updatedAt: "human-revision" }, dirty: true };
  h.stored = structuredClone(human);
  finish(); await pending;
  expect(h.stored).toEqual(human);
  expect(h.sync).not.toHaveBeenCalled();
  expect(text(view())).toContain("Revision conflict");
});

it("threads successful preparation revisions through analysis, index save and archive upload", async () => {
  h.processing = false;
  initial = { ...fixture(), status: "error" };
  h.stored = { report: initial, dirty: false };
  h.prepare.mockImplementationOnce(async (draft) => {
    draft.report = { ...draft.report, updatedAt: "prepared-revision" };
    h.stored = { report: structuredClone(draft.report), dirty: true };
  });
  h.analyze.mockImplementationOnce(async (draft) => {
    draft.report = { ...draft.report, updatedAt: "internal-preparation-revision" };
    h.stored = { report: structuredClone(draft.report), dirty: true };
    return { ...draft.report, summary: "New analysis", status: "completed" };
  });
  view(); await flush();
  await button("Bericht erstellen").props.onClick();
  expect(h.prepare.mock.calls[0][2]).toEqual({ expectedUpdatedAt: initial.updatedAt });
  expect(h.analyze.mock.calls[0][1]).toEqual({ expectedUpdatedAt: "prepared-revision" });
  expect(h.save.mock.calls[0][1]).toEqual({ expectedUpdatedAt: "internal-preparation-revision" });
  expect(h.sync.mock.calls[0][0].updatedAt).toBe("2026-11-14T00:00:00Z");
  expect(h.stored!.report.summary).toBe("New analysis");
  expect(text(view())).toContain("Analyse abgeschlossen.");
});

it("locks only mutable transcript controls while save is pending and keeps index warnings after archive success", async () => {
  view();
  await flush();
  button("Bearbeiten").props.onClick();
  let finish!: () => void;
  const baseSave = h.save.getMockImplementation()!;
  h.save.mockImplementationOnce(async (...args: any[]) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await baseSave(...args);
    h.stored!.dirty = true;
    return "Cloud index unavailable; saved locally";
  });
  const saving = button("Speichern").props.onClick();
  expect(field("Transkript bearbeiten").props.disabled).toBe(true);
  finish();
  await saving;
  expect(text(view())).toContain("Cloud index unavailable; saved locally");
  initial = {
    ...h.stored!.report,
    speech: {
      provider: "assemblyai",
      phase: "final",
      languages: [],
      speakerNames: { a: "Alex" },
      turns: [
        {
          id: "turn-1",
          startMs: 1000,
          endMs: 3000,
          text: "Text",
          speaker: "a",
          final: true,
        },
      ],
    },
  };
  h.slots = [];
  h.effects = [];
  h.stored = { report: initial, dirty: false };
  view();
  await flush();
  button("Bearbeiten").props.onClick();
  h.save.mockImplementationOnce(() => new Promise(() => {}));
  void button("Speichern").props.onClick();
  const editor = nodes(view()).find((n) => n.type === SpeakerEditor)!;
  expect(editor.props.disabled).toBe(true);
  expect(nodes(view()).some((n) => n.type === TranscriptTimeline)).toBe(true);
});

it("restores inline without publishing, lazily offers original playback and hands deletion warnings to the dashboard", async () => {
  initial = {
    ...fixture(),
    transcription: "",
    transcriptChars: 100,
    driveFolderId: "folder",
  };
  h.stored = { report: initial, dirty: false };
  h.restore.mockImplementation(async (_: string, report: ReportData) => {
    const hydrated = { ...report, transcription: "Existing archived text" };
    h.stored = { report: hydrated, dirty: false };
    return hydrated;
  });
  view();
  await flush();
  expect(h.download).not.toHaveBeenCalled();
  await button("Transkript aus Archiv laden").props.onClick();
  expect(h.restore).toHaveBeenCalledWith("owner", initial);
  expect(h.save).not.toHaveBeenCalled();
  expect(h.handoff).not.toHaveBeenCalled();
  h.download.mockResolvedValue(new Blob(["audio"], { type: "audio/wav" }));
  await button("Aufnahme anhören").props.onClick();
  expect(h.download).toHaveBeenCalledOnce();
  expect(nodes(view()).some((n) => n.type === AudioPreview)).toBe(true);
  const deletion = nodes(view()).find((n) => n.type === DeleteMeeting)!;
  const outcome = { removed: true, warnings: ["Cloud index remains"] };
  deletion.props.onWarning("Cloud index remains");
  deletion.props.onDeleted(outcome);
  expect(h.navigate).toHaveBeenCalledWith("/dashboard", {
    replace: true,
    state: { deleteOutcome: outcome },
  });
});

it("declares full export scope independently of filters and offers timestamp playback and turn correction", () => {
  const speech: NonNullable<ReportData["speech"]> = {
    provider: "assemblyai",
    phase: "final",
    languages: [],
    speakerNames: { a: "Alex" },
    turns: [
      {
        id: "turn-1",
        startMs: 1000,
        endMs: 3000,
        text: "Visible",
        speaker: "a",
        final: true,
      },
      {
        id: "turn-2",
        startMs: 4000,
        endMs: 5000,
        text: "Hidden",
        speaker: "a",
        final: true,
      },
    ],
  };
  const listen = vi.fn(),
    edit = vi.fn();
  const timeline = () => {
    h.cursor = 0;
    return TranscriptTimeline({
      transcript: "Visible Hidden",
      speech,
      onListen: listen,
      onEditTurn: edit,
    });
  };
  const query = nodes(timeline()).find(
    (n) =>
      n.type === "input" && n.props["aria-label"] === "Im Transkript suchen",
  )!;
  query.props.onChange({ target: { value: "Visible" } });
  const tree = timeline();
  expect(text(tree)).toContain("Gesamtes Transkript kopieren");
  const chats = nodes(tree).filter((n) => n.type === TranscriptChat);
  expect(chats.find((n) => n.props.query === "Visible")).toBeDefined();
  expect(chats.find((n) => !n.props.query && !n.props.filter)).toBeDefined();
  const chat = TranscriptChat({
    transcript: "Visible Hidden",
    speech,
    query: "Visible",
    onListen: listen,
    onEditTurn: edit,
  });
  const seek = nodes(chat).find(
    (n) => n.type === "button" && n.props["aria-label"]?.includes("1 Sekunde"),
  );
  expect(seek).toBeDefined();
  seek!.props.onClick();
  expect(listen).toHaveBeenCalledWith(1000);
  button("Korrigieren", chat).props.onClick();
  expect(edit).toHaveBeenCalledWith("turn-1");
});
