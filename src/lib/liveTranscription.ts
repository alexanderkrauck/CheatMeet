import { auth } from "./firebase";
import {
  MAX_TRANSCRIPT_CONTEXT_CHARS,
  audioExtension,
} from "../../shared/analysis";
import { TranscriptAssembler } from "./transcriptAssembler";
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

export function startLiveTranscription(
  stream: MediaStream,
  now: () => number,
  onChange: (transcript: string) => void,
  transcribe = transcribeSegment,
): LiveTranscription {
  const assembler = new TranscriptAssembler(transcribe, onChange);
  const mimeType = preferredRecordingMimeType();
  const begin = () =>
    startSegmentedCapture({
      createRecorder: () =>
        new MediaRecorder(stream, mimeType ? { mimeType } : undefined),
      onSegment: (segment, atMs) => assembler.push(segment, atMs),
      now,
    });

  let capture: ReturnType<typeof begin> | null = begin();
  let stopped = false;
  // Serialize pause/resume so a resume can never outrun the stop it follows.
  let transitions: Promise<void> = Promise.resolve();
  const transition = (change: () => Promise<void> | void) => {
    transitions = transitions.then(change, change);
    return transitions;
  };

  return {
    get transcript() {
      return assembler.timestamped;
    },
    get pendingSegments() {
      return assembler.pendingSegments;
    },
    get failedSegments() {
      return assembler.failedSegments;
    },
    tick: () => capture?.tick(),
    // A paused recording would otherwise pay to transcribe silence.
    pause: () =>
      transition(async () => {
        if (stopped || !capture) return;
        const current = capture;
        capture = null;
        await current.stop();
      }),
    resume: () =>
      transition(() => {
        if (stopped || capture) return;
        capture = begin();
      }),
    finish: async () => {
      await transition(async () => {
        stopped = true;
        const current = capture;
        capture = null;
        await current?.stop();
      });
      await assembler.settled();
      return assembler.timestamped;
    },
  };
}
