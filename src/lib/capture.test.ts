import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assembleConsentText,
  buildConsentRecord,
  consentFacts,
  decisionFacts,
  type ConsentDecision,
} from "../../shared/consent";

const account = vi.hoisted(() => ({ uid: "capture-test" }));
it("freezes OneDrive home before the notice and refuses changing it after arming",async()=>{
 const c=await import("./capture");await c.openDraft("capture-test",undefined,true);
 const home={provider:"microsoft" as const,connectionId:"c",driveId:"d",rootId:"root",rootName:"Meetings"};c.setCaptureHome(home);
 await c.armCapture(true,async()=>{},"mic");c.setCaptureHome(null);expect(c.captureSnapshot().draft.report.home).toEqual(home);
 c.disarmCapture();
});
vi.mock("./firebase", () => ({ auth: { get currentUser() { return account; } } }));
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
const share = vi.hoisted(() => ({
  update: vi.fn(),
  setState: vi.fn(),
  end: vi.fn(async () => {}),
  status: vi.fn(() => "waiting" as const),
}));
vi.mock("./liveShare", () => ({ startLiveShare: vi.fn(() => share) }));
vi.mock("./assemblyLive", () => ({
  startAssemblyLive: vi.fn(() => ({
    tick() {}, finish: async () => "", pendingSegments: 0, failedSegments: 0,
    restart: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
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
  /** The instance capture just built, so tests can read its real state. */
  static last: FakeRecorder | undefined;
  constructor() { FakeRecorder.last = this; }
  state = "inactive";
  onstop?: () => void;
  ondataavailable?: (event: { data: Blob }) => void;
  start() { this.state = "recording"; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  requestData() {}
  stop() { this.state = "inactive"; this.onstop?.(); }
}

const DECISION: ConsentDecision = {
  method: "spoken",
  participants: [{ name: "Sergio", stance: "agreed" as const }],
  language: "de",
  address: "du",
  folderName: "Ordner",
  retention: { audioDays: 30, textDays: null },
};

const capture = await import("./capture");

/** Arm, then consent — what every test that wants a running recording does. */
const startRecording = async (
  ...args: Parameters<typeof capture.armCapture>
) => {
  await capture.armCapture(...args);
  await capture.beginRecording(DECISION);
};
const { startAssemblyLive } = await import("./assemblyLive");
const { startLiveShare } = await import("./liveShare");
let getDisplayMedia: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  account.uid = "capture-test";
  FakeRecorder.last = undefined;
  getDisplayMedia = vi.fn().mockResolvedValue(new FakeStream());
  vi.stubGlobal("navigator", {
    onLine: false,
    mediaDevices: {
      getUserMedia: vi.fn(async () => new FakeStream()),
      getDisplayMedia,
    },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { MediaRecorder: FakeRecorder, setInterval: () => undefined }));
  vi.stubGlobal("document", {});
  await capture.openDraft("capture-test", undefined, true);
});

afterEach(async () => {
  await capture.handleCaptureOwnerChange(null);
  vi.unstubAllGlobals();
});

it("keeps retranscription opt-in on the finished draft and clears it on a replacement import", async () => {
  expect(capture.captureSnapshot().draft.retranscribe).not.toBe(true);
  await startRecording(true, async () => {}, "mic");
  capture.setCaptureRetranscribe(true);
  expect(capture.captureSnapshot().draft.retranscribe).not.toBe(true);
  FakeRecorder.last!.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
  capture.stopCapture();
  await capture.finishTranscription();
  capture.setCaptureRetranscribe(true);
  await capture.captureQueue();
  expect(capture.captureSnapshot().draft.retranscribe).toBe(true);
  const { putDraft } = await import("./local");
  expect(vi.mocked(putDraft).mock.calls.at(-1)?.[1].retranscribe).toBe(true);
  await capture.importAudio(new File(["other"], "other.webm", { type: "audio/webm" }));
  expect(capture.captureSnapshot().draft.retranscribe).not.toBe(true);
});

it("persists a backup-only choice through trailing transcript writes without changing retranscription", async () => {
  await startRecording(true, async () => {}, "mic");
  FakeRecorder.last!.ondataavailable?.({ data: new Blob(["audio"]) });
  capture.stopCapture();
  await capture.setCaptureProcessing(false);
  await capture.finishTranscription();
  await capture.captureQueue();
  const { putDraft } = await import("./local");
  expect(vi.mocked(putDraft).mock.calls.at(-1)?.[1]).toMatchObject({ processing: { analyze: false } });
  expect(capture.captureSnapshot().draft.retranscribe).not.toBe(true);
});

it("keeps an uncertain source checkpoint when the save choice is confirmed again", async () => {
  await startRecording(true, async () => {}, "mic");
  capture.stopCapture();
  await capture.finishTranscription();
  capture.captureSnapshot().draft.processing = { analyze: true, sourceReady: true };
  await capture.setCaptureProcessing(true);
  expect(capture.captureSnapshot().draft.processing?.sourceReady).toBe(true);
});

describe("discardCapture", () => {
  it("resets to an empty capture and hands back nothing to navigate to", async () => {
    // It used to return the id of the fresh blank draft, and the only caller
    // read that as a destination — so asking to discard left the user standing
    // on the recorder looking at the take they had just thrown away.
    await startRecording(true, async () => {}, "mic");
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
    const pending = capture.armCapture(false, () => new Promise<void>(resolve => { verified = resolve; }), "mic+system");
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    verified(); await pending;
    expect(capture.captureSnapshot()).toMatchObject({ state: "armed", warning: "" });
  });
  it("starts mic-only without requesting screen sharing", async () => {
    await startRecording(true, async () => {}, "mic");
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
    await startRecording(true, async () => {}, "mic+system");
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
    await startRecording(true, async () => {}, "mic");
    expect(capture.captureSnapshot()).toMatchObject({ state: "recording" });
    expect(micTrack.readyState).toBe("live");
  });

  it("requests sharing and passes the two audio sources separately", async () => {
    await startRecording(true, async () => {}, "mic+system");
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    const sources = vi.mocked(startAssemblyLive).mock.calls[0][0];
    expect(sources.mic).toBeDefined();
    expect(sources.system).toBeDefined();
    expect(sources.mic).not.toBe(sources.system);
    expect(capture.captureSnapshot().state).toBe("recording");
  });

  it("continues with mic-only and a warning when sharing is cancelled", async () => {
    getDisplayMedia.mockRejectedValue(new DOMException("Cancelled", "NotAllowedError"));
    await startRecording(true, async () => {}, "mic+system");
    expect(capture.captureSnapshot()).toMatchObject({ state: "recording", error: "" });
    expect(capture.captureSnapshot().warning).toContain("nicht freigegeben");
    expect(vi.mocked(startAssemblyLive).mock.calls[0][0].system).toBeUndefined();
  });

  it("does not transcribe a screen share without audio", async () => {
    getDisplayMedia.mockResolvedValue(new FakeStream([new FakeTrack("video")]));
    await startRecording(true, async () => {}, "mic+system");
    expect(capture.captureSnapshot().state).toBe("recording");
    expect(capture.captureSnapshot().warning).toContain("kein Systemaudio");
    expect(vi.mocked(startAssemblyLive).mock.calls[0][0].system).toBeUndefined();
  });

  it("continues with mic-only when the browser cannot share a screen", async () => {
    delete navigator.mediaDevices.getDisplayMedia;
    await startRecording(true, async () => {}, "mic+system");
    expect(capture.captureSnapshot().state).toBe("recording");
    expect(capture.captureSnapshot().warning).toContain("keine Bildschirmfreigabe");
    expect(vi.mocked(startAssemblyLive).mock.calls[0][0].system).toBeUndefined();
  });
});
it("retains a live speaker name through partials and final live updates", async () => {
  await startRecording(true, async () => {}, "mic");
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

describe("sharing the live transcript with an assistant", () => {
  const speechOf = (text: string) => ({
    provider: "assemblyai", phase: "live", languages: ["de"], speakerNames: {},
    turns: [{ id: "1", speaker: "mic:0:A", text, startMs: 0, endMs: 900, final: true }],
  }) as any;

  it("starts with the recording, and not before consent", async () => {
    await capture.armCapture(true, async () => {}, "mic");
    expect(startLiveShare).not.toHaveBeenCalled();
    await capture.beginRecording(DECISION);
    expect(startLiveShare).toHaveBeenCalledOnce();
    expect(vi.mocked(startLiveShare).mock.calls[0][0]).toMatchObject({ reportId: capture.captureSnapshot().draft.report.id, languages: expect.any(Array) });
  });
  it("is fed every transcript change, and the connection state stays out of what it receives", async () => {
    await startRecording(true, async () => {}, "mic");
    const changed = vi.mocked(startAssemblyLive).mock.calls[0][2];
    changed({ ...speechOf("Hallo"), liveConnection: "live" });
    expect(share.update).toHaveBeenCalledOnce();
    const passed = share.update.mock.calls[0][0];
    expect(passed.turns[0].text).toBe("Hallo");
    expect(passed).not.toHaveProperty("liveConnection");
  });
  it("mirrors pause and resume", async () => {
    await startRecording(true, async () => {}, "mic");
    capture.pauseCapture();
    expect(share.setState).toHaveBeenLastCalledWith("paused");
    capture.pauseCapture();
    expect(share.setState).toHaveBeenLastCalledWith("recording");
  });
  it("sends the last words only after the final transcription has drained", async () => {
    await startRecording(true, async () => {}, "mic");
    const order: string[] = [];
    const live = vi.mocked(startAssemblyLive).mock.results[0].value;
    live.finish = vi.fn(async () => { order.push("drain"); return ""; });
    share.end.mockImplementation(async () => { order.push("end"); });
    capture.stopCapture();
    await capture.finishTranscription();
    expect(order).toEqual(["drain", "end"]);
  });
  it("ends on every way a session can stop", async () => {
    await startRecording(true, async () => {}, "mic");
    capture.disarmCapture();
    expect(share.end).toHaveBeenCalledTimes(1);
    share.end.mockClear();
    await startRecording(true, async () => {}, "mic");
    expect(capture.captureSnapshot()).toMatchObject({ state: "recording", error: "" });
    await capture.discardCapture();
    expect(share.end).toHaveBeenCalledTimes(1);
    share.end.mockClear();
    await startRecording(true, async () => {}, "mic");
    capture.stopCapture();
    await capture.finishTranscription();
    capture.releaseAfterHandoff();
    expect(share.end).toHaveBeenCalledTimes(1);
  });
  it("stops sharing when the account changes", async () => {
    await startRecording(true, async () => {}, "mic");
    const changed = vi.mocked(startAssemblyLive).mock.calls[0][2];
    account.uid = "someone-else";
    share.update.mockClear();
    changed(speechOf("fremd"));
    expect(share.update).not.toHaveBeenCalled();
    expect(share.end).toHaveBeenCalled();
  });
  it("never lets a failing share break the recording", async () => {
    share.update.mockImplementationOnce(() => { throw new Error("boom"); });
    await startRecording(true, async () => {}, "mic");
    const changed = vi.mocked(startAssemblyLive).mock.calls[0][2];
    expect(() => changed(speechOf("Hallo"))).not.toThrow();
    expect(capture.captureSnapshot().draft.report.transcription).toContain("Hallo");
    expect(FakeRecorder.last?.state).toBe("recording");
  });
});

describe("live connection health", () => {
  const speechWith = (liveConnection?: string) => ({
    provider: "assemblyai", phase: "live", languages: ["de"], speakerNames: {}, turns: [],
    ...(liveConnection ? { liveConnection } : {}),
  }) as any;

  it("shows the connection state in its own field and never stores it in the transcript", async () => {
    await startRecording(true, async () => {}, "mic");
    const changed = vi.mocked(startAssemblyLive).mock.calls[0][2];
    changed(speechWith("reconnecting"));
    expect(capture.captureSnapshot().liveConnection).toBe("reconnecting");
    expect(capture.captureSnapshot().draft.report.speech).not.toHaveProperty("liveConnection");
    changed(speechWith("live"));
    expect(capture.captureSnapshot().liveConnection).toBe("live");
    changed(speechWith());
    expect(capture.captureSnapshot().liveConnection).toBeUndefined();
  });

  it("restartLive() rebuilds the connections without pausing the recording or the clock", async () => {
    await startRecording(true, async () => {}, "mic");
    const live = vi.mocked(startAssemblyLive).mock.results[0].value;
    const before = capture.captureSnapshot();
    capture.restartLive();
    expect(live.restart).toHaveBeenCalledOnce();
    expect(FakeRecorder.last?.state).toBe("recording");
    expect(capture.captureSnapshot().state).toBe("recording");
    expect(capture.captureSnapshot().durationMs).toBeGreaterThanOrEqual(before.durationMs);
  });

  it("restartLive() does nothing when nothing is recording", () => {
    expect(() => capture.restartLive()).not.toThrow();
  });
});

it("treats a replacement import as new audio and clears old recording provenance", async () => {
  await startRecording(true, async () => {}, "mic");
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
      { obtainedAt: "2020-01-01T00:00:00.000Z", method: "spoken", participants: [{ name: "Sergio", stance: "agreed" as const }] },
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
  await startRecording(true, async () => {}, "mic+system");
  expect(vi.mocked(startAssemblyLive).mock.calls[0][5]).toEqual({mic: true, system: false});
  capture.setCaptureSingleSpeaker("mic", false);
  expect(capture.captureSnapshot().draft.report.singleSpeakerSources?.mic).toBe(true);
  capture.stopCapture();
  await capture.finishTranscription();
  await capture.importAudio(new File(["test"], "import.wav", {type: "audio/wav"}));
  expect(capture.captureSnapshot().draft.report.singleSpeakerSources).toBeUndefined();
});

it("requires renewed confirmation instead of storing different wording from the approved notice", async () => {
  const systemTrack = new FakeTrack();
  getDisplayMedia.mockResolvedValue(new FakeStream([systemTrack]));
  await capture.armCapture(true, async () => {}, "mic+system");
  const approved = { ...DECISION, parts: { means: "Das Mikrofon und der Call werden mit AssemblyAI und Google Gemini verarbeitet." } };
  systemTrack.end();
  await capture.beginRecording(approved);
  expect(capture.captureSnapshot().state).toBe("ready");
  expect(capture.captureSnapshot().error).toContain("Hinweis");
  expect(startAssemblyLive).not.toHaveBeenCalled();
  expect(startLiveShare).not.toHaveBeenCalled();
});

it.each(["cancel", "owner"])("releases late permission results after %s instead of arming another attempt", async mode => {
  const micTrack = new FakeTrack();
  const systemTrack = new FakeTrack();
  getDisplayMedia.mockResolvedValue(new FakeStream([systemTrack]));
  let resolve!: (stream: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = capture.armCapture(true, async () => {}, "mic+system");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  if (mode === "owner") {
    account.uid = "next-owner";
    await capture.handleCaptureOwnerChange(account.uid);
  } else capture.disarmCapture();
  resolve(new FakeStream([micTrack]) as unknown as MediaStream);
  await pending;
  expect(micTrack.readyState).toBe("ended");
  expect(systemTrack.readyState).toBe("ended");
  expect(capture.captureSnapshot()).toMatchObject({ owner: account.uid, state: "ready", busy: "" });
  expect(startAssemblyLive).not.toHaveBeenCalled();
  let resolveLock!: (lock: WakeLockSentinel) => void;
  Object.assign(navigator, { wakeLock: { request: () => new Promise(done => { resolveLock = done; }) } });
  Object.assign(document, { visibilityState: "visible" });
  await capture.armCapture(true, async () => {}, "mic");
  capture.disarmCapture();
  const release = vi.fn(async () => {});
  resolveLock({ release, addEventListener() {} } as unknown as WakeLockSentinel);
  await Promise.resolve();
  expect(release).toHaveBeenCalledOnce();
  expect(capture.captureSnapshot().state).toBe("ready");
});

it.each(["recording", "paused"])("fences a %s owner transition immediately while preserving the old checkpoint", async phase => {
  const { deleteDraft, putDraft, appendRecordingChunk, getDraft } = await import("./local");
  await startRecording(true, async () => {}, "mic");
  const oldId = capture.captureSnapshot().draft.report.id;
  expect(await capture.openDraft(account.uid, undefined, true)).toBe(oldId);
  await capture.handleCaptureOwnerChange(account.uid);
  expect(FakeRecorder.last?.state).toBe("recording");
  vi.mocked(startAssemblyLive).mock.calls[0][2]({ provider: "assemblyai", phase: "live", languages: ["de"], speakerNames: {},
    turns: [{ id: "private", speaker: "mic:0:A", text: "Privates Gespräch", startMs: 0, endMs: 1000, final: true }] });
  FakeRecorder.last!.ondataavailable?.({ data: new Blob(["private-audio"]) });
  if (phase === "paused") capture.pauseCapture();
  const rec = FakeRecorder.last!;
  rec.stop = () => {
    rec.state = "inactive";
    queueMicrotask(() => {
      rec.ondataavailable?.({ data: new Blob(["trailing-audio"]) });
      rec.onstop?.();
    });
  };
  account.uid = "next-owner";
  const transition = capture.handleCaptureOwnerChange(account.uid);
  const foreignTranscript = capture.finishTranscription();
  expect(capture.captureSnapshot().draft.report.id).not.toBe(oldId);
  expect(capture.isCapturing()).toBe(false);
  capture.pauseCapture();
  expect(FakeRecorder.last?.state).toBe("inactive");
  await transition;
  expect(await foreignTranscript).toBe("");
  expect(deleteDraft).not.toHaveBeenCalled();
  expect(appendRecordingChunk).toHaveBeenCalledWith("capture-test", oldId, 0, expect.any(Blob), expect.any(Number), false);
  expect(appendRecordingChunk).toHaveBeenCalledWith("capture-test", oldId, 1, expect.any(Blob), expect.any(Number), false);
  expect(vi.mocked(putDraft).mock.calls.some(([owner, draft]) => owner === "capture-test" && draft.report.id === oldId && draft.report.captureState === "stopped")).toBe(true);
  const newId = await capture.openDraft(account.uid, undefined, true);
  expect(newId).not.toBe(oldId);
  expect(capture.captureSnapshot().owner).toBe(account.uid);
  expect(getDraft).not.toHaveBeenCalledWith("next-owner", oldId);
});

it("recovers the newer in-memory take on return after an owner checkpoint fails", async () => {
  const { appendRecordingChunk, getDraft, putDraft, deleteDraft } = await import("./local");
  const mic = new FakeTrack();
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(new FakeStream([mic]) as unknown as MediaStream);
  await startRecording(true, async () => {}, "mic");
  const rec = FakeRecorder.last!;
  rec.ondataavailable?.({ data: new Blob(["older-"]) });
  await capture.captureQueue();
  const older = structuredClone(capture.captureSnapshot().draft);
  const changed = vi.mocked(startAssemblyLive).mock.calls[0][2];
  changed({ provider: "assemblyai", phase: "live", languages: ["de"], speakerNames: {},
    turns: [{ id: "new", speaker: "mic:0:A", text: "Neuere Worte", startMs: 0, endMs: 1000, final: true }] });
  vi.mocked(appendRecordingChunk).mockRejectedValue(new Error("journal unavailable"));
  rec.ondataavailable?.({ data: new Blob(["newer-"]) });
  await capture.captureQueue().catch(() => {});
  rec.stop = () => {
    rec.state = "inactive";
    queueMicrotask(() => {
      rec.ondataavailable?.({ data: new Blob(["trailing"]) });
      rec.onstop?.();
    });
  };
  try {
    account.uid = "next-owner";
    const transition = capture.handleCaptureOwnerChange(account.uid);
    expect(mic.readyState).toBe("ended");
    expect(share.end).toHaveBeenCalled();
    expect(capture.captureSnapshot().draft.report.transcription).toBe("");
    await expect(transition).rejects.toThrow("journal unavailable");
  } finally {
    vi.mocked(appendRecordingChunk).mockResolvedValue(undefined);
  }
  account.uid = "capture-test";
  vi.mocked(getDraft).mockResolvedValueOnce(older);
  await capture.handleCaptureOwnerChange(account.uid);
  expect(await capture.openDraft(account.uid, older.report.id, false)).toBe(older.report.id);
  const recovered = capture.captureSnapshot();
  expect(await recovered.draft.audio!.text()).toBe("older-newer-trailing");
  expect(recovered.draft.report.transcription).toContain("Neuere Worte");
  expect(recovered).toMatchObject({ state: "review", saved: true });
  expect(getDraft).not.toHaveBeenCalled();
  expect(vi.mocked(putDraft).mock.calls.at(-1)?.[1].report.transcription).toContain("Neuere Worte");
  expect(deleteDraft).not.toHaveBeenCalled();
  vi.mocked(getDraft).mockReset().mockResolvedValue(undefined);
});

it("keeps release blocked by private state while a failed owner's take is hidden", async () => {
  const { appendRecordingChunk } = await import("./local");
  expect(capture.canReleaseCapture()).toBe(true);
  capture.setCaptureBusy("Speichern …");
  expect(capture.canReleaseCapture()).toBe(false);
  capture.setCaptureBusy("");
  await capture.armCapture(true, async () => {}, "mic");
  expect(capture.canReleaseCapture()).toBe(false);
  await capture.beginRecording(DECISION);
  expect(capture.canReleaseCapture()).toBe(false);
  capture.pauseCapture();
  await capture.captureQueue();
  expect(capture.canReleaseCapture()).toBe(false);
  vi.mocked(appendRecordingChunk).mockRejectedValue(new Error("journal unavailable"));
  FakeRecorder.last!.ondataavailable?.({ data: new Blob(["only-in-memory"]) });
  await capture.captureQueue().catch(() => {});
  try {
    account.uid = "next-owner";
    const transition = capture.handleCaptureOwnerChange(account.uid);
    expect(capture.captureSnapshot()).toMatchObject({ state: "ready", busy: "", error: "" });
    expect(capture.canReleaseCapture()).toBe(false);
    await expect(transition).rejects.toThrow("journal unavailable");
    expect(capture.captureSnapshot().draft.audio).toBeUndefined();
    expect(capture.canReleaseCapture()).toBe(false);
  } finally {
    vi.mocked(appendRecordingChunk).mockResolvedValue(undefined);
  }
  await capture.handleCaptureOwnerChange(account.uid);
  expect(capture.canReleaseCapture()).toBe(true);
});

it("protects unload after a failed metadata checkpoint until the retained take is durable", async () => {
  const { putDraft, getDraft, deleteDraft } = await import("./local");
  const unloading = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(unloading()).toBe(false);
  await startRecording(true, async () => {}, "mic");
  FakeRecorder.last!.ondataavailable?.({ data: new Blob(["retained-audio"]) });
  await capture.captureQueue();
  const id = capture.captureSnapshot().draft.report.id;
  vi.mocked(startAssemblyLive).mock.calls[0][2]({ provider: "assemblyai", phase: "live", languages: ["de"], speakerNames: {},
    turns: [{ id: "new", speaker: "mic:0:A", text: "Nur im Speicher", startMs: 0, endMs: 1000, final: true }] });
  vi.mocked(putDraft).mockRejectedValue(new Error("metadata unavailable"));
  try {
    account.uid = "next-owner";
    await expect(capture.handleCaptureOwnerChange(account.uid)).rejects.toThrow("metadata unavailable");
    expect(capture.captureSnapshot().draft.report.transcription).toBe("");
    expect(unloading()).toBe(true);
    account.uid = "capture-test";
    expect(await capture.openDraft(account.uid, undefined, true)).toBe(id);
    expect(getDraft).not.toHaveBeenCalled();
    expect(capture.captureSnapshot()).toMatchObject({ state: "review", saved: false });
    expect(capture.captureSnapshot().draft.report.transcription).toContain("Nur im Speicher");
    expect(await capture.captureSnapshot().draft.audio!.text()).toBe("retained-audio");
    const attempts = vi.mocked(putDraft).mock.calls.length;
    await expect(capture.handleCaptureOwnerChange(account.uid)).rejects.toThrow("metadata unavailable");
    expect(putDraft).toHaveBeenCalledTimes(attempts + 1);
    expect(capture.canReleaseCapture()).toBe(false);
    expect(unloading()).toBe(true);
  } finally {
    vi.mocked(putDraft).mockResolvedValue(undefined);
  }
  await capture.handleCaptureOwnerChange(account.uid);
  expect(capture.canReleaseCapture()).toBe(true);
  expect(unloading()).toBe(false);
  capture.releaseAfterHandoff();
  expect(capture.canReleaseCapture()).toBe(true);
  expect(deleteDraft).not.toHaveBeenCalled();
});

it.each(["cancel", "owner"])("invalidates %s while consent persistence is pending", async mode => {
  const { putDraft, appendRecordingChunk } = await import("./local");
  await capture.armCapture(true, async () => {}, "mic");
  let resolve!: () => void;
  vi.mocked(putDraft).mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const pending = capture.beginRecording(DECISION);
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  const busy = capture.captureSnapshot().busy;
  let transition: Promise<void> | undefined;
  if (mode === "owner") {
    account.uid = "next-owner";
    transition = capture.handleCaptureOwnerChange(account.uid);
  } else capture.disarmCapture();
  resolve();
  await pending;
  await transition;
  expect(busy).not.toBe("");
  expect(capture.captureSnapshot().state).toBe("ready");
  expect(startAssemblyLive).not.toHaveBeenCalled();
  expect(startLiveShare).not.toHaveBeenCalled();
  expect(appendRecordingChunk).not.toHaveBeenCalled();
  expect(FakeRecorder.last?.state).not.toBe("recording");
});

describe("the consent gate", () => {
  const recordedDraft = async () => {
    const { putDraft } = await import("./local");
    return vi
      .mocked(putDraft)
      .mock.calls.map(([, draft]) => draft)
      .reverse()
      .find((draft) => draft.report.captureState === "recording");
  };

  it("opens the devices but records and transmits nothing", async () => {
    const { appendRecordingChunk } = await import("./local");
    await capture.armCapture(true, async () => {}, "mic+system");

    expect(capture.captureSnapshot().state).toBe("armed");
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    expect(getDisplayMedia).toHaveBeenCalled();
    // Nothing reaches a provider and nothing reaches the disk: the journal is
    // fed only by the recorder's data events, and the recorder is not running.
    expect(startAssemblyLive).not.toHaveBeenCalled();
    expect(appendRecordingChunk).not.toHaveBeenCalled();
    expect(FakeRecorder.last?.state).not.toBe("recording");
  });

  it("starts the recording the participants agreed to", async () => {
    await capture.armCapture(true, async () => {}, "mic+system");
    await capture.beginRecording(DECISION);

    expect(capture.captureSnapshot().state).toBe("recording");
    expect(FakeRecorder.last?.state).toBe("recording");
    expect(startAssemblyLive).toHaveBeenCalledOnce();
    const passed = vi.mocked(startAssemblyLive).mock.calls[0][0];
    expect(passed.mic).toBeDefined();
    expect(passed.system).toBeDefined();
    expect(passed.mic).not.toBe(passed.system);
    // The permission is durable before the first byte of audio is journaled.
    const draft = await recordedDraft();
    expect(draft?.report.consent?.text).toBe(
      assembleConsentText(decisionFacts(DECISION, ["mic", "system"])),
    );
  });

  it("does not stop the screen share it just acquired", async () => {
    const systemTrack = new FakeTrack();
    getDisplayMedia.mockResolvedValue(new FakeStream([systemTrack]));

    await capture.armCapture(true, async () => {}, "mic+system");

    // The teardown guard used to fire for any state that was not "recording",
    // which after the split is every successful arm.
    expect(systemTrack.stop).not.toHaveBeenCalled();
    await capture.beginRecording(DECISION);
    expect(vi.mocked(startAssemblyLive).mock.calls[0][0].system).toBeDefined();
  });

  it("records only the microphone when the share ended while armed", async () => {
    const systemTrack = new FakeTrack();
    getDisplayMedia.mockResolvedValue(new FakeStream([systemTrack]));
    await capture.armCapture(true, async () => {}, "mic+system");

    systemTrack.end();
    await capture.beginRecording(DECISION);

    expect(vi.mocked(startAssemblyLive).mock.calls[0][0].system).toBeUndefined();
    expect((await recordedDraft())?.report.captureSources).toEqual(["mic"]);
  });

  it("closes every device when the user backs out instead of consenting", async () => {
    const micTrack = new FakeTrack();
    const systemTrack = new FakeTrack();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(
      new FakeStream([micTrack]) as unknown as MediaStream,
    );
    getDisplayMedia.mockResolvedValue(new FakeStream([systemTrack]));
    await capture.armCapture(true, async () => {}, "mic+system");

    capture.disarmCapture();

    expect(capture.captureSnapshot().state).toBe("ready");
    expect(micTrack.stop).toHaveBeenCalled();
    expect(systemTrack.stop).toHaveBeenCalled();
  });

  it("closes the devices when an armed session is discarded", async () => {
    const micTrack = new FakeTrack();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(
      new FakeStream([micTrack]) as unknown as MediaStream,
    );
    await capture.armCapture(true, async () => {}, "mic");

    await capture.discardCapture();

    expect(micTrack.stop).toHaveBeenCalled();
  });

  it("aborts when the account changed between arming and consenting", async () => {
    await capture.armCapture(true, async () => {}, "mic");

    account.uid = "jemand-anderes";
    await capture.beginRecording(DECISION);

    expect(FakeRecorder.last?.state).not.toBe("recording");
    expect(startAssemblyLive).not.toHaveBeenCalled();
  });

  it("describes the sources it actually got, not the ones requested", async () => {
    getDisplayMedia.mockRejectedValue(new DOMException("Cancelled", "NotAllowedError"));
    await capture.armCapture(true, async () => {}, "mic+system");
    await capture.beginRecording(DECISION);

    const draft = await recordedDraft();
    // The share was declined, so the notice must not claim the other
    // participants' voices are being recorded.
    expect(draft?.report.consent?.facts.sources).toEqual(["mic"]);
    expect(draft?.report.consent?.text).toContain("nur mein Mikrofon");
    expect(draft?.report.consent?.text).toBe(
      assembleConsentText(decisionFacts(DECISION, ["mic"])),
    );
  });

  it("stamps the consent no later than the meeting it covers", async () => {
    await capture.armCapture(true, async () => {}, "mic");
    await capture.beginRecording(DECISION);

    const draft = await recordedDraft();
    expect(
      Date.parse(draft!.report.consent!.obtainedAt),
    ).toBeLessThanOrEqual(Date.parse(draft!.report.date));
  });

  it("is not capturing while armed, but is holding devices", async () => {
    await capture.armCapture(true, async () => {}, "mic");

    expect(capture.isCapturing()).toBe(false);
    expect(capture.hasOpenDevices()).toBe(true);

    await capture.beginRecording(DECISION);
    expect(capture.isCapturing()).toBe(true);
    expect(capture.hasOpenDevices()).toBe(true);
  });
});
