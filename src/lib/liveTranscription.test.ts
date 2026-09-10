import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLiveTranscription } from "./liveTranscription";

/** A MediaRecorder that emits one blob naming the stream it recorded. */
class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(private stream: { id: string }) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([this.stream.id], { type: "audio/webm" }),
    });
    this.onstop?.(new Event("stop"));
  }
}

describe("live transcription across sources", () => {
  beforeEach(() => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
  });
  afterEach(() => vi.unstubAllGlobals());

  const stream = (id: string) => ({ id }) as unknown as MediaStream;

  it("transcribes each source separately and merges them by time", async () => {
    let now = 0;
    const transcribe = vi.fn(async (segment: Blob, _previous: string) =>
      (await segment.text()) === "mic" ? "Ich frage etwas." : "Wir antworten.",
    );
    const live = startLiveTranscription(
      { mic: stream("mic"), system: stream("sys") },
      () => now,
      () => {},
      transcribe,
    );
    now = 20_000;
    const transcript = await live.finish();

    // Two independent captures, so two segments, each labelled.
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcript).toContain("(Du) Ich frage etwas.");
    expect(transcript).toContain("(Andere) Wir antworten.");
    // Neither source is given the other's text as overlap context.
    for (const call of transcribe.mock.calls) expect(call[1]).toBe("");
  });

  it("records microphone only when no system audio was shared", async () => {
    const transcribe = vi.fn().mockResolvedValue("Nur Mikrofon.");
    const live = startLiveTranscription(
      { mic: stream("mic"), system: undefined },
      () => 0,
      () => {},
      transcribe,
    );
    const transcript = await live.finish();

    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcript).toContain("(Du) Nur Mikrofon.");
    expect(transcript).not.toContain("(Andere)");
  });

  it("counts pending and failed work across both sources", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce(new Error("provider down"));
    const live = startLiveTranscription(
      { mic: stream("mic"), system: stream("sys") },
      () => 0,
      () => {},
      transcribe,
    );
    await live.finish();
    expect(live.failedSegments).toBe(1);
    expect(live.pendingSegments).toBe(0);
  });
});
