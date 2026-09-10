/** Measure the recorded timeline independently of asynchronous MediaRecorder events. */
export class RecordingClock {
  private accumulated = 0;
  private startedAt: number | null = null;
  constructor(private now: () => number = () => performance.now()) {}
  reset(duration = 0) {
    this.accumulated = duration;
    this.startedAt = null;
  }
  resume() {
    if (this.startedAt === null) this.startedAt = this.now();
  }
  read() {
    return (
      this.accumulated +
      (this.startedAt === null ? 0 : this.now() - this.startedAt)
    );
  }
  pause() {
    this.accumulated = this.read();
    this.startedAt = null;
    return this.accumulated;
  }
}

const CANDIDATE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

/** The container the full recording and every transcription segment share. */
export function preferredRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return CANDIDATE_MIME_TYPES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}
