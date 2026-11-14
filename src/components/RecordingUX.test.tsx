import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A local hook/element harness exercises the real render actions without opening
// media, Firebase or a browser. Modal focus is verified separately by the parent.
const h = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as (() => unknown)[],
  owner: "alice", consent: true, token: "token" as string | null, snap: null as any,
  navigate: vi.fn(), discard: vi.fn(), arm: vi.fn(), start: vi.fn(),
  importAudio: vi.fn(), connect: vi.fn(), query: "", getEvent: vi.fn(), setEvent: vi.fn(),
  cleanups: new Map<number, () => void>(), disarm: vi.fn(), verify: vi.fn(),
  capture: null as typeof import("../lib/capture") | null,
}));
vi.mock("react", async (load) => {
  const actual = await load<typeof import("react")>();
  return { ...actual,
    useState: (initial: any) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = typeof initial === "function" ? initial() : initial;
      return [h.slots[index], (value: any) => { h.slots[index] = typeof value === "function" ? value(h.slots[index]) : value; }];
    },
    useRef: (initial: any) => {
      const index = h.cursor++;
      return h.slots[index] ||= { current: initial };
    },
    useEffect: (effect: () => unknown, deps: any[]) => {
      const index = h.cursor++;
      if (!h.slots[index] || deps.some((dep, i) => dep !== h.slots[index][i])) {
        h.slots[index] = deps;
        h.effects.push(() => {
          h.cleanups.get(index)?.();
          const cleanup = effect();
          if (typeof cleanup === "function") h.cleanups.set(index, cleanup as () => void);
          else h.cleanups.delete(index);
        });
      }
    },
    useSyncExternalStore: (_subscribe: any, read: any) => read(),
    useMemo: (compute: () => any) => compute(),
  };
});
vi.mock("react-router-dom", () => ({
  useNavigate: () => h.navigate,
  useSearchParams: () => [new URLSearchParams(h.query)],
  useLocation: () => ({ pathname: "/dashboard" }), Link: "a",
}));
vi.mock("../lib/reports", () => ({ uid: () => h.owner }));
vi.mock("../lib/firebase", () => ({ auth: { get currentUser() { return h.owner ? { uid: h.owner } : null; } } }));
vi.mock("../lib/local", () => ({ putLocal: vi.fn(), getDraft: vi.fn(), putDraft: vi.fn(), appendRecordingChunk: vi.fn(), deleteDraft: vi.fn() }));
vi.mock("../lib/driveSettings", () => ({ savedDriveFolder: () => ({ id: "folder", name: "Archiv" }) }));
vi.mock("../lib/drive", () => ({ DEFAULT_FOLDER_NAME: "CheatMeet", verifyDriveAccess: h.verify }));
vi.mock("../lib/session", () => ({
  errorMessage: (error: Error) => error.message, connectGoogle: h.connect,
  driveToken: () => h.token, ensureDriveToken: async () => h.token,
}));
vi.mock("../lib/providerSettings", () => ({ savedMeetingHome: () => null, loadMeetingHome: async () => null }));
vi.mock("../lib/microsoft", () => ({ cachedMicrosoftConnections: () => [], connectMicrosoft: h.connect, ensureMicrosoftToken: vi.fn() }));
vi.mock("../lib/onedrive", () => ({ getOneDriveItem: vi.fn() }));
vi.mock("../lib/consentDraft", () => ({ draftConsentNotice: vi.fn() }));
vi.mock("../lib/meetingDefaults", () => ({ consentStepEnabled: () => h.consent, setConsentStep: (on: boolean) => { h.consent = on; }, savedRetention: () => ({ audioDays: 30, textDays: null }), defaultLanguages: () => ["de"] }));
vi.mock("../lib/audioSources", () => ({ audioSourcePreference: () => "mic", setAudioSourcePreference: vi.fn() }));
vi.mock("../lib/calendar", () => ({ getEvent: h.getEvent }));
vi.mock("../lib/pipeline", () => ({ startProcessing: vi.fn() }));
vi.mock("../lib/capture", () => ({
  captureSnapshot: () => h.capture?.captureSnapshot() ?? h.snap, subscribeCapture: () => () => {},
  openDraft: async (...args: Parameters<typeof import("../lib/capture").openDraft>) => h.capture ? h.capture.openDraft(...args) : "take",
  isCapturing: () => h.capture ? h.capture.isCapturing() : ["recording", "paused"].includes(h.snap.state),
  discardCapture: h.discard, armCapture: h.arm, beginRecording: h.start,
  disarmCapture: h.disarm,
  importAudio: h.importAudio, setCaptureError: (error: string) => { h.snap = { ...h.snap, error }; },
  setCaptureBusy: vi.fn(), setCaptureHome: vi.fn(), setCaptureTitle: vi.fn(), setCaptureEvent: h.setEvent,
  pauseCapture: vi.fn(), stopCapture: vi.fn(), restartLive: vi.fn(),
  setCaptureLanguages: vi.fn(), setCaptureRetranscribe: vi.fn(), setCaptureProcessing: vi.fn(),
  setCaptureSingleSpeaker: vi.fn(), setCaptureSpeakerName: vi.fn(), setCaptureHint: vi.fn(), captureQueue: vi.fn(), finishTranscription: vi.fn(), releaseAfterHandoff: vi.fn(),
}));
vi.mock("./PeopleDatalist", () => ({ default: "datalist", PEOPLE_LIST_ID: "people" }));
vi.mock("./CalendarMatch", () => ({ default: "calendar-match" }));
vi.mock("./DriveSettings", () => ({ default: "google-settings" }));
vi.mock("./MicrosoftSettings", () => ({ default: "microsoft-settings" }));
vi.mock("./UI", () => ({ AudioPreview: "audio-preview" }));
vi.mock("./LiveMeeting", () => ({ default: "live-meeting" }));
import RecordPage from "../pages/RecordPage";
import RecordingBar from "./RecordingBar";
import RecordingSheet from "./RecordingSheet";
import { ArmedMeeting } from "./ArmedMeeting";

function render(component: () => any = RecordPage): any {
  h.cursor = 0;
  return component();
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree: any): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree?.props ? text(tree.props.children) : "";
}
function button(tree: any, name: string): any {
  const found = nodes(tree).find(n => n.type === "button" && (text(n).includes(name) || n.props["aria-label"] === name));
  expect(found, `button ${name}`).toBeDefined();
  return found;
}
async function ready() {
  render();
  for (const effect of h.effects.splice(0)) effect();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return render();
}
function unmount() {
  for (const cleanup of h.cleanups.values()) cleanup();
  h.cleanups.clear();
  h.effects = [];
}
beforeEach(() => {
  vi.clearAllMocks(); h.slots = []; h.effects = []; h.cursor = 0; h.owner = "alice"; h.consent = true;
  h.cleanups.clear(); h.capture = null;
  h.token = "token"; h.query = "";
  h.getEvent.mockReset();
  h.setEvent.mockImplementation((event: any) => {
    h.snap.draft.report = { ...h.snap.draft.report, calendarEventId: event?.id, calendarId: event?.calendarId, calendarProvider: event?.provider, calendarConnectionId: event?.connectionId };
  });
  vi.stubGlobal("navigator", { onLine: true, mediaDevices: {} });
  h.snap = { owner: "alice", state: "review", draft: { report: { id: "take", title: "Planung", date: "2026-11-13", transcription: "Nur lokal", todos: [], takeaways: [] }, audio: new Blob(["audio"]) },
    sources: ["mic"], busy: "", error: "", warning: "", saved: true, durationMs: 3000, checkpointMs: 3000, transcribing: 0, failed: 0 };
  h.arm.mockImplementation(async () => { h.snap = { ...h.snap, state: "armed" }; });
  h.disarm.mockImplementation(() => {
    if (h.capture) h.capture.disarmCapture();
    else h.snap = { ...h.snap, state: "ready" };
  });
  h.start.mockResolvedValue(undefined);
  h.verify.mockReset();
  h.discard.mockResolvedValue(undefined);
  vi.stubGlobal("window", { setInterval: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { body: { style: { overflow: "" } } });
});
afterEach(() => {
  unmount();
  h.capture?.disarmCapture();
  h.capture = null;
});

it.each([
  { consent: true, pending: "storage verification" },
  { consent: false, pending: "getUserMedia" },
])("cancels pending $pending on page unmount (consent=$consent)", async ({ consent, pending }) => {
  // Use the real kernel attempt/disarm path, not a simulated cancellation flag.
  h.capture = await vi.importActual<typeof import("../lib/capture")>("../lib/capture");
  h.consent = consent;
  await h.capture.openDraft("alice", undefined, true);
  h.arm.mockImplementation(h.capture.armCapture);
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), { kind: "audio", readyState: "live", stop });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  let complete!: () => void;
  const waiting = new Promise<void>(resolve => { complete = resolve; });
  const getUserMedia = vi.fn(async () => {
    if (pending === "getUserMedia") await waiting;
    return stream;
  });
  h.verify.mockImplementation(() => pending === "storage verification" ? waiting : Promise.resolve());
  vi.stubGlobal("navigator", { onLine: true, mediaDevices: { getUserMedia } });
  Object.assign(window, { MediaRecorder: class {} });
  const tree = await ready();
  const prepare = button(tree, consent ? "Aufnahme vorbereiten" : "Ohne Einwilligungsschritt aufnehmen");
  prepare.props.onClick();
  for (let i = 0; i < 16; i++) await Promise.resolve();
  expect(h.capture.captureSnapshot().state).toBe("ready");
  expect(h.capture.captureSnapshot().busy).not.toBe("");
  if (pending === "getUserMedia") expect(getUserMedia).toHaveBeenCalledTimes(1);
  else expect(h.verify).toHaveBeenCalledTimes(1);
  unmount();
  complete();
  for (let i = 0; i < 16; i++) await Promise.resolve();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.capture.captureSnapshot().state).toBe("ready");
  expect(h.capture.captureSnapshot().busy).toBe("");
  expect(h.disarm).toHaveBeenCalledTimes(1);
  if (pending === "getUserMedia") expect(stop).toHaveBeenCalledTimes(1);
  else expect(getUserMedia).not.toHaveBeenCalled();
  // A retained event handler must not launch a fresh request after exit either.
  prepare.props.onClick();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(h.arm).toHaveBeenCalledTimes(1);
});

it("requires a named sole-copy confirmation before discarding audio, and cancel deletes nothing", async () => {
  let tree = await ready();
  button(tree, "Weitere Optionen").props.onClick(); tree = render();
  button(tree, "Entwurf verwerfen").props.onClick(); tree = render();
  expect(h.discard).not.toHaveBeenCalled();
  const dialog = nodes(tree).find(n => n.type === RecordingSheet);
  expect(text(dialog)).toContain("Planung");
  expect(text(dialog)).toContain("einzige");
  button(tree, "Abbrechen").props.onClick(); tree = render();
  expect(h.discard).not.toHaveBeenCalled();
  button(tree, "Weitere Optionen").props.onClick(); tree = render();
  button(tree, "Entwurf verwerfen").props.onClick(); tree = render();
  await button(tree, "Endgültig verwerfen").props.onClick();
  expect(h.discard).toHaveBeenCalledTimes(1);
  expect(h.navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
});

it("keeps failed deletion inside the active dialog and rejects a changed confirmation target", async () => {
  let tree = await ready();
  button(tree, "Weitere Optionen").props.onClick(); tree = render();
  button(tree, "Entwurf verwerfen").props.onClick(); tree = render();
  h.discard.mockRejectedValueOnce(new Error("Lokales Löschen fehlgeschlagen"));
  await button(tree, "Endgültig verwerfen").props.onClick(); tree = render();
  expect(text(nodes(tree).find(n => n.type === RecordingSheet))).toContain("Lokales Löschen fehlgeschlagen");
  expect(h.navigate).not.toHaveBeenCalledWith("/dashboard", { replace: true });
  h.discard.mockClear();
  h.snap = { ...h.snap, draft: { ...h.snap.draft, report: { ...h.snap.draft.report, id: "replacement" } } };
  await button(tree, "Endgültig verwerfen").props.onClick();
  expect(h.discard).not.toHaveBeenCalled();
});

it("offers only phase-valid actions while recording or paused, even with an audio checkpoint", async () => {
  h.query = "event=other&provider=microsoft&connection=other-account&calendar=other-calendar";
  for (const state of ["recording", "paused"]) {
    h.snap.state = state;
    let tree = await ready();
    expect(nodes(tree).find(n => n.type === "live-meeting")?.props.usage).toEqual({ meetingId: "take", storage: "google" });
    button(tree, "Weitere Optionen").props.onClick(); tree = render();
    expect(text(tree)).not.toContain("ohne Analyse");
    expect(text(tree)).not.toContain("Als Entwurf später fortsetzen");
    expect(h.getEvent).not.toHaveBeenCalled();
    expect(h.setEvent).not.toHaveBeenCalled();
    button(tree, "Zur Übersicht · Aufnahme bleibt aktiv").props.onClick();
    expect(h.navigate).toHaveBeenLastCalledWith("/dashboard");
    unmount();
    expect(h.snap.state).toBe(state);
    expect(h.disarm).not.toHaveBeenCalled();
    h.slots = []; h.effects = [];
  }
});

it("re-preparing seeds the current event and never reuses roster approvals", async () => {
  h.snap.state = "ready"; h.snap.draft.audio = undefined;
  let tree = await ready();
  const pick = (name: string) => nodes(tree).find(n => n.type === "calendar-match").props.onPick({ id: name, calendarId: "team", provider: "microsoft", connectionId: "pinned-account", title: name, attendees: [name] });
  pick("Anna"); tree = render();
  expect(nodes(tree).find(n => n.type === "calendar-match").props.binding).toEqual({ provider: "microsoft", connectionId: "pinned-account", calendarId: "team" });
  button(tree, "Aufnahme vorbereiten").props.onClick();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  tree = render();
  let armed = nodes(tree).find(n => n.type === ArmedMeeting);
  armed.props.onDecision({ participants: [{ name: "Anna", stance: "agreed" }] });
  tree = render();
  expect(button(tree, "Einwilligung erteilt").props.disabled).toBe(false);
  button(tree, "Abbrechen").props.onClick(); tree = render();
  pick("Bert"); tree = render();
  button(tree, "Aufnahme vorbereiten").props.onClick();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  tree = render(); armed = nodes(tree).find(n => n.type === ArmedMeeting);
  expect(armed.props.decision.participants).toEqual([{ name: "Bert", stance: "silent" }]);
  expect(button(tree, "Einwilligung erteilt").props.disabled).toBe(true);
  h.snap.state = "review"; tree = render();
  expect(nodes(tree).find(n => n.type === "calendar-match").props.binding).toEqual({ provider: "microsoft", connectionId: "pinned-account", calendarId: "team" });
});

it("retains failed requested-event pins and blocks preparation/import until retry or explicit opt-out", async () => {
  h.snap.state = "ready"; h.snap.draft.audio = undefined; h.token = null;
  h.query = "new&event=requested&provider=microsoft&connection=work-account&calendar=team-calendar";
  h.getEvent.mockRejectedValueOnce(new Error("Outlook nicht erreichbar"));
  let tree = await ready();
  expect(text(tree)).toContain("Outlook nicht erreichbar");
  const destination = h.navigate.mock.calls.at(-1)![0];
  const pins = new URL(destination, "https://fixture.invalid").searchParams;
  expect(Object.fromEntries(pins)).toMatchObject({ draft: "take", event: "requested", provider: "microsoft", connection: "work-account", calendar: "team-calendar" });
  expect(button(tree, "Google Drive freigeben").props.disabled).toBe(true);
  button(tree, "Google Drive freigeben").props.onClick();
  const fileInput = nodes(tree).find(n => n.type === "input" && n.props.type === "file");
  fileInput.props.onChange({ target: { files: [new Blob(["audio"])], value: "audio" } });
  expect(button(tree, "Vorhandenes Audio importieren").props.disabled).toBe(true);
  expect(h.arm).not.toHaveBeenCalled(); expect(h.importAudio).not.toHaveBeenCalled(); expect(h.connect).not.toHaveBeenCalled();
  h.getEvent.mockResolvedValueOnce({ id: "requested", provider: "microsoft", connectionId: "work-account", calendarId: "team-calendar", title: "Planned", attendees: ["Anna"] });
  await button(tree, "Erneut versuchen").props.onClick(); tree = render();
  expect(h.getEvent).toHaveBeenLastCalledWith("team-calendar", "requested", "microsoft", "work-account");
  expect(nodes(tree).find(n => n.type === "calendar-match").props.selectedEvent?.title).toBe("Planned");
  expect(button(tree, "Vorhandenes Audio importieren").props.disabled).toBe(false);
  h.token = "token"; tree = render();
  button(tree, "Aufnahme vorbereiten").props.onClick();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  tree = render();
  expect(nodes(tree).find(n => n.type === ArmedMeeting).props.decision.participants).toEqual([{ name: "Anna", stance: "silent" }]);

  // Opt-out invalidates an in-flight retry; its late result cannot retag the draft.
  h.slots = []; h.effects = []; h.snap.state = "ready"; h.setEvent.mockClear();
  h.getEvent.mockRejectedValueOnce(new Error("Noch nicht erreichbar"));
  tree = await ready();
  let complete!: (value: any) => void;
  h.getEvent.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const retry = button(tree, "Erneut versuchen").props.onClick(); tree = render();
  button(tree, "Ohne Termin fortfahren").props.onClick();
  complete({ id: "late", attendees: ["Wrong"] }); await retry; tree = render();
  expect(h.setEvent).toHaveBeenLastCalledWith(null);
  expect(button(tree, "Vorhandenes Audio importieren").props.disabled).toBe(false);
});

it("allows local import without archive permission and never authorizes on file selection", async () => {
  h.snap.state = "ready"; h.snap.draft.audio = undefined; h.token = null;
  let tree = await ready();
  const pick = vi.fn();
  nodes(tree).find(n => n.type === "input" && n.props.type === "file").props.ref.current = { click: pick };
  const action = button(tree, "Vorhandenes Audio importieren");
  expect(action.props.disabled).toBe(false);
  action.props.onClick();
  expect(pick).toHaveBeenCalledTimes(1);
  expect(h.connect).not.toHaveBeenCalled();
});

it("discloses a disabled consent step before start and offers a meeting-local re-enable", async () => {
  h.snap.state = "ready"; h.snap.draft.audio = undefined; h.consent = false;
  let tree = await ready();
  expect(text(tree)).toContain("Einwilligungsschritt ausgeschaltet");
  expect(button(tree, "Ohne Einwilligungsschritt aufnehmen").props.disabled).toBe(false);
  button(tree, "Für dieses Meeting einschalten").props.onClick(); tree = render();
  expect(button(tree, "Aufnahme vorbereiten").props.disabled).toBe(false);
  expect(h.consent).toBe(false); // no surprising persistent settings change
});

it("repairs the pinned OneDrive connection without showing unrelated Google/default settings", async () => {
  h.snap.draft.report.home = { provider: "microsoft", connectionId: "ms-1", driveId: "drive", rootId: "root", rootName: "Projektarchiv" };
  let tree = await ready();
  button(tree, "Weitere Optionen").props.onClick(); tree = render();
  button(tree, "Speicherort").props.onClick(); tree = render();
  expect(nodes(tree).some(n => n.type === "google-settings")).toBe(false);
  expect(text(tree)).toContain("Projektarchiv");
  expect(text(tree)).toContain("bleibt für dieses Meeting festgelegt");
  await button(tree, "OneDrive erneut verbinden").props.onClick();
  expect(h.connect).toHaveBeenCalledWith(false);
});

it("hides a foreign owner's capture in the page and global recording bar", async () => {
  h.snap.state = "recording"; h.snap.owner = "another-owner";
  const tree = await ready();
  expect(nodes(tree).some(n => n.type === "live-meeting")).toBe(false);
  expect(text(tree)).not.toContain("Planung");
  h.slots = []; h.effects = [];
  expect(render(RecordingBar)).toBeNull();
});

it("keeps the recording clock outside meaningful live announcements", () => {
  h.snap.state = "recording";
  const tree = render(RecordingBar);
  expect(tree.props.role).not.toBe("status");
  const statuses = nodes(tree).filter(n => n.props?.role === "status");
  expect(statuses).toHaveLength(1);
  expect(text(statuses[0])).toContain("Aufnahme läuft");
  expect(text(statuses[0])).not.toContain("00:03");
  expect(nodes(statuses[0]).some(n => n.type === "button")).toBe(false);
});

it("exposes selected consent choices and a named add-person action", () => {
  const decision = { method: "spoken" as const, participants: [{ name: "Anna", stance: "silent" as const }], language: "de" as const, address: "du" as const, folderName: "Archiv", retention: { audioDays: 30, textDays: null } };
  const tree = render(() => ArmedMeeting({ sources: ["mic"], text: "Notice", decision, onDecision: vi.fn(), onDraft: vi.fn(), onResetDraft: vi.fn(), drafting: false, draftError: "", chat: [], hasDraft: false }));
  expect(button(tree, "Deutsch").props["aria-pressed"]).toBe(true);
  expect(button(tree, "English").props["aria-pressed"]).toBe(false);
  expect(button(tree, "Anna: Noch nicht zugestimmt").props["aria-pressed"]).toBe(true);
  expect(button(tree, "Person hinzufügen").props["aria-label"]).toBe("Person hinzufügen");
});

it("refocuses every in-place sheet step and lets Escape recover from body focus without stealing a picker", () => {
  const close = vi.fn(); const focus = vi.fn(); const listeners: Record<string, any> = {};
  const body = {}; const picker = {}; const doc = { body, activeElement: body, addEventListener: (name: string, fn: any) => { listeners[name] = fn; }, removeEventListener: vi.fn() };
  vi.stubGlobal("document", doc);
  const element = { focus: () => { focus(); doc.activeElement = element; }, contains: (node: any) => node === element };
  let tree = render(() => RecordingSheet({ title: "Optionen", onClose: close, children: "Schritt eins" }));
  nodes(tree).find(n => n.props?.role === "dialog").props.ref.current = element;
  for (const effect of h.effects.splice(0)) effect();
  focus.mockClear(); doc.activeElement = body;
  tree = render(() => RecordingSheet({ title: "Speicherort", onClose: close, children: "Schritt zwei" }));
  for (const effect of h.effects.splice(0)) effect();
  expect(focus).toHaveBeenCalledTimes(1);
  doc.activeElement = body;
  listeners.keydown({ key: "Escape", preventDefault: vi.fn() });
  expect(close).toHaveBeenCalledTimes(1);
  doc.activeElement = picker;
  listeners.keydown({ key: "Escape", preventDefault: vi.fn() });
  expect(close).toHaveBeenCalledTimes(1);
});

it("uses view-selector buttons rather than incomplete tab semantics in the live meeting", async () => {
  const { default: LiveMeeting } = await vi.importActual<typeof import("./LiveMeeting")>("./LiveMeeting");
  let tree = render(() => LiveMeeting({ transcript: "Beitrag", pending: 0, paused: false, timer: "00:03" }));
  expect(button(tree, "Transkript").props["aria-pressed"]).toBe(true);
  expect(nodes(tree).some(n => n.props?.role === "tablist")).toBe(false);
  button(tree, "Assistent").props.onClick();
  tree = render(() => LiveMeeting({ transcript: "Beitrag", pending: 0, paused: false, timer: "00:04" }));
  expect(button(tree, "Assistent").props["aria-pressed"]).toBe(true);
  expect(button(tree, "Transkript").props["aria-pressed"]).toBe(false);
});

it("requires renewed approval when prepared capture facts change", async () => {
  h.snap.state = "armed"; h.snap.sources = ["mic", "system"];
  let tree = await ready();
  nodes(tree).find(n => n.type === ArmedMeeting).props.onDecision({ participants: [{ name: "Alle Anwesenden", stance: "agreed" }] });
  tree = render();
  expect(button(tree, "Einwilligung erteilt").props.disabled).toBe(false);
  h.snap = { ...h.snap, sources: ["mic"] };
  tree = render();
  expect(button(tree, "Einwilligung erteilt").props.disabled).toBe(true);
});
