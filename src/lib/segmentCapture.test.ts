import { describe, expect, it, vi } from "vitest";
import { startSegmentedCapture, type SegmentRecorder } from "./segmentCapture";

/** Drives the scheduler off an explicit recording clock, as the app does. */
function harness({ segmentMs = 60_000, advanceMs = 50_000 } = {}) {
  let clock = 0;
  const recorders: FakeRecorder[] = [];
  const segments: string[] = [];

  class FakeRecorder implements SegmentRecorder {
    state = "inactive";
    startedAt = -1;
    stoppedAt = -1;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    start() {
      this.state = "recording";
      this.startedAt = clock;
    }
    stop() {
      this.state = "inactive";
      this.stoppedAt = clock;
      this.ondataavailable?.({
        data: new Blob([`${this.startedAt}-${this.stoppedAt}`], {
          type: "audio/webm",
        }),
      });
      this.onstop?.(new Event("stop"));
    }
  }

  const capture = startSegmentedCapture({
    createRecorder: () => {
      const recorder = new FakeRecorder();
      recorders.push(recorder);
      return recorder;
    },
    onSegment: async (segment, atMs) =>
      segments.push(`${atMs}|${await segment.text()}`),
    now: () => clock,
    segmentMs,
    advanceMs,
  });

  return {
    capture,
    recorders,
    segments,
    /** Advances the recording clock in the 10s steps the recorder ticks at. */
    advance(ms: number, step = 10_000) {
      const target = clock + ms;
      while (clock < target) {
        clock = Math.min(target, clock + step);
        capture.tick();
      }
    },
    liveCount: () => recorders.filter((r) => r.state === "recording").length,
  };
}

describe("segmented capture", () => {
  it("records overlapping fixed-length segments", async () => {
    const h = harness();
    h.advance(170_000);
    await vi.waitFor(() => expect(h.segments).toHaveLength(3));

    expect(h.recorders.map((r) => r.startedAt)).toEqual([
      0, 50_000, 100_000, 150_000,
    ]);
    expect(h.recorders.slice(0, 3).map((r) => r.stoppedAt)).toEqual([
      60_000, 110_000, 160_000,
    ]);
    // Consecutive segments share 10s of audio.
    // The stamp marks where each segment's *new* speech starts, i.e. after the
    // 10s already covered by its predecessor.
    expect(h.segments).toEqual([
      "0|0-60000",
      "60000|50000-110000",
      "110000|100000-160000",
    ]);
  });

  it("runs two recorders only inside the overlap window", () => {
    const h = harness();
    h.advance(40_000);
    expect(h.liveCount()).toBe(1);
    h.advance(10_000); // 50s: the next segment has started, the first runs on
    expect(h.liveCount()).toBe(2);
    h.advance(10_000); // 60s: the first segment has ended
    expect(h.liveCount()).toBe(1);
  });

  it("keeps segments correct when ticks arrive late and irregularly", () => {
    const h = harness();
    // A throttled background tab delivers one late tick instead of many.
    h.advance(130_000, 130_000);

    // Boundaries follow the recording clock, not the tick cadence: the missed
    // window is closed at once rather than producing a 130s segment.
    expect(h.recorders[0].stoppedAt).toBe(130_000);
    expect(h.recorders).toHaveLength(2);
    expect(h.recorders[1].startedAt).toBe(130_000);
  });

  it("emits the trailing partial segment when capture stops", async () => {
    const h = harness();
    h.advance(20_000);
    await h.capture.stop();
    await vi.waitFor(() => expect(h.segments).toHaveLength(1));

    expect(h.segments).toEqual(["0|0-20000"]);
    expect(h.liveCount()).toBe(0);
  });

  it("keeps only the oldest segment when stopping inside the overlap", async () => {
    const h = harness();
    h.advance(50_000);
    expect(h.liveCount()).toBe(2);
    await h.capture.stop();
    await vi.waitFor(() => expect(h.segments).toHaveLength(1));

    // The older recorder already covers everything the newer one holds.
    expect(h.segments).toEqual(["0|0-50000"]);
  });

  it("stops scheduling new segments after stopping", async () => {
    const h = harness();
    h.advance(20_000);
    await h.capture.stop();
    const created = h.recorders.length;
    h.advance(200_000);
    await vi.waitFor(() => expect(h.segments).toHaveLength(1));

    expect(h.recorders).toHaveLength(created);
    expect(h.segments).toEqual(["0|0-20000"]);
  });

  it("is safe to stop twice", async () => {
    const h = harness();
    h.advance(20_000);
    await h.capture.stop();
    await h.capture.stop();
    await vi.waitFor(() => expect(h.segments).toHaveLength(1));
    expect(h.segments).toEqual(["0|0-20000"]);
  });

  it("drops a segment whose recorder failed instead of transcribing it", async () => {
    const h = harness();
    h.advance(10_000);
    h.recorders[0].onerror?.(new Event("error"));
    await h.capture.stop();

    expect(h.segments).toEqual([]);
  });

  it("keeps capturing when one recorder cannot be created", () => {
    let attempts = 0;
    let clock = 0;
    const capture = startSegmentedCapture({
      createRecorder: () => {
        if (++attempts === 2) throw new Error("device busy");
        return {
          state: "inactive",
          start() {
            this.state = "recording";
          },
          stop() {
            this.state = "inactive";
            this.onstop?.(new Event("stop"));
          },
          ondataavailable: null,
          onstop: null,
          onerror: null,
        } as SegmentRecorder;
      },
      onSegment: () => {},
      now: () => clock,
      segmentMs: 60_000,
      advanceMs: 50_000,
    });

    expect(() => {
      for (let step = 1; step <= 12; step++) {
        clock = step * 10_000;
        capture.tick();
      }
    }).not.toThrow();
    expect(attempts).toBe(3);
    void capture.stop();
  });
});
