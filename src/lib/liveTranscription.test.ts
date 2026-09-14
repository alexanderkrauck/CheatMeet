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
    // One source, so no speaker labels at all — nothing was separated.
    expect(transcript).toBe("[0:00] Nur Mikrofon.");
    expect(transcript).not.toContain("(Du)");
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

  it("never sends a segment from a source with no measured signal", async () => {
    const transcribe = vi.fn().mockResolvedValue("sollte nie ankommen");
    // The default real gate never runs in this test environment (no Web
    // Audio), so it always reports signal; this test injects a fake one to
    // exercise the gate itself, per segment.
    const live = startLiveTranscription(
      { mic: stream("mic"), system: stream("sys") },
      () => 0,
      () => {},
      transcribe,
      async (segment) => (await segment.text()) !== "sys",
    );
    const transcript = await live.finish();

    // Only the microphone's segment was ever transcribed.
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcript).toContain("sollte nie ankommen");
    // One source contributed nothing, so this reads as single-source: no
    // speaker label asserts a separation that never happened.
    expect(transcript).not.toContain("(Du)");
    expect(transcript).not.toContain("(Andere)");
  });

  it("keeps segments in order when the silence check is asynchronous", async () => {
    // A recorder that tags its blob with its own construction order, so the
    // two segments in this test are distinguishable by *when they were
    // really recorded*, independent of which one's silence check resolves
    // first. Without this, both segments' blobs would be identical content
    // and the assertions below would pass whichever way push() actually
    // ordered them -- which is exactly how an earlier version of this test
    // passed against a broken, unserialized gate.
    let created = 0;
    class OrderedFakeRecorder {
      static isTypeSupported = () => true;
      state = "inactive";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      private id = created++;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob([`segment-${this.id}`], { type: "audio/webm" }),
        });
        this.onstop?.(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", OrderedFakeRecorder);

    // Keyed by the segment's own identity, not by call order, so a flipped
    // push() order shows up as wrong *content*, not just a coincidentally
    // matching call index.
    const transcribe = vi.fn(async (segment: Blob, previous: string) => {
      const label = await segment.text();
      return label === "segment-0" ? `A:${label}` : `B (nach "${previous}")`;
    });
    // segmentCapture.ts guarantees onSegment fires in true recording order
    // regardless of this gate, so the Nth hasSignal call always corresponds
    // to the Nth recorded segment -- segment-0's check is made deliberately
    // slow, segment-1's resolves first, so this only passes if segment-1's
    // push() still waits for segment-0's to have been fully applied.
    const hasSignal = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 10)),
      )
      .mockImplementationOnce(async () => true);

    let now = 0;
    const live = startLiveTranscription(
      { mic: stream("mic") },
      () => now,
      () => {},
      transcribe,
      hasSignal,
    );
    now = 50_000;
    live.tick(); // opens the second, overlapping segment
    now = 60_000;
    live.tick(); // closes the first segment; its onSegment fires now
    const transcript = await live.finish(); // closes the second segment

    // The second segment's transcribe call must have seen the first
    // segment's *result* as overlap context, which only holds if its push()
    // waited for the first segment's slower silence check to resolve first.
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(await transcribe.mock.calls[0][0].text()).toBe("segment-0");
    expect(await transcribe.mock.calls[1][0].text()).toBe("segment-1");
    expect(transcribe.mock.calls[1][1]).toBe("A:segment-0");
    expect(transcript).toContain('B (nach "A:segment-0")');
  });

  it("sends a segment when its silence check fails and keeps processing later segments", async () => {
    const source = { id: "first" };
    const transcribe = vi.fn(async (segment: Blob, _previous: string) => segment.text());
    const hasSignal = vi.fn()
      .mockRejectedValueOnce(new Error("decode failed"))
      .mockResolvedValueOnce(true);
    const live = startLiveTranscription(
      { mic: source as unknown as MediaStream },
      () => 0,
      () => {},
      transcribe,
      hasSignal,
    );

    await live.pause();
    source.id = "second";
    await live.resume();
    const transcript = await live.finish();

    expect(hasSignal).toHaveBeenCalledTimes(2);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(await transcribe.mock.calls[0][0].text()).toBe("first");
    expect(await transcribe.mock.calls[1][0].text()).toBe("second");
    expect(transcribe.mock.calls[1][1]).toBe("first");
    expect(transcript).toBe("[0:00] first\n\n[0:00] second");
    expect(live.pendingSegments).toBe(0);
    expect(live.failedSegments).toBe(0);
  });
});
