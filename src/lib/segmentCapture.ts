/** One recorded slice of the meeting, long enough to transcribe on its own. */
export const SEGMENT_MS = 60_000;
/** A new segment starts before the previous one ends, so they share audio. */
export const SEGMENT_ADVANCE_MS = 50_000;

export interface SegmentRecorder {
  readonly state: string;
  start(): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface SegmentCaptureOptions {
  createRecorder: () => SegmentRecorder;
  /**
   * `contentStartMs` is where this segment's *new* speech begins on the
   * recording clock: its start, plus the overlap already covered by the
   * previous segment.
   */
  onSegment: (segment: Blob, contentStartMs: number) => void;
  /** Recorded time so far. Must exclude paused time. */
  now: () => number;
  segmentMs?: number;
  advanceMs?: number;
}

/**
 * Records fixed-length, independently decodable segments that overlap by
 * `segmentMs - advanceMs`. A single MediaRecorder cannot be sliced after the
 * fact — only its first chunk carries the container header — so each segment
 * gets its own recorder and the overlap window briefly runs two of them.
 *
 * Boundaries are decided by `tick()` against the recording clock rather than by
 * timers: a backgrounded tab has its timers clamped to one second and, after a
 * few minutes, to one minute, which would silently stretch every segment.
 * Callers drive `tick()` from the recorder's own data events, which keep
 * arriving from the media pipeline while the tab is hidden.
 *
 * Segments are emitted in recording order because a segment always ends before
 * the one that started after it.
 */
export function startSegmentedCapture({
  createRecorder,
  onSegment,
  now,
  segmentMs = SEGMENT_MS,
  advanceMs = SEGMENT_ADVANCE_MS,
}: SegmentCaptureOptions) {
  interface Live {
    recorder: SegmentRecorder;
    startedAt: number;
    sequence: number;
    chunks: Blob[];
    done: () => void;
    finished: Promise<void>;
    emit: boolean;
  }
  const live = new Set<Live>();
  let sequence = 0;
  let nextStartAt = 0;
  let stopped = false;

  const begin = () => {
    if (stopped) return;
    const startedAt = now();
    nextStartAt = startedAt + advanceMs;
    let recorder: SegmentRecorder;
    try {
      recorder = createRecorder();
    } catch (error) {
      console.error("Could not create a transcription segment:", error);
      return;
    }
    let settle!: () => void;
    const entry: Live = {
      recorder,
      startedAt,
      sequence: sequence++,
      chunks: [],
      done: () => settle(),
      finished: new Promise<void>((resolve) => (settle = resolve)),
      emit: true,
    };
    live.add(entry);
    recorder.ondataavailable = (event) => {
      if (event.data.size) entry.chunks.push(event.data);
    };
    recorder.onerror = () => {
      entry.emit = false;
      end(entry);
    };
    recorder.onstop = () => {
      live.delete(entry);
      if (entry.emit && entry.chunks.length)
        onSegment(
          new Blob(entry.chunks, {
            type: entry.chunks[0].type || "audio/webm",
          }),
          entry.sequence === 0
            ? entry.startedAt
            : entry.startedAt + (segmentMs - advanceMs),
        );
      entry.done();
    };
    try {
      recorder.start();
    } catch (error) {
      console.error("Could not start a transcription segment:", error);
      live.delete(entry);
      entry.done();
    }
  };

  const end = (entry: Live) => {
    if (entry.recorder.state === "inactive") {
      live.delete(entry);
      entry.done();
      return;
    }
    entry.recorder.stop();
  };

  begin();

  return {
    /** Closes finished segments and opens the next one. Safe to call often. */
    tick() {
      if (stopped) return;
      const elapsed = now();
      for (const entry of [...live])
        if (elapsed - entry.startedAt >= segmentMs) end(entry);
      if (elapsed >= nextStartAt) begin();
    },
    /**
     * Ends capture and resolves once the final segment has been emitted. The
     * oldest running segment already covers everything a newer overlapping one
     * would, so only that oldest segment is kept.
     */
    async stop() {
      if (stopped) return;
      stopped = true;
      const remaining = [...live].sort((a, b) => a.sequence - b.sequence);
      for (const entry of remaining.slice(1)) entry.emit = false;
      await Promise.all(
        remaining.map((entry) => {
          const finished = entry.finished;
          end(entry);
          return finished;
        }),
      );
    },
  };
}
