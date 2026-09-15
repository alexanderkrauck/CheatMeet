import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConsentRecord, consentFacts } from "../../shared/consent";

vi.mock("./firebase", () => ({ auth: { currentUser: { uid: "capture-test" } } }));
vi.mock("./local", () => ({
  appendRecordingChunk: vi.fn().mockResolvedValue(undefined),
  deleteDraft: vi.fn().mockResolvedValue(undefined),
  getDraft: vi.fn().mockResolvedValue(undefined),
  putDraft: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./session", () => ({ errorMessage: (error: Error) => error.message }));
vi.mock("./useRecordingLifecycle", () => ({ observeRecordingLifecycle: ({ recorder, onInterrupted }: any) => {
  if (recorder.state === "inactive") onInterrupted("inactive");
  return () => {};
} }));
vi.mock("./audioMerge", () => ({
  mergeAudioStreams: (mic: MediaStream) => ({ stream: mic, dispose() {} }),
}));
vi.mock("./assemblyLive", () => ({
  startAssemblyLive: vi.fn(() => ({
    tick() {}, finish: async () => "", pendingSegments: 0, failedSegments: 0,
  })),
}));

/** A real MediaStreamTrack is an EventTarget and fires "ended". */
class FakeTrack extends EventTarget {
  kind: string;
  constructor(kind = "audio") {
    super();
    this.kind = kind;
  }
  readyState = "live";
  muted = false;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [new FakeTrack()]) {
    this.tracks = tracks;
  }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  getTracks() { return this.tracks; }
}

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  onstop?: () => void;
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.onstop?.(); }
}

const capture = await import("./capture");
const { startAssemblyLive } = await import("./assemblyLive");
let getDisplayMedia: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  getDisplayMedia = vi.fn().mockResolvedValue(new FakeStream());
  vi.stubGlobal("navigator", {
    onLine: false,
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue(new FakeStream()),
      getDisplayMedia,
    },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("window", { MediaRecorder: FakeRecorder, setInterval: () => undefined });
  vi.stubGlobal("document", {});
  await capture.openDraft("capture-test", undefined, true);
});

afterEach(async () => {
  capture.stopCapture();
  await capture.finishTranscription();
  await capture.discardCapture();
  vi.unstubAllGlobals();
});

describe("discardCapture", () => {
  it("resets to an empty capture and hands back nothing to navigate to", async () => {
    // It used to return the id of the fresh blank draft, and the only caller
    // read that as a destination — so asking to discard left the user standing
    // on the recorder looking at the take they had just thrown away.
    await capture.startCapture(true, async () => {}, "mic");
    const discarded = capture.captureSnapshot().draft.report.id;
    capture.stopCapture();
    await capture.finishTranscription();
    expect(await capture.discardCapture()).toBeUndefined();
    const after = capture.captureSnapshot();
    expect(after.state).toBe("ready");
    expect(after.draft.report.id).not.toBe(discarded);
    expect(after.draft.audio).toBeUndefined();
  });
});

describe("recording audio-source selection", () => {
  it("opens sharing in the click before asynchronous Drive verification", async () => {
    Object.defineProperty(navigator, "onLine", { value: true });
    let verified!: () => void;
    const pending = capture.startCapture(false, () => new Promise<void>(resolve => { verified = resolve; }), "mic+system");
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    verified(); await pending;
    expect(capture.captureSnapshot()).toMatchObject({ state: "recording", warning: "" });
  });
  it("starts mic-only without requesting screen sharing", async () => {
    await capture.startCapture(true, async () => {}, "mic");
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(capture.captureSnapshot()).toMatchObject({ state: "recording", warning: "", error: "" });
    expect(vi.mocked(startAssemblyLive).mock.calls[0][0].system).toBeUndefined();
  });

  it("removes the orphaned draft when audio is imported over a recording", async () => {
    const { deleteDraft } = await import("./local");
    vi.mocked(deleteDraft).mockClear();
    const before = capture.captureSnapshot().draft.report.id;
    await capture.importAudio(
      new File(["x"], "a.m4a", { type: "audio/m4a" }),
    );
    const after = capture.captureSnapshot().draft.report.id;
    expect(after).not.toBe(before);
    // Otherwise it lingers as an unfinished recording with no audio.
    expect(deleteDraft).toHaveBeenCalledWith("capture-test", before);
  });

  it("keeps recording when the user stops sharing their screen", async () => {
    const systemTrack = new FakeTrack();
    getDisplayMedia.mockResolvedValue(new FakeStream([systemTrack]));
    await capture.startCapture(true, async () => {}, "mic+system");
    expect(capture.captureSnapshot()).toMatchObject({ state: "recording" });

    // Chrome's "Freigabe beenden", or the shared tab being closed.
    systemTrack.end();

    const snap = capture.captureSnapshot();
    // The microphone is still live, so the meeting must continue.
    expect(snap.state).toBe("recording");
    expect(snap.warning).toContain("Bildschirmfreigabe");
    expect(systemTrack.stop).toHaveBeenCalled();
  });

  it("still ends the recording when the microphone itself dies", async () => {
    const micTrack = new FakeTrack();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(
      new FakeStream([micTrack]) as unknown as MediaStream,
    );
    await capture.startCapture(true, async () => {}, "mic");
    expect(capture.captureSnapshot()).toMatchObject({ state: "recording" });
    expect(micTrack.readyState).toBe("live");
  });

  it("requests sharing and passes the two audio sources separately", async () => {
    await capture.startCapture(true, async () => {}, "mic+system");
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    const sources = vi.mocked(startAssemblyLive).mock.calls[0][0];
    expect(sources.mic).toBeDefined();
    expect(sources.system).toBeDefined();
    expect(sources.mic).not.toBe(sources.system);
    expect(capture.captureSnapshot().state).toBe("recording");
  });

  it("continues with mic-only and a warning when sharing is cancelled", async () => {
    getDisplayMedia.mockRejectedValue(new DOMException("Cancelled", "NotAllowedError"));
    await capture.startCapture(true, async () => {}, "mic+system");
    expect(capture.captureSnapshot()).toMatchObject({ state: "recording", error: "" });
    expect(capture.captureSnapshot().warning).toContain("nicht freigegeben");
    expect(vi.mocked(startAssemblyLive).mock.calls[0][0].system).toBeUndefined();
  });

  it("does not transcribe a screen share without audio", async () => {
    getDisplayMedia.mockResolvedValue(new FakeStream([new FakeTrack("video")]));
    await capture.startCapture(true, async () => {}, "mic+system");
    expect(capture.captureSnapshot().state).toBe("recording");
    expect(capture.captureSnapshot().warning).toContain("kein Systemaudio");
    expect(vi.mocked(startAssemblyLive).mock.calls[0][0].system).toBeUndefined();
  });

  it("continues with mic-only when the browser cannot share a screen", async () => {
    delete navigator.mediaDevices.getDisplayMedia;
    await capture.startCapture(true, async () => {}, "mic+system");
    expect(capture.captureSnapshot().state).toBe("recording");
    expect(capture.captureSnapshot().warning).toContain("keine Bildschirmfreigabe");
    expect(vi.mocked(startAssemblyLive).mock.calls[0][0].system).toBeUndefined();
  });
});
it("retains a live speaker name through partials and final live updates", async () => {
  await capture.startCapture(true, async () => {}, "mic");
  const changed = vi.mocked(startAssemblyLive).mock.calls[0][2];
  const speech = { provider: "assemblyai", phase: "live", languages: ["de"], speakerNames: { "mic:0:A": "Sprecher 1" },
    turns: [{ id: "mic:0:0", speaker: "mic:0:A", text: "Hallo", startMs: 0, endMs: 1000, final: true }] } as const;
  changed(structuredClone(speech) as any);
  capture.setCaptureSpeakerName("mic:0:A", "Alex");
  changed({ ...structuredClone(speech), phase: "pending" } as any);
  expect(capture.captureSnapshot().draft.report.speech?.speakerNames["mic:0:A"]).toBe("Alex");
  expect(capture.captureSnapshot().draft.report.transcription).toContain("Mikrofon · Alex");
  await capture.finishTranscription();
  expect(capture.captureSnapshot().draft.report.transcription).toContain("Mikrofon · Alex");
  expect(capture.captureSnapshot().draft.report.transcriptionOrigin).toBe("live");
});

it("treats a replacement import as new audio and clears old recording provenance", async () => {
  await capture.startCapture(true, async () => {}, "mic");
  capture.stopCapture(); await capture.finishTranscription();
  const draft = capture.captureSnapshot().draft;
  const previous = draft.report.id;
  // Every optional field carries a recognisable value, so a field added to
  // ReportData later fails this test until it is deliberately classified as
  // minted, surviving, or cleared. An inherited value would attach one
  // meeting's consent, deletion deadline or Drive file to another recording.
  const populated = {
    id: previous, date: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-02T00:00:00.000Z",
    projectName: "Projekt", title: "Titel", suggestedTitle: "Vorschlag",
    summary: "Alte Zusammenfassung", transcription: "Alter Text",
    todos: [{ text: "alt", done: false }], takeaways: ["alt"],
    status: "completed" as const, error: "Alter Fehler", durationMs: 4321,
    captureState: "stopped" as const, transcriptionOrigin: "live" as const,
    captureSources: ["mic", "system"] as ("mic" | "system")[],
    singleSpeakerSources: { mic: true },
    rawAudioUrl: "alte-audio-id", driveFolderId: "ordner", driveReportId: "json",
    driveMarkdownId: "md", driveTranscriptId: "transkript", driveConsentId: "einwilligung",
    driveSyncedAt: "2020-01-02T00:00:00.000Z",
    consent: buildConsentRecord(
      consentFacts({ sources: ["mic"], folderName: "Ordner", retention: { audioDays: 30, textDays: null } }),
      { obtainedAt: "2020-01-01T00:00:00.000Z", method: "spoken", allInformed: true },
    ),
    audioDeletedAt: "2020-02-01T00:00:00.000Z", audioDeleteAttempts: 2,
    audioDeleteError: "alter Fehler", transcriptChars: 99,
    participants: ["Alex"], speakerReviewPending: true,
    calendarEventId: "ev", calendarId: "cal", calendarLink: "https://example.test",
    calendarSyncedAt: "2020-01-02T00:00:00.000Z", calendarError: "alter Kalenderfehler",
  };
  Object.assign(draft.report, populated);
  await capture.importAudio(new File(["audio"], "import.webm", {type:"audio/webm"}));
  const next = capture.captureSnapshot().draft;
  const report = next.report as unknown as Record<string, unknown>;

  // Freshly minted for the new meeting.
  expect(next.report.id).not.toBe(previous);
  expect(next.report.date).not.toBe(populated.date);
  expect(next.report.transcriptionOrigin).toBe("import");
  expect(next.report.status).toBe("pending");
  expect(next.report.transcription).toBe("");
  expect(next.report.summary).toBe("");
  expect(next.report.error).toBe("");
  expect(next.report.todos).toEqual([]);
  expect(next.report.takeaways).toEqual([]);
  expect(next.report.durationMs).toBe(0);
  expect(next.report.speech?.phase).toBe("pending");
  expect(next.report.speech?.turns).toEqual([]);
  expect(next.speakerReference).toBeUndefined();

  const minted = new Set(["id", "date", "transcriptionOrigin", "status", "transcription",
    "summary", "error", "todos", "takeaways", "durationMs", "speech"]);
  // A name the user typed is theirs, not the previous recording's provenance.
  const survives = new Set(["title", "projectName", "suggestedTitle"]);
  for (const key of Object.keys(populated))
    if (!minted.has(key) && !survives.has(key))
      expect(report[key], `${key} must not survive an import`).toBeUndefined();
  for (const key of survives)
    expect(report[key], `${key} must survive an import`).toBeDefined();
});

it("persists independent single-person choices, passes them to streaming and locks them during capture", async () => {
  capture.setCaptureSingleSpeaker("mic", true);
  capture.setCaptureSingleSpeaker("system", true);
  capture.setCaptureSingleSpeaker("system", false);
  expect(capture.captureSnapshot().draft.report.singleSpeakerSources).toEqual({mic: true, system: false});
  await capture.startCapture(true, async () => {}, "mic+system");
  expect(vi.mocked(startAssemblyLive).mock.calls[0][5]).toEqual({mic: true, system: false});
  capture.setCaptureSingleSpeaker("mic", false);
  expect(capture.captureSnapshot().draft.report.singleSpeakerSources?.mic).toBe(true);
  capture.stopCapture();
  await capture.finishTranscription();
  await capture.importAudio(new File(["test"], "import.wav", {type: "audio/wav"}));
  expect(capture.captureSnapshot().draft.report.singleSpeakerSources).toBeUndefined();
});
