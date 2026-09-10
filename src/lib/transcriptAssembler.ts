/** One appended stretch of speech and where it starts on the recording clock. */
export interface TranscriptEntry {
  atMs: number;
  text: string;
}

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const parts = [Math.floor(total / 60) % 60, total % 60];
  if (total >= 3600) parts.unshift(Math.floor(total / 3600));
  return parts
    .map((value, index) =>
      index === 0 ? String(value) : String(value).padStart(2, "0"),
    )
    .join(":");
}

/** Renders entries as the persisted, human-readable transcript. */
export function toTimestamped(entries: TranscriptEntry[]): string {
  return entries
    .map((entry) => `[${formatTimestamp(entry.atMs)}] ${entry.text}`)
    .join("\n\n");
}

/**
 * Appends overlapping segment transcripts into one running transcript.
 *
 * Segments overlap on purpose, so each one is resolved against the transcript
 * built so far and only its new part is appended. Work is serialized: the
 * previous transcript is the context for the next segment, so a segment may not
 * start before its predecessor has been applied.
 *
 * Two views are kept: the plain text used as model context, and a timestamped
 * rendering for reading and for what is stored.
 */
export class TranscriptAssembler {
  private entries: TranscriptEntry[] = [];
  private plain = "";
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private failed = 0;

  constructor(
    private transcribe: (segment: Blob, previous: string) => Promise<string>,
    private onChange: (transcript: string) => void = () => {},
  ) {}

  /** Plain running text, used as overlap context for the next segment. */
  get transcript() {
    return this.plain;
  }
  get timestamped() {
    return toTimestamped(this.entries);
  }
  get pendingSegments() {
    return this.pending;
  }
  get failedSegments() {
    return this.failed;
  }

  push(segment: Blob, atMs = 0) {
    if (!segment.size) return;
    this.pending++;
    this.queue = this.queue.then(async () => {
      try {
        const addition = (await this.transcribe(segment, this.plain)).trim();
        // The overlap step can fail to align on repetitive audio and hand back
        // text that is already there; appending it would duplicate speech.
        if (addition && !this.repeatsTail(addition)) {
          this.entries.push({ atMs, text: addition });
          this.plain = this.plain ? `${this.plain} ${addition}` : addition;
          this.onChange(this.timestamped);
        }
      } catch (error) {
        // One lost segment must not stop the rest of the meeting transcribing.
        this.failed++;
        console.error("Segment transcription failed:", error);
      } finally {
        this.pending--;
      }
    });
  }

  /** True when the text is already the tail of the transcript. */
  private repeatsTail(addition: string) {
    const normalise = (value: string) =>
      value.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "");
    const candidate = normalise(addition);
    if (!candidate) return true;
    return normalise(this.plain).endsWith(candidate);
  }

  /** Resolves once every segment queued so far has been applied. */
  settled(): Promise<void> {
    return this.queue;
  }
}
