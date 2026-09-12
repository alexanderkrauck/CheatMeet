import { auth } from "./firebase";
import {
  MAX_TRANSCRIPT_CONTEXT_CHARS,
  audioExtension,
} from "../../shared/analysis";
import {
  TranscriptAssembler,
  toTimestamped,
  type TranscriptSource,
} from "./transcriptAssembler";
import { startSegmentedCapture } from "./segmentCapture";
import { preferredRecordingMimeType } from "./recording";
import { segmentHasSignal } from "./audioEnergy";

/** Sends one overlapping segment and returns only the text that is new. */
export async function transcribeSegment(
  segment: Blob,
  previous: string,
): Promise<string> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Nicht angemeldet.");
  const form = new FormData();
  form.append("audio", segment, `segment.${audioExtension(segment.type)}`);
  form.append(
    "previousTranscript",
    previous.slice(-MAX_TRANSCRIPT_CONTEXT_CHARS),
  );
  const response = await fetch("/api/transcribe-segment", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(
      `Segment-Transkription fehlgeschlagen (${response.status}).`,
    );
  const data = await response.json();
  return typeof data.text === "string" ? data.text : "";
}

export interface LiveTranscription {
  readonly transcript: string;
  readonly pendingSegments: number;
  readonly failedSegments: number;
  /** Closes finished segments and opens the next one; driven by the recorder. */
  tick(): void;
  /** Stops capturing while the recording is paused; queued segments still run. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Stops capture, transcribes the final segment and resolves the full text. */
  finish(): Promise<string>;
}

/**
 * Transcribes each capture source separately.
 *
 * Mixing the microphone with system audio into a single transcript interleaves
 * whatever is playing with what people say, and loses speech under music. Each
 * source therefore gets its own segmented capture and its own overlap context;
 * the two are merged only for display, by timestamp, with speaker labels.
 */
export function startLiveTranscription(
  sources: Partial<Record<TranscriptSource, MediaStream>>,
  now: () => number,
  onChange: (transcript: string) => void,
  transcribe = transcribeSegment,
  hasSignal = segmentHasSignal,
): LiveTranscription {
  const mimeType = preferredRecordingMimeType();
  const assemblers: TranscriptAssembler[] = [];
  const starts: (() => ReturnType<typeof startSegmentedCapture>)[] = [];
  // Reads each source's current gate chain at finish() time; see below.
  const gateChains: (() => Promise<void>)[] = [];

  const merged = () =>
    toTimestamped(assemblers.flatMap((assembler) => assembler.entries));

  for (const [source, stream] of Object.entries(sources)) {
    if (!stream) continue;
    const assembler = new TranscriptAssembler(
      transcribe,
      () => onChange(merged()),
      source as TranscriptSource,
    );
    assemblers.push(assembler);
    // Checking a segment for silence means decoding it, which is async and
    // can resolve out of order between segments. The assembler needs
    // assembler.push() called in the same order segments actually finished
    // recording (each one's overlap context is the transcript built by the
    // ones before it), so this chain forces that order regardless of how
    // long any one decode takes -- the same shape TranscriptAssembler itself
    // uses internally to serialize transcription.
    let gate: Promise<void> = Promise.resolve();
    gateChains.push(() => gate);
    starts.push(() =>
      startSegmentedCapture({
        createRecorder: () =>
          new MediaRecorder(stream, mimeType ? { mimeType } : undefined),
        onSegment: (segment, atMs) => {
          // A rejected step must not poison the chain: gate stays a resolved
          // promise for the next segment even if this one's check throws, the
          // same "one lost segment must not stop the rest" rule the assembler
          // itself applies to a failed transcription.
          gate = gate.then(async () => {
            try {
              // A segment that never rose above the noise floor is not sent
              // for transcription at all: handed silence, the model does not
              // return an empty string, it invents fluent speech (verified
              // on a real recording where a muted shared tab produced six
              // minutes of invented lecture and election results).
              if (await hasSignal(segment)) assembler.push(segment, atMs);
              else console.debug(`Skipped a silent ${source} segment`);
            } catch (error) {
              console.error(`Silence check failed for a ${source} segment; sending it`, error);
              assembler.push(segment, atMs);
            }
          });
        },
        now,
      }),
    );
  }

  let captures = starts.map((start) => start());
  let stopped = false;
  // Serialize pause/resume so a resume can never outrun the stop it follows.
  let transitions: Promise<void> = Promise.resolve();
  const transition = (change: () => Promise<void> | void) => {
    transitions = transitions.then(change, change);
    return transitions;
  };
  const sum = (read: (a: TranscriptAssembler) => number) =>
    assemblers.reduce((total, assembler) => total + read(assembler), 0);
  const stopAll = async () => {
    const running = captures;
    captures = [];
    await Promise.all(running.map((capture) => capture.stop()));
  };

  return {
    get transcript() {
      return merged();
    },
    get pendingSegments() {
      return sum((assembler) => assembler.pendingSegments);
    },
    get failedSegments() {
      return sum((assembler) => assembler.failedSegments);
    },
    tick: () => captures.forEach((capture) => capture.tick()),
    // A paused recording would otherwise pay to transcribe silence.
    pause: () =>
      transition(async () => {
        if (stopped || !captures.length) return;
        await stopAll();
      }),
    resume: () =>
      transition(() => {
        if (stopped || captures.length) return;
        captures = starts.map((start) => start());
      }),
    finish: async () => {
      await transition(async () => {
        stopped = true;
        await stopAll();
      });
      // stopAll() has already made every onSegment call for the final
      // segments, so each chain read here includes the gate check for the
      // last segment -- awaiting it before settled() is what guarantees that
      // segment's push() has actually happened by the time settled() waits.
      await Promise.all(gateChains.map((chain) => chain()));
      await Promise.all(assemblers.map((assembler) => assembler.settled()));
      return merged();
    },
  };
}
