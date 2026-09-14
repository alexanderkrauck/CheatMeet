/** Which capture a stretch of speech came from. */
export type TranscriptSource = "mic" | "system";

/** One appended stretch of speech and where it starts on the recording clock. */
export interface TranscriptEntry {
  atMs: number;
  source: TranscriptSource;
  text: string;
}

export const SOURCE_LABELS: Record<TranscriptSource, string> = {
  mic: "Du",
  system: "Andere",
};

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

/**
 * Renders entries as the persisted transcript. The `[time] (Speaker)` prefix is
 * the storage format: it survives as a plain string through IndexedDB,
 * Firestore and the Drive export, and is parsed back for the chat view.
 *
 * A recording with a single source carries no speaker label. On a phone there
 * is only the microphone, so writing "(Du)" against every line would assert a
 * speaker separation that was never made.
 */
export function toTimestamped(entries: TranscriptEntry[]): string {
  const sources = new Set(entries.map((entry) => entry.source));
  return [...entries]
    .sort((a, b) => a.atMs - b.atMs)
    .map((entry) => {
      const label =
        sources.size > 1 ? `(${SOURCE_LABELS[entry.source]}) ` : "";
      return `[${formatTimestamp(entry.atMs)}] ${label}${entry.text}`;
    })
    .join("\n\n");
}

/** Reads a rendered "m:ss" / "h:mm:ss" stamp back into milliseconds. */
export function parseTimestamp(at: string): number | null {
  // Bounded on purpose: an unbounded pattern turns a malformed line into an
  // absurd wall-clock time instead of no time at all.
  if (!/^\d+:\d{2}(?::\d{2})?$/.test(at)) return null;
  return (
    at
      .split(":")
      .map(Number)
      .reduce((total, part) => total * 60 + part, 0) * 1000
  );
}

export interface TranscriptLine {
  id?: string;
  at: string;
  source: TranscriptSource | null;
  text: string;
  speaker?: string;
  speakerId?: string;
}

/** Parses the stored transcript back into displayable lines. */
export function parseTranscript(transcript: string): TranscriptLine[] {
  return transcript
    .split(/\n{2,}/)
    .map((line) => {
      const match = /^\[(\d+(?::\d{2})+)\]\s*(?:\(([^)]*)\)\s*)?/.exec(line);
      if (!match) return { at: "", source: null, text: line };
      const label = match[2];
      const source =
        label === SOURCE_LABELS.mic || label?.startsWith("Mikrofon · ")
          ? ("mic" as const)
          : label === SOURCE_LABELS.system || label?.startsWith("Systemaudio · ")
            ? ("system" as const)
            : null;
      const speaker = label?.replace(/^(Mikrofon|Systemaudio) · /, "");
      return { at: match[1], source, text: line.slice(match[0].length), ...(speaker && (!source || speaker !== label) ? { speaker } : {}) };
    })
    .filter((line) => line.text.trim());
}

/**
 * Appends overlapping segment transcripts into one running transcript.
 *
 * Segments overlap on purpose, so each one is resolved against the transcript
 * built so far and only its new part is appended. Work is serialized: the
 * previous transcript is the context for the next segment, so a segment may not
 * start before its predecessor has been applied.
 *
 * One assembler serves one capture source, so the microphone's overlap context
 * is never polluted by whatever was playing through the speakers.
 */
export class TranscriptAssembler {
  private applied: TranscriptEntry[] = [];
  private plain = "";
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private failed = 0;

  constructor(
    private transcribe: (segment: Blob, previous: string) => Promise<string>,
    private onChange: () => void = () => {},
    private source: TranscriptSource = "mic",
  ) {}

  /** Plain running text, used as overlap context for the next segment. */
  get transcript() {
    return this.plain;
  }
  get entries(): TranscriptEntry[] {
    return this.applied;
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
          this.applied.push({ atMs, source: this.source, text: addition });
          this.plain = this.plain ? `${this.plain} ${addition}` : addition;
          this.onChange();
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
