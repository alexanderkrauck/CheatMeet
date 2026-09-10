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
): LiveTranscription {
  const mimeType = preferredRecordingMimeType();
  const assemblers: TranscriptAssembler[] = [];
  const starts: (() => ReturnType<typeof startSegmentedCapture>)[] = [];

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
    starts.push(() =>
      startSegmentedCapture({
        createRecorder: () =>
          new MediaRecorder(stream, mimeType ? { mimeType } : undefined),
        onSegment: (segment, atMs) => assembler.push(segment, atMs),
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
      await Promise.all(assemblers.map((assembler) => assembler.settled()));
      return merged();
    },
  };
}
