import { MAX_FILE_BYTES, AUDIO_MIME_TYPES } from "../../shared/analysis";
import type { Draft } from "../types";
import { appendRecordingChunk, deleteDraft, getDraft, putDraft } from "./local";
import { mergeAudioStreams, type MergedAudio } from "./audioMerge";
import { RecordingClock, preferredRecordingMimeType } from "./recording";
import type { LiveTranscription } from "./liveTranscription";
import {
  observeRecordingLifecycle,
  type RecordingWakeLockState,
} from "./useRecordingLifecycle";
import { errorMessage } from "./session";
import { auth } from "./firebase";
import type { AudioSourcePreference } from "./audioSources";
import { startAssemblyLive } from "./assemblyLive";
import { DEFAULT_LANGUAGES, renderTranscript, validLanguages } from "../../shared/transcription";

export type CaptureState = "ready" | "recording" | "paused" | "review";

export interface CaptureSnapshot {
  owner: string;
  draft: Draft;
  state: CaptureState;
  durationMs: number;
  checkpointMs: number;
  transcribing: number;
  failed: number;
  /** Newest proactive suggestion, surfaced by the recording bar. */
  hint: string;
  saved: boolean;
  busy: string;
  error: string;
  warning: string;
  localStartOffered: boolean;
  wakeLock: RecordingWakeLockState;
}

const freshDraft = (): Draft => ({
  report: {
    id: crypto.randomUUID(),
    date: new Date().toISOString(),
    title: "",
    summary: "",
    transcription: "",
    speech: { provider: "assemblyai", phase: "pending", languages: [...DEFAULT_LANGUAGES], turns: [], speakerNames: {} },
    todos: [],
    takeaways: [],
    status: "pending",
  },
});

const blank = (owner: string): CaptureSnapshot => ({
  owner,
  draft: freshDraft(),
  state: "ready",
  durationMs: 0,
  checkpointMs: 0,
  transcribing: 0,
  failed: 0,
  hint: "",
  saved: false,
  busy: "",
  error: "",
  warning: "",
  localStartOffered: false,
  wakeLock: "idle",
});

/**
 * The recording session lives here rather than in the recording screen.
 *
 * Capture must survive navigation: a meeting continues while the user reads an
 * earlier report or searches past transcripts. The screen is a view onto this
 * store, and unmounting it tears down the UI only. The session still belongs to
 * the tab, so callers keep a beforeunload guard.
 */
let snapshot: CaptureSnapshot = blank("");
const listeners = new Set<() => void>();

function emit(patch: Partial<CaptureSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function subscribeCapture(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}
export const captureSnapshot = () => snapshot;
export const isCapturing = () =>
  snapshot.state === "recording" || snapshot.state === "paused";

// --- session internals -----------------------------------------------------

let recorder: MediaRecorder | null = null;
let sources: { mic?: MediaStream; system?: MediaStream; merged?: MergedAudio } =
  {};
let captureTracks: MediaStreamTrack[] = [];
let live: LiveTranscription | null = null;
let stopLifecycle: (() => void) | null = null;
let wakeLock: WakeLockSentinel | null = null;
let ticker: number | undefined;
let transcriptionDone: Promise<string> | null = null;

const clock = new RecordingClock();
let chunks: Blob[] = [];
let chunkSequence = 0;
const pendingChunks = new Map<
  number,
  { blob: Blob; durationMs: number; reportId: string }
>();
let queue: Promise<void> = Promise.resolve();
let revision = 0;
let pendingSnapshot: Draft | null = null;
let busyOperation = false;

const elapsed = () => clock.read();
const ownerChanged = () => auth.currentUser?.uid !== snapshot.owner;

/** Releases every device this session opened, including the mixing graph. */
function releaseCapture() {
  sources.merged?.dispose();
  for (const stream of [sources.mic, sources.system])
    stream?.getTracks().forEach((track) => track.stop());
  sources = {};
  captureTracks = [];
  stopLifecycle?.();
  stopLifecycle = null;
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (ticker !== undefined) clearInterval(ticker);
  ticker = undefined;
}

async function flushChunks() {
  for (const [sequence, chunk] of [...pendingChunks]) {
    await appendRecordingChunk(
      snapshot.owner,
      chunk.reportId,
      sequence,
      chunk.blob,
      chunk.durationMs,
    );
    pendingChunks.delete(sequence);
    emit({ checkpointMs: chunk.durationMs });
  }
}

function queueWrite() {
  const writeRevision = ++revision;
  emit({ saved: false });
  queue = queue
    .catch(() => {})
    .then(async () => {
      await flushChunks();
      const pending = pendingSnapshot;
      if (pending) {
        await putDraft(snapshot.owner, pending);
        if (pendingSnapshot === pending) pendingSnapshot = null;
      }
    });
  queue
    .then(() => {
      if (
        writeRevision === revision &&
        pendingChunks.size === 0 &&
        !pendingSnapshot
      )
        emit({
          saved: true,
          error: snapshot.error.startsWith("Lokales Speichern fehlgeschlagen.")
            ? ""
            : snapshot.error,
        });
    })
    .catch(() =>
      emit({
        error:
          "Lokales Speichern fehlgeschlagen. Die Aufnahme bleibt im Arbeitsspeicher. Bitte diesen Tab geöffnet lassen, das Meeting abschließen und das Audio über Weitere Optionen herunterladen.",
      }),
    );
  return queue;
}

function persist(draft: Draft) {
  emit({ draft });
  // Audio is journaled separately: never rewrite an hour-long Blob every second.
  pendingSnapshot = chunks.length ? { ...draft, audio: undefined } : draft;
  return queueWrite();
}

export const captureQueue = () => queue;

async function acquireWakeLock() {
  if (!navigator.wakeLock || document.visibilityState !== "visible") {
    emit({ wakeLock: "unavailable" });
    return;
  }
  emit({ wakeLock: "requesting" });
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => emit({ wakeLock: "unavailable" }));
    emit({ wakeLock: "active" });
  } catch {
    emit({ wakeLock: "unavailable" });
  }
}

// --- actions ---------------------------------------------------------------

/** Adopts a stored draft, or starts a new one. Never disturbs a live session. */
export async function openDraft(
  owner: string,
  id: string | undefined,
  startNew: boolean,
): Promise<string> {
  if (isCapturing()) return snapshot.draft.report.id;
  if (snapshot.owner !== owner) snapshot = blank(owner);
  const stored = startNew ? undefined : await getDraft(owner, id);
  if (!stored) {
    if (startNew || snapshot.state === "review") snapshot = blank(owner);
    emit({ owner });
    return snapshot.draft.report.id;
  }
  clock.reset(stored.report.durationMs || 0);
  chunks = [];
  chunkSequence = 0;
  emit({
    owner,
    draft: stored,
    state: stored.audio ? "review" : "ready",
    durationMs: stored.report.durationMs || 0,
    checkpointMs: stored.report.durationMs || 0,
    saved: true,
    warning:
      stored.audio && stored.report.captureState !== "stopped"
        ? "Eine frühere Aufnahme wurde wiederhergestellt. Bitte die gesicherten Audiodaten anhören und anschließend in Drive sichern."
        : "",
  });
  return stored.report.id;
}

export const setCaptureTitle = (title: string) =>
  void persist({
    ...snapshot.draft,
    report: { ...snapshot.draft.report, title, projectName: title },
  }).catch(() => {});

export const setCaptureError = (error: string) => emit({ error });
export const setCaptureBusy = (busy: string) => emit({ busy });
export const setCaptureHint = (hint: string) => emit({ hint });
export const setCaptureLanguages = (languages: string[]) => {
  if (isCapturing() || !validLanguages(languages)) return;
  void persist({ ...snapshot.draft, report: { ...snapshot.draft.report,
    speech: { provider: "assemblyai", phase: "pending", turns: [], speakerNames: {}, ...snapshot.draft.report.speech, languages } } }).catch(() => {});
};

export async function startCapture(
  localOnly: boolean,
  verify: () => Promise<void>,
  audioSources: AudioSourcePreference = "mic+system",
) {
  if (busyOperation || isCapturing()) return;
  busyOperation = true;
  emit({ busy: "Aufnahme vorbereiten …", error: "", warning: "", localStartOffered: false });
  const captureOwner = snapshot.owner;
  let share: Promise<MediaStream | undefined> | undefined;
  // Request display capture during the actual click, before Drive/mic awaits
  // consume transient user activation. Keep its rejection handled immediately.
  if (audioSources === "mic+system" && navigator.mediaDevices?.getDisplayMedia) {
    try {
      share = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        .then(stream => {
          if (auth.currentUser?.uid !== captureOwner) { stream.getTracks().forEach(t => t.stop()); return undefined; }
          sources.system = stream;
          return stream;
        }, () => undefined);
    } catch { share = Promise.resolve(undefined); }
  }
  try {
    if (!localOnly && navigator.onLine) {
      emit({ busy: "Drive-Berechtigung prüfen …" });
      try {
        await verify();
      } catch (e) {
        emit({ localStartOffered: true });
        throw e;
      }
    }
    if (ownerChanged()) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw new Error(
        "Aufnahme wird in diesem Browser nicht unterstützt. Bitte eine Audiodatei importieren oder einen aktuellen Browser über HTTPS verwenden.",
      );

    emit({ busy: "Mikrofon vorbereiten …" });
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    sources.mic = mic;
    if (ownerChanged()) { releaseCapture(); return; }

    // Browsers only expose system audio through a display-capture prompt, and
    // only alongside a video track. Declining it is a normal outcome. A user
    // who chose microphone-only never sees this prompt at all -- calling
    // getDisplayMedia and discarding the result would still interrupt them
    // with a dialog for something they already said they did not want.
    let system: MediaStream | undefined;
    if (audioSources === "mic+system" && navigator.mediaDevices.getDisplayMedia) {
      emit({
        busy: "Systemaudio freigeben … Teile den Tab oder Bildschirm und aktiviere „Audio teilen“.",
      });
      system = await share;
      if (ownerChanged()) { releaseCapture(); return; }
      if (!system) emit({ warning: "Systemaudio wurde nicht freigegeben. Es wird nur das Mikrofon aufgenommen." });
      else if (!system.getAudioTracks().length) emit({ warning: "Die Freigabe enthält kein Systemaudio. Es wird nur das Mikrofon aufgenommen. Prüfe beim nächsten Mal „Audio teilen“ und ob dein Browser Audio für den gewählten Tab oder Bildschirm unterstützt." });
    } else if (audioSources === "mic+system") {
      emit({ warning: "Dieser Browser unterstützt keine Bildschirmfreigabe. Es wird nur das Mikrofon aufgenommen." });
    }

    // The mixed stream is the durable recording; transcription reads each
    // source separately so speech is never lost under what is playing.
    const merged = mergeAudioStreams(mic, system);
    sources.merged = merged;
    captureTracks = [
      ...mic.getAudioTracks(),
      ...(system?.getAudioTracks() || []),
    ];

    const mimeType = preferredRecordingMimeType();
    const rec = new MediaRecorder(merged.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 64000,
    });
    recorder = rec;
    chunks = [];
    chunkSequence = 0;
    transcriptionDone = null;
    clock.reset();
    await persist({
      ...snapshot.draft,
      report: { ...snapshot.draft.report, date: new Date().toISOString(), captureState: "recording", captureSources: system?.getAudioTracks().length ? ["mic", "system"] : ["mic"] },
    });
    void navigator.storage?.persist?.().catch(() => {});

    const systemAudio =
      system && system.getAudioTracks().length
        ? new MediaStream(system.getAudioTracks())
        : undefined;
    live = startAssemblyLive(
      { mic: new MediaStream(mic.getAudioTracks()), system: systemAudio },
      elapsed,
      (speech) => {
        if (ownerChanged()) return;
        const transcription = renderTranscript(speech);
        emit({
          ...(speech.liveWarning ? { warning: speech.liveWarning } : {}),
          draft: {
            ...snapshot.draft,
            report: { ...snapshot.draft.report, transcription, speech },
          },
        });
        pendingSnapshot = chunks.length
          ? { ...snapshot.draft, audio: undefined }
          : snapshot.draft;
        // Checkpoint with the recorder's 10-second journal tick. Partial
        // events can arrive many times per second; do not queue a full
        // IndexedDB rewrite for every word. Pause/finish also flush this.

      },
      snapshot.draft.report.id,
      snapshot.draft.report.speech?.languages || [...DEFAULT_LANGUAGES],
    );

    rec.ondataavailable = (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      const audio = new Blob(chunks, {
        type: rec.mimeType || event.data.type,
      });
      const durationMs = elapsed();
      const draft = {
        ...snapshot.draft,
        audio,
        report: { ...snapshot.draft.report, durationMs },
      };
      pendingChunks.set(chunkSequence++, {
        blob: event.data,
        durationMs,
        reportId: draft.report.id,
      });
      void persist(draft).catch(() => {});
      // Media-pipeline driven, so segment boundaries survive a hidden tab
      // whose timers are throttled.
      live?.tick();
    };
    rec.onerror = () => {
      emit({
        error:
          "Die Aufnahme wurde unterbrochen. Prüfe die bisher gespeicherte Aufnahme.",
      });
      if (rec.state !== "inactive") stopCapture();
      else {
        clock.pause();
        releaseCapture();
        emit({ state: "review" });
      }
    };
    rec.onstop = () => {
      const finalDuration = clock.pause();
      releaseCapture();
      if (snapshot.draft.audio)
        void persist({
          ...snapshot.draft,
          report: {
            ...snapshot.draft.report,
            durationMs: finalDuration,
            captureState: "stopped",
          },
        }).catch(() => {});
      emit({ durationMs: finalDuration, state: "review" });
    };

    rec.start(10_000);
    clock.resume();
    stopLifecycle = observeRecordingLifecycle({
      recorder: rec,
      tracks: captureTracks,
      document,
      window,
      onInterrupted: (reason) => {
        if (reason === "muted" && rec.state === "recording") {
          pauseCapture();
          emit({
            warning:
              "Das Gerät hat das Mikrofon unterbrochen. Die Aufnahme ist pausiert. Prüfe das Mikrofon und tippe dann auf Weiter.",
          });
        } else if (reason !== "muted") {
          clock.pause();
          if (rec.state !== "inactive") stopCapture();
          else emit({ durationMs: elapsed(), state: "review" });
          emit({
            warning:
              "Das Gerät hat die Aufnahme beendet. Die bisher erfassten Audiodaten sind im Entwurf. Bitte anhören und sichern.",
          });
        }
      },
      onVisibilityReturn: () => {
        void acquireWakeLock();
        void queueWrite().catch(() => {});
      },
    });

    void acquireWakeLock();
    ticker = window.setInterval(() => {
      if (recorder?.state !== "recording") return;
      emit({ durationMs: elapsed(), transcribing: live?.pendingSegments || 0 });
      // A visible tab gets exact boundaries; a throttled one falls back to the
      // recorder's own data events.
      live?.tick();
    }, 500);
    emit({ state: "recording", durationMs: 0 });
  } catch (e) {
    releaseCapture();
    recorder = null;
    emit({
      error:
        (e as Error).name === "NotAllowedError"
          ? "Mikrofonzugriff nicht erlaubt. Bitte in den Browser-Einstellungen freigeben oder Audio importieren."
          : errorMessage(e),
    });
  } finally {
    if (snapshot.state !== "recording") {
      // A Drive/mic failure can happen while the native picker is still open.
      void share?.then(stream => stream?.getTracks().forEach(t => t.stop()));
    }
    busyOperation = false;
    emit({ busy: "" });
  }
}

export function pauseCapture() {
  const rec = recorder;
  if (!rec) return;
  if (rec.state === "recording") {
    const time = clock.pause();
    rec.pause();
    rec.requestData();
    void live?.pause();
    emit({ state: "paused", durationMs: time });
    void persist({
      ...snapshot.draft,
      report: { ...snapshot.draft.report, captureState: "paused" },
    }).catch(() => {});
  } else if (rec.state === "paused") {
    // Check the real capture devices: the recorder's own track is a synthetic
    // mixing destination and never reports a dead microphone.
    if (
      captureTracks.some(
        (track) => track.muted || track.readyState === "ended",
      )
    ) {
      emit({
        warning:
          "Das Mikrofon ist noch nicht verfügbar. Die Aufnahme bleibt pausiert.",
      });
      return;
    }
    void live?.resume();
    clock.resume();
    rec.resume();
    emit({ state: "recording", warning: "" });
    void persist({
      ...snapshot.draft,
      report: { ...snapshot.draft.report, captureState: "recording" },
    }).catch(() => {});
  }
}

/**
 * Transcribes the trailing segment and adopts the completed transcript.
 * Analysis must not run against a transcript that stops seconds before the
 * meeting did, so this resolves once every queued segment has been applied.
 */
export function finishTranscription(): Promise<string> {
  const pipeline = live;
  if (!pipeline)
    return Promise.resolve(snapshot.draft.report.transcription || "");
  const reportId = snapshot.draft.report.id;
  const captureOwner = snapshot.owner;
  transcriptionDone ||= pipeline.finish().then((transcription) => {
    if (snapshot.owner !== captureOwner || snapshot.draft.report.id !== reportId) return transcription;
    live = null;
    const draft = {
      ...snapshot.draft,
      report: { ...snapshot.draft.report, transcription },
    };
    emit({
      draft,
      transcribing: 0,
      failed: pipeline.failedSegments,
      warning: pipeline.failedSegments
        ? `${pipeline.failedSegments} Abschnitt(e) konnten nicht transkribiert werden. Das Transkript ist möglicherweise unvollständig; die Originalaufnahme ist vollständig.`
        : snapshot.warning,
    });
    pendingSnapshot = chunks.length ? { ...draft, audio: undefined } : draft;
    void queueWrite().catch(() => {});
    return transcription;
  });
  return transcriptionDone;
}

export function stopCapture() {
  const rec = recorder;
  if (!rec || rec.state === "inactive") return;
  const time = clock.pause();
  emit({ durationMs: time });
  rec.stop();
  void finishTranscription().catch(() => {});
}

export async function importAudio(file: File) {
  if (busyOperation || isCapturing()) return;
  if (
    file.size > MAX_FILE_BYTES ||
    !file.size ||
    !(AUDIO_MIME_TYPES as readonly string[]).includes(file.type)
  ) {
    emit({
      error:
        "Bitte eine Audiodatei wählen (WebM, M4A, MP3, WAV, Ogg, AAC oder FLAC).",
    });
    return;
  }
  await queue.catch(() => {});
  chunks = [];
  pendingChunks.clear();
  pendingSnapshot = null;
  chunkSequence = 0;
  live = null;
  transcriptionDone = null;
  clock.reset();
  emit({ error: "", durationMs: 0, state: "review" });
  await persist({
    ...snapshot.draft,
    audio: file,
    // Replacing audio starts a NEW submission identity; never reuse a provider
    // job from the previous file under the same report ID.
    report: { ...snapshot.draft.report, id: crypto.randomUUID(), rawAudioUrl: undefined,
      driveFolderId: undefined, driveReportId: undefined, driveMarkdownId: undefined,
      driveTranscriptId: undefined, driveSyncedAt: undefined, transcription: "", summary: "", todos: [], takeaways: [], status: "pending", durationMs: 0,
      speech: { provider: "assemblyai", phase: "pending", languages: snapshot.draft.report.speech?.languages || [...DEFAULT_LANGUAGES], turns: [], speakerNames: {} } },
  });
  return snapshot.draft.report.id;
}

export async function discardCapture() {
  await queue.catch(() => {});
  await deleteDraft(snapshot.owner, snapshot.draft.report.id);
  chunks = [];
  pendingChunks.clear();
  pendingSnapshot = null;
  clock.reset();
  recorder = null;
  live = null;
  transcriptionDone = null;
  snapshot = blank(snapshot.owner);
  emit({});
  return snapshot.draft.report.id;
}

/** Clears the session after its draft has been handed to the save pipeline. */
export function releaseAfterHandoff() {
  chunks = [];
  pendingChunks.clear();
  pendingSnapshot = null;
  clock.reset();
  recorder = null;
  live = null;
  transcriptionDone = null;
  snapshot = blank(snapshot.owner);
  emit({});
}
