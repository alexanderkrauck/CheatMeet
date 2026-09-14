import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./firebase", () => ({ auth: { currentUser: { uid: "capture-test" } } }));
vi.mock("./local", () => ({
  appendRecordingChunk: vi.fn(), deleteDraft: vi.fn(),
  getDraft: vi.fn(), putDraft: vi.fn(),
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

class FakeStream {
  constructor(private tracks = [{ kind: "audio", stop: vi.fn() }]) {}
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
    getDisplayMedia.mockResolvedValue(new FakeStream([{ kind: "video", stop: vi.fn() }]));
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
  const previous = capture.captureSnapshot().draft.report.id;
  await capture.importAudio(new File(["audio"], "import.webm", {type:"audio/webm"}));
  const next = capture.captureSnapshot().draft;
  expect(next.report.id).not.toBe(previous);
  expect(next.report.transcriptionOrigin).toBe("import");
  expect(next.report.captureState).toBeUndefined();
  expect(next.report.captureSources).toBeUndefined();
  expect(next.speakerReference).toBeUndefined();
});
