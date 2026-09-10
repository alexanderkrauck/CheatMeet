/**
 * Appends overlapping segment transcripts into one running transcript.
 *
 * Segments overlap on purpose, so each one is resolved against the transcript
 * built so far and only its new part is appended. Work is serialized: the
 * previous transcript is the context for the next segment, so a segment may not
 * start before its predecessor has been applied.
 */
export class TranscriptAssembler {
  private text = "";
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private failed = 0;

  constructor(
    private transcribe: (segment: Blob, previous: string) => Promise<string>,
    private onChange: (transcript: string) => void = () => {},
  ) {}

  get transcript() {
    return this.text;
  }
  get pendingSegments() {
    return this.pending;
  }
  get failedSegments() {
    return this.failed;
  }

  push(segment: Blob) {
    if (!segment.size) return;
    this.pending++;
    this.queue = this.queue.then(async () => {
      try {
        const addition = (await this.transcribe(segment, this.text)).trim();
        if (addition) {
          this.text = this.text ? `${this.text} ${addition}` : addition;
          this.onChange(this.text);
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

  /** Resolves once every segment queued so far has been applied. */
  settled(): Promise<void> {
    return this.queue;
  }
}
