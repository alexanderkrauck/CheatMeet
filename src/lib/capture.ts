import { MAX_FILE_BYTES, AUDIO_MIME_TYPES } from "../../shared/analysis";
import {
  assembleConsentText,
  buildConsentRecord,
  decisionFacts,
  type ConsentDecision,
  type ConsentSource,
} from "../../shared/consent";
import type { Draft } from "../types";
import {microsoftHome,type MicrosoftHome,type ServiceProvider} from "../../shared/storage";
import { appendRecordingChunk, deleteDraft, getDraft, putDraft } from "./local";
import { mergeAudioStreams, type MergedAudio } from "./audioMerge";
import { RecordingClock, preferredRecordingMimeType } from "./recording";
import type { LiveTranscription } from "./liveTranscription";
import { startLiveShare, type LiveShare } from "./liveShare";
import {
  observeRecordingLifecycle,
  type RecordingWakeLockState,
} from "./useRecordingLifecycle";
import { errorMessage } from "./session";
import { auth } from "./firebase";
import type { AudioSourcePreference } from "./audioSources";
import { describeAudioSources } from "./audioSourceState";
import { startAssemblyLive } from "./assemblyLive";
import { renderTranscript, validLanguages, renameSpeaker, type LiveConnection } from "../../shared/transcription";
import { defaultLanguages } from "./meetingDefaults";

export type CaptureState = "ready" | "armed" | "recording" | "paused" | "review";

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
  /** The sources actually live, so the notice can name what is captured. */
  sources: ConsentSource[];
  /** Health of the live transcription connection; not stored with the report. */
  liveConnection?: LiveConnection;
  /** Whether an AI assistant is reading the live transcript right now. */
  liveShare?: "waiting" | "listening" | "off";
}

const freshDraft = (): Draft => ({
  report: {
    id: crypto.randomUUID(),
    date: new Date().toISOString(),
    title: "",
    summary: "",
    transcription: "",
    speech: { provider: "assemblyai", phase: "pending", languages: defaultLanguages(), turns: [], speakerNames: {} },
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
  sources: [],
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
let hiddenSnapshot = blank("");
let changingOwner = false;
let nextCaptureOwner = "";
let ownerTransition: Promise<void> = Promise.resolve();
/** A failed owner checkpoint must not be replaced by an older disk draft. */
let retainedOwnerTake = false;
const listeners = new Set<() => void>();

function emit(patch: Partial<CaptureSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  syncUnloadProtection();
  for (const listener of listeners) listener();
}

export function subscribeCapture(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}
export const captureSnapshot = () => {
  const owner = auth.currentUser?.uid || "";
  if (!changingOwner && snapshot.owner === owner) return snapshot;
  // Stable useSyncExternalStore snapshot, never the foreign owner's draft.
  if (hiddenSnapshot.owner !== owner) hiddenSnapshot = blank(owner);
  return hiddenSnapshot;
};
export const isCapturing = () =>
  !ownerChanged() && (snapshot.state === "recording" || snapshot.state === "paused");
/**
 * Devices are open — armed or recording. Deliberately separate from
 * isCapturing(): the bar, the attention queue and the recorder screen all mean
 * "audio is being recorded" by that one, and an armed session records nothing.
 */
export const hasOpenDevices = () =>
  !ownerChanged() && (snapshot.state === "armed" || isCapturing());

// --- session internals -----------------------------------------------------

let recorder: MediaRecorder | null = null;
let recorderDone: Promise<void> = Promise.resolve();
let sources: { mic?: MediaStream; system?: MediaStream; merged?: MergedAudio } =
  {};
let captureTracks: MediaStreamTrack[] = [];
let stopSystemWatch: (() => void) | null = null;
let live: LiveTranscription | null = null;
/** Lets an assistant with a live grant read along; null when there is no running session. */
let share: LiveShare | null = null;
/** Ends the share exactly once. Every place that drops `live` calls this, so none can forget it. */
function endShare(): Promise<void> {
  const current = share;
  share = null;
  if (!current) return Promise.resolve();
  return current.end().catch(() => {}).finally(() => {
    // Only clear the indicator if no newer session has taken over.
    if (!share && snapshot.liveShare) emit({ liveShare: undefined });
  });
}
/** Nothing here may ever reach the recording: a failing share is silent. */
function feedShare(speech: Parameters<LiveShare["update"]>[0]) {
  try {
    share?.update(speech);
  } catch {
    /* the recording matters more */
  }
}
function shareState(state: Parameters<LiveShare["setState"]>[0]) {
  try {
    share?.setState(state);
  } catch {
    /* as above */
  }
}
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
/** Invalidates pending device/consent continuations, not same-owner navigation. */
let captureAttempt = 0;
/** What arm asked for, so consent resolves against the sources still alive. */
let armedSources: {
  requested: AudioSourcePreference;
  displayMediaSupported: boolean;
} | null = null;

const elapsed = () => clock.read();
const ownerChanged = () => changingOwner || !snapshot.owner || auth.currentUser?.uid !== snapshot.owner;

/** Reload safety is tab-private: a foreign owner's hidden take still matters. */
export function canReleaseCapture(): boolean {
  return !changingOwner && !busyOperation && !snapshot.busy &&
    !["armed", "recording", "paused"].includes(snapshot.state) &&
    (!recorder || recorder.state === "inactive") && !live &&
    pendingChunks.size === 0 && !pendingSnapshot &&
    (snapshot.state !== "review" || snapshot.saved);
}

let unloadTarget: Window | null = null;
function guardUnload(event: BeforeUnloadEvent) {
  if (canReleaseCapture()) return;
  event.preventDefault();
  event.returnValue = "";
}
/** Device lifecycle can end before a failed checkpoint; memory still needs protection. */
function syncUnloadProtection() {
  const target = typeof window !== "undefined" && !canReleaseCapture() ? window : null;
  if (target === unloadTarget) return;
  unloadTarget?.removeEventListener("beforeunload", guardUnload);
  unloadTarget = target;
  unloadTarget?.addEventListener("beforeunload", guardUnload);
}

/**
 * The user can stop sharing their screen at any time — after a demo, or by
 * closing the shared tab. The microphone is still live and the meeting is
 * still worth recording, so this degrades to mic-only instead of ending it.
 */
function watchSystemAudio(system?: MediaStream) {
  const tracks = system?.getAudioTracks() || [];
  if (!tracks.length) return null;
  let done = false;
  // "ended" only fires forward. The picker resolves before the Drive check and
  // the microphone prompt, so a share stopped in that window is already dead
  // by the time this runs and would never announce itself.
  const alreadyEnded = tracks.every((track) => track.readyState === "ended");
  const onEnded = () => {
    if (done) return;
    done = true;
    system?.getTracks().forEach((track) => track.stop());
    sources.system = undefined;
    // The live transcription holds its own reference; without this, resuming
    // reopens a paid streaming connection for a track that is gone.
    live?.dropSource?.("system");
    emit({
      // Re-resolved, not just warned about: the consent notice on the armed
      // screen is rendered from this list and would otherwise keep promising
      // the other participants' voices under a banner saying the opposite.
      sources: describeAudioSources({
        requested: armedSources?.requested ?? "mic",
        displayMediaSupported: armedSources?.displayMediaSupported ?? false,
        system: undefined,
      }).sources,
      warning:
        "Die Bildschirmfreigabe wurde beendet. Es wird weiter nur das Mikrofon aufgenommen.",
    });
  };
  if (alreadyEnded) onEnded();
  else for (const track of tracks) track.addEventListener("ended", onEnded);
  return () => {
    done = true;
    for (const track of tracks) track.removeEventListener("ended", onEnded);
  };
}

/** Releases every device this session opened, including the mixing graph. */
function releaseCapture() {
  stopSystemWatch?.();
  stopSystemWatch = null;
  sources.merged?.dispose();
  for (const stream of [sources.mic, sources.system])
    stream?.getTracks().forEach((track) => track.stop());
  sources = {};
  captureTracks = [];
  armedSources = null;
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
      !!snapshot.draft.report.home,
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
  const attempt = captureAttempt;
  const owner = snapshot.owner;
  const current = () => attempt === captureAttempt && snapshot.owner === owner && !ownerChanged();
  if (wakeLock && !wakeLock.released) return;
  if (!navigator.wakeLock || document.visibilityState !== "visible") {
    emit({ wakeLock: "unavailable" });
    return;
  }
  emit({ wakeLock: "requesting" });
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!current()) { void lock.release().catch(() => {}); return; }
    wakeLock = lock;
    wakeLock.addEventListener("release", () => {
      if (current() && wakeLock === lock) emit({ wakeLock: "unavailable" });
    });
    emit({ wakeLock: "active" });
  } catch {
    if (current()) emit({ wakeLock: "unavailable" });
  }
}

// --- actions ---------------------------------------------------------------

/** Fence synchronously; drain/checkpoint the old namespace before adopting another. */
export function handleCaptureOwnerChange(nextOwner: string | null): Promise<void> {
  nextCaptureOwner = nextOwner || "";
  if (changingOwner) return ownerTransition;
  if (snapshot.owner === nextCaptureOwner && !retainedOwnerTake) return Promise.resolve();
  changingOwner = true;
  ++captureAttempt;
  busyOperation = true;
  emit({});
  const rec = recorder;
  if (rec && rec.state !== "inactive") rec.stop();
  releaseCapture();
  const sharing = endShare();
  const transcription = drainTranscription();
  ownerTransition = (async () => {
    try {
      await recorderDone;
      await Promise.all([sharing, transcription]);
      // Failed storage retains the old draft in memory for checkpoint retry.
      await queueWrite();
      recorder = null;
      recorderDone = Promise.resolve();
      live = null;
      transcriptionDone = null;
      if (!retainedOwnerTake || snapshot.owner !== nextCaptureOwner) {
        chunks = [];
        pendingChunks.clear();
        pendingSnapshot = null;
        chunkSequence = 0;
        clock.reset();
        retainedOwnerTake = false;
        snapshot = blank(nextCaptureOwner);
      }
    } catch (error) {
      retainedOwnerTake = true;
      // Devices/providers have stopped even if the journal is unavailable.
      // Returning to this owner exposes the retained take, never a fake live session.
      emit({ state: snapshot.draft.audio || snapshot.draft.report.transcription ? "review" : "ready",
        busy: "", sources: [], wakeLock: "idle", liveConnection: undefined });
      throw error;
    } finally {
      changingOwner = false;
      busyOperation = false;
      emit({});
    }
  })();
  return ownerTransition;
}

/** Adopts a stored draft, or starts a new one. Never disturbs a live session. */
export async function openDraft(
  owner: string,
  id: string | undefined,
  startNew: boolean,
): Promise<string> {
  if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  if (changingOwner || snapshot.owner !== owner) await handleCaptureOwnerChange(owner);
  if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  if (hasOpenDevices()) return snapshot.draft.report.id;
  if (retainedOwnerTake) return snapshot.draft.report.id;
  const attempt = captureAttempt;
  const stored = startNew ? undefined : await getDraft(owner, id);
  if (ownerChanged() || attempt !== captureAttempt) throw new Error("Das angemeldete Konto oder die Aufnahme hat sich geändert.");
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

export const setCaptureTitle = (title: string) => {
  if (ownerChanged()) return;
  void persist({
    ...snapshot.draft,
    report: { ...snapshot.draft.report, title, projectName: title },
  }).catch(() => {});
};

/**
 * Ties this recording to a planned meeting. The title follows unless the user
 * already typed one — their words win over the calendar's, as they do over the
 * model's.
 */
export const setCaptureEvent = (
  event: { id: string; calendarId: string; title: string; provider?:ServiceProvider; connectionId?:string } | null,
) => {
  // A deep link opened mid-meeting must not retag the running recording.
  if (ownerChanged() || isCapturing()) return;
  void persist({
    ...snapshot.draft,
    report: {
      ...snapshot.draft.report,
      calendarEventId: event?.id,
      calendarId: event?.calendarId,
      calendarProvider: event?.provider,
      calendarConnectionId: event?.connectionId,
      ...(event && !snapshot.draft.report.projectName
        ? { title: event.title }
        : {}),
    },
  }).catch(() => {});
};

export function setCaptureHome(home:MicrosoftHome|null) {
  if(ownerChanged() || snapshot.state!=="ready" || busyOperation) return;
  const selected=home?microsoftHome(home):undefined;
  emit({draft:{...snapshot.draft,report:{...snapshot.draft.report,home:selected}}});
}
export const setCaptureError = (error: string) => { if (!ownerChanged()) emit({ error }); };
export const setCaptureBusy = (busy: string) => { if (!ownerChanged()) emit({ busy }); };
export const setCaptureHint = (hint: string) => { if (!ownerChanged()) emit({ hint }); };
export const setCaptureSpeakerName = (speaker: string, name: string) => {
  if (ownerChanged() || !snapshot.draft.report.speech) return;
  const speech = renameSpeaker(snapshot.draft.report.speech, speaker, name);
  void persist({ ...snapshot.draft, report: { ...snapshot.draft.report,
    speech, transcription: renderTranscript(speech),
  } }).catch(() => {});
};
export const setCaptureSingleSpeaker = (source: "mic" | "system", enabled: boolean) => {
  if (ownerChanged() || busyOperation) return;
  if (snapshot.state !== "ready" && snapshot.state !== "armed") return;
  void persist({ ...snapshot.draft, report: { ...snapshot.draft.report,
    singleSpeakerSources: { ...snapshot.draft.report.singleSpeakerSources, [source]: enabled },
  } }).catch(() => {});
};
/** Persist the explicit save choice before any token lookup. */
export async function setCaptureProcessing(analyze: boolean): Promise<void> {
  if (ownerChanged() || snapshot.state !== "review")
    throw new Error("Die Aufnahme ist noch nicht zum Sichern bereit.");
  await persist({ ...snapshot.draft, processing: { ...snapshot.draft.processing, analyze } });
  if (ownerChanged()) throw new Error("Das angemeldete Konto hat sich geändert.");
}

export const setCaptureRetranscribe = (enabled: boolean) => {
  if (ownerChanged() || busyOperation || snapshot.state !== "review") return;
  void persist({ ...snapshot.draft, retranscribe: enabled }).catch(() => {});
};
export const setCaptureLanguages = (languages: string[]) => {
  if (ownerChanged() || isCapturing() || !validLanguages(languages)) return;
  void persist({ ...snapshot.draft, report: { ...snapshot.draft.report,
    speech: { provider: "assemblyai", phase: "pending", turns: [], speakerNames: {}, ...snapshot.draft.report.speech, languages } } }).catch(() => {});
};

/**
 * Opens the devices and stops there.
 *
 * Nothing is written to disk and nothing is sent to a provider until
 * `beginRecording` runs: recording someone before they agree is the offence
 * German law describes, and deleting the file afterwards does not undo it. The
 * armed window exists so that the consent press starts capture instantly, with
 * every browser dialog already behind the user.
 */
export async function armCapture(
  localOnly: boolean,
  verify: () => Promise<void>,
  audioSources: AudioSourcePreference = "mic+system",
) {
  if (ownerChanged() || busyOperation || hasOpenDevices()) return;
  busyOperation = true;
  const attempt = ++captureAttempt;
  const reportId = snapshot.draft.report.id;
  // A previous attempt may have left a dead stream in the device bag, and
  // beginRecording deliberately reads that bag rather than what arm saw.
  releaseCapture();
  emit({ busy: "Aufnahme vorbereiten …", error: "", warning: "", localStartOffered: false, sources: [] });
  const captureOwner = snapshot.owner;
  const current = () => attempt === captureAttempt && snapshot.owner === captureOwner &&
    snapshot.draft.report.id === reportId && !ownerChanged();
  let share: Promise<MediaStream | undefined> | undefined;
  // Request display capture during the actual click, before Drive/mic awaits
  // consume transient user activation. Keep its rejection handled immediately.
  if (audioSources === "mic+system" && navigator.mediaDevices?.getDisplayMedia) {
    try {
      share = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        .then(stream => {
          if (!current()) { stream.getTracks().forEach(t => t.stop()); return undefined; }
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
        if (current()) emit({ localStartOffered: true });
        throw e;
      }
    }
    if (!current()) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw new Error(
        "Aufnahme wird in diesem Browser nicht unterstützt. Bitte eine Audiodatei importieren oder einen aktuellen Browser über HTTPS verwenden.",
      );

    emit({ busy: "Mikrofon vorbereiten …" });
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!current()) { mic.getTracks().forEach(track => track.stop()); return; }
    sources.mic = mic;

    // Browsers only expose system audio through a display-capture prompt, and
    // only alongside a video track. Declining it is a normal outcome. A user
    // who chose microphone-only never sees this prompt at all -- calling
    // getDisplayMedia and discarding the result would still interrupt them
    // with a dialog for something they already said they did not want.
    let system: MediaStream | undefined;
    const displayMediaSupported = !!navigator.mediaDevices.getDisplayMedia;
    if (audioSources === "mic+system" && displayMediaSupported) {
      emit({
        busy: "Systemaudio freigeben … Teile den Tab oder Bildschirm und aktiviere „Audio teilen“.",
      });
      system = await share;
      if (!current()) return;
    }
    // One resolution feeds the warning, the stored source list and the consent
    // notice, so the notice cannot claim a source the recorder never got.
    const resolved = describeAudioSources({
      requested: audioSources,
      displayMediaSupported,
      system,
    });
    if (resolved.warning) emit({ warning: resolved.warning });

    // Microphone only: this list answers "is the capture device still alive",
    // and the display source is independently disposable. Including it meant
    // that clicking Chrome's "Freigabe beenden" ended the whole meeting.
    captureTracks = [...mic.getAudioTracks()];
    stopSystemWatch = watchSystemAudio(system);
    armedSources = { requested: audioSources, displayMediaSupported };
    // Asking for persistent storage raises its own prompt in some browsers —
    // exactly the dialog the armed window exists to get out of the way.
    void navigator.storage?.persist?.().catch(() => {});
    // The user is about to read the notice aloud and not touch the screen.
    void acquireWakeLock();
    emit({ state: "armed", sources: resolved.sources });
  } catch (e) {
    if (attempt !== captureAttempt) return;
    releaseCapture();
    recorder = null;
    emit({
      error:
        (e as Error).name === "NotAllowedError"
          ? "Mikrofonzugriff nicht erlaubt. Bitte in den Browser-Einstellungen freigeben oder Audio importieren."
          : errorMessage(e),
    });
  } finally {
    if (!current() || snapshot.state !== "armed") {
      // A Drive/mic failure can happen while the native picker is still open.
      void share?.then(stream => stream?.getTracks().forEach(t => t.stop()));
    }
    if (attempt === captureAttempt) {
      busyOperation = false;
      emit({ busy: "" });
    }
  }
}

/**
 * Starts the recording the participants just agreed to.
 *
 * The consent record is persisted in the same write that marks the report as
 * recording, and that write is awaited before the recorder starts — so there
 * is no window in which audio is journaled without the permission for it.
 */
export async function beginRecording(decision: ConsentDecision | null) {
  if (busyOperation || snapshot.state !== "armed") return;
  const mic = sources.mic;
  if (!mic) {
    emit({
      error:
        "Das Mikrofon ist nicht mehr verfügbar. Bitte die Aufnahme neu vorbereiten.",
    });
    return;
  }
  busyOperation = true;
  const attempt = captureAttempt;
  const captureOwner = snapshot.owner;
  const reportId = snapshot.draft.report.id;
  const user = auth.currentUser;
  const sameSession = () => attempt === captureAttempt && snapshot.owner === captureOwner &&
    snapshot.draft.report.id === reportId && !ownerChanged();
  const current = () => sameSession() && snapshot.state === "armed";
  emit({ busy: "Einwilligung sichern …", error: "" });
  try {
    if (ownerChanged()) { releaseCapture(); return; }
    if(decision && (decision.storageService || "Google Drive") !== (snapshot.draft.report.home ? "Microsoft OneDrive" : "Google Drive")) throw new Error("Der Speicherort stimmt nicht mit dem Einwilligungshinweis überein. Bitte die Aufnahme neu vorbereiten.");
    // Read the share again rather than trusting what arm saw: a share stopped
    // while the notice was being read is already cleared from module state.
    const system = sources.system;
    const resolved = describeAudioSources({
      requested: armedSources?.requested ?? "mic",
      displayMediaSupported: armedSources?.displayMediaSupported ?? false,
      system,
    });
    // Built here, from the sources that are actually live, so the record can
    // never claim a source the recording does not contain. Null when the user
    // turned the step off: a meeting with no notice documents none, rather
    // than carrying a record that claims an agreement nobody was asked for.
    const consent = decision
      ? buildConsentRecord(decisionFacts(decision, resolved.sources), {
          ...decision,
          obtainedAt: new Date().toISOString(),
        })
      : undefined;
    if (decision && consent?.text !== assembleConsentText(decisionFacts(decision, resolved.sources), decision.parts))
      throw new Error("Der Einwilligungshinweis hat sich geändert. Bitte die Aufnahme neu vorbereiten und den aktuellen Hinweis erneut bestätigen.");
    // The mixed stream is the durable recording; transcription reads each
    // source separately so speech is never lost under what is playing. Built
    // here rather than at arm: a share ended while the notice was being read
    // would otherwise leave a dead input mixed into the recording.
    const merged = mergeAudioStreams(mic, system);
    sources.merged = merged;

    const mimeType = preferredRecordingMimeType();
    const rec = new MediaRecorder(merged.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 64000,
    });
    recorder = rec;
    chunks = [];
    chunkSequence = 0;
    pendingChunks.clear();
    transcriptionDone = null;
    clock.reset();
    await persist({
      ...snapshot.draft,
      report: { ...snapshot.draft.report, date: new Date().toISOString(), captureState: "recording", transcriptionOrigin: "live", captureSources: resolved.sources, consent },
    });

    // Cancel/sign-out can happen during the durable consent write. Neither
    // providers nor the recorder may start from an obsolete preparation.
    if (!current()) return;
    if (mic.getAudioTracks().some(track => track.readyState === "ended") || sources.system !== system)
      throw new Error("Die Audioquellen haben sich geändert. Bitte die Aufnahme neu vorbereiten und den Hinweis erneut bestätigen.");

    const systemAudio =
      system && system.getAudioTracks().length
        ? new MediaStream(system.getAudioTracks())
        : undefined;
    void endShare();
    try {
      share = startLiveShare({
        reportId: snapshot.draft.report.id,
        startedAt: new Date().toISOString(),
        languages: snapshot.draft.report.speech?.languages || defaultLanguages(),
        isOwnerCurrent: sameSession,
        getToken: async () => {
          if (!sameSession()) return undefined;
          const token = await user?.getIdToken();
          return sameSession() ? token : undefined;
        },
        onStatus: (liveShare) => { if (sameSession()) emit({ liveShare }); },
      });
    } catch {
      share = null;
    }
    live = startAssemblyLive(
      { mic: new MediaStream(mic.getAudioTracks()), system: systemAudio },
      elapsed,
      (speech) => {
        if (!sameSession()) {
          if (ownerChanged()) void endShare();
          return;
        }
        const aliases = snapshot.draft.report.speech?.speakerAliases;
        speech = { ...speech, speakerAliases: aliases,
          speakerNames: { ...speech.speakerNames, ...aliases } };
        // Connection health is shown, not saved: it describes this tab right now.
        const { liveConnection, ...saved } = speech;
        speech = saved;
        feedShare(speech);
        const transcription = renderTranscript(speech);
        emit({
          liveConnection,
          ...(speech.liveWarning ? { warning: speech.liveWarning } : {}),
          draft: {
            ...snapshot.draft,
            report: { ...snapshot.draft.report, transcription, speech },
          },
        });
        pendingSnapshot = chunks.length
          ? { ...snapshot.draft, audio: undefined }
          : snapshot.draft;
        syncUnloadProtection();
        // Checkpoint with the recorder's 10-second journal tick. Partial
        // events can arrive many times per second; do not queue a full
        // IndexedDB rewrite for every word. Pause/finish also flush this.

      },
      snapshot.draft.report.id,
      snapshot.draft.report.speech?.languages || defaultLanguages(),
      { ...snapshot.draft.report.singleSpeakerSources },
      snapshot.draft.report.home ? "microsoft" : "google",
    );

    rec.ondataavailable = (event) => {
      if (rec !== recorder || !event.data.size) return;
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
      if (rec !== recorder) return;
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

    let stopped!: () => void;
    const done = new Promise<void>(resolve => { stopped = resolve; });
    const onstop = rec.onstop;
    rec.onstop = event => { try { onstop?.call(rec, event); } finally { stopped(); } };
    rec.start(10_000);
    recorderDone = done;
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

    ticker = window.setInterval(() => {
      if (recorder?.state !== "recording") return;
      emit({ durationMs: elapsed(), transcribing: live?.pendingSegments || 0 });
      // A visible tab gets exact boundaries; a throttled one falls back to the
      // recorder's own data events.
      live?.tick();
    }, 500);
    emit({ state: "recording", durationMs: 0, sources: resolved.sources, liveConnection: undefined });
  } catch (e) {
    if (attempt !== captureAttempt) return;
    releaseCapture();
    recorder = null;
    emit({ state: "ready", error: errorMessage(e) });
  } finally {
    if (attempt === captureAttempt) {
      busyOperation = false;
      emit({ busy: "" });
    }
  }
}

/** Closes the devices without ever having recorded anything. */
export function disarmCapture() {
  if (ownerChanged()) return;
  ++captureAttempt;
  busyOperation = false;
  if (recorder && recorder.state !== "inactive") {
    void endShare();
    stopCapture();
    releaseCapture();
    return;
  }
  releaseCapture();
  recorder = null;
  live = null;
  void endShare();
  emit({ state: "ready", busy: "", warning: "" });
}

/** Rebuilds the live transcription connections; the recording itself is untouched. */
export function restartLive() {
  if (ownerChanged() || recorder?.state !== "recording") return;
  void live?.restart?.();
}

export function pauseCapture() {
  if (ownerChanged()) return;
  const rec = recorder;
  if (!rec) return;
  if (rec.state === "recording") {
    const time = clock.pause();
    rec.pause();
    rec.requestData();
    void live?.pause();
    shareState("paused");
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
    shareState("recording");
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
function drainTranscription(): Promise<string> {
  const pipeline = live;
  if (!pipeline)
    return Promise.resolve(snapshot.draft.report.transcription || "");
  const reportId = snapshot.draft.report.id;
  const captureOwner = snapshot.owner;
  transcriptionDone ||= pipeline.finish().then((transcription) => {
    if (live !== pipeline || snapshot.owner !== captureOwner || snapshot.draft.report.id !== reportId) return transcription;
    live = null;
    // The provider has drained, so the share now holds the final words. Not awaited:
    // ending is bounded but must never hold up the review screen.
    void endShare();
    if (snapshot.draft.report.speech) transcription = renderTranscript(snapshot.draft.report.speech);
    const draft = {
      ...snapshot.draft,
      report: { ...snapshot.draft.report, transcription },
    };
    emit({
      draft,
      transcribing: 0,
      failed: pipeline.failedSegments,
      warning: pipeline.failedSegments
        ? snapshot.draft.report.speech?.liveWarning || "Das Live-Transkript kann Lücken enthalten. Es wird unverändert verwendet; die Originalaufnahme bleibt gespeichert."
        : snapshot.warning,
    });
    pendingSnapshot = chunks.length ? { ...draft, audio: undefined } : draft;
    void queueWrite().catch(() => {});
    return transcription;
  });
  return transcriptionDone;
}

export function finishTranscription(): Promise<string> {
  if (ownerChanged()) return Promise.resolve("");
  const owner = snapshot.owner, reportId = snapshot.draft.report.id;
  return drainTranscription().then(text =>
    !ownerChanged() && snapshot.owner === owner && snapshot.draft.report.id === reportId ? text : "");
}

export function stopCapture() {
  if (ownerChanged()) return;
  const rec = recorder;
  if (!rec || rec.state === "inactive") return;
  const time = clock.pause();
  emit({ durationMs: time });
  rec.stop();
  void finishTranscription().catch(() => {});
}

export async function importAudio(file: File) {
  if (ownerChanged() || busyOperation || hasOpenDevices()) return;
  const owner = snapshot.owner, reportId = snapshot.draft.report.id, attempt = captureAttempt;
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
  if (ownerChanged() || snapshot.owner !== owner || snapshot.draft.report.id !== reportId || attempt !== captureAttempt) return;
  // The import moves to a fresh report id, so the record it leaves behind is
  // orphaned — it would show up forever as an unfinished recording with no
  // audio, and its chunk journal would keep the megabytes.
  const previousId = snapshot.draft.report.id;
  chunks = [];
  pendingChunks.clear();
  pendingSnapshot = null;
  chunkSequence = 0;
  live = null;
  void endShare();
  transcriptionDone = null;
  clock.reset();
  emit({ error: "", durationMs: 0, state: "review" });
  await persist({
    ...snapshot.draft,
    audio: file,
    speakerReference: undefined,
    microsoftUploadHandle: undefined,
    retranscribe: undefined,
    // Replacing audio starts a NEW submission identity; never reuse a provider
    // job from the previous file under the same report ID.
    // An import is a new meeting: without this it inherits whenever this draft
      // slot was first opened, which the calendar and the list both show.
      report: { ...snapshot.draft.report, id: crypto.randomUUID(), date: new Date().toISOString(), updatedAt: undefined, error: "", rawAudioUrl: undefined,
      home: snapshot.draft.report.home ? {provider:"microsoft",connectionId:snapshot.draft.report.home.connectionId,driveId:snapshot.draft.report.home.driveId,rootId:snapshot.draft.report.home.rootId,rootName:snapshot.draft.report.home.rootName} : undefined,
      transcriptionOrigin: "import", captureState: undefined, captureSources: undefined, singleSpeakerSources: undefined,
      driveFolderId: undefined, driveReportId: undefined, driveMarkdownId: undefined,
      driveTranscriptId: undefined, driveConsentId: undefined, driveSyncedAt: undefined,
      // An inherited consent record would attach one meeting's permission —
      // and one meeting's deletion deadline — to a different recording.
      consent: undefined, audioDeletedAt: undefined, audioDeleteAttempts: undefined,
      audioDeleteError: undefined, transcriptChars: undefined, participants: undefined,
      speakerReviewPending: undefined,
      calendarEventId: undefined, calendarId: undefined, calendarLink: undefined,
      calendarProvider: undefined, calendarConnectionId: undefined,
      calendarSyncedAt: undefined, calendarError: undefined, transcription: "", summary: "", todos: [], takeaways: [], status: "pending", durationMs: 0,
      speech: { provider: "assemblyai", phase: "pending", languages: snapshot.draft.report.speech?.languages || defaultLanguages(), turns: [], speakerNames: {} } },
  });
  if (ownerChanged() || snapshot.owner !== owner || attempt !== captureAttempt) return;
  if (previousId && previousId !== snapshot.draft.report.id)
    await deleteDraft(owner, previousId).catch(() => {});
  return snapshot.draft.report.id;
}

/**
 * Throws the take away and resets to an empty capture. It deliberately returns
 * nothing: it used to hand back the id of the fresh blank draft, and the only
 * caller read that as somewhere to navigate — which left the user standing on
 * the recorder after asking to discard.
 */
export async function discardCapture() {
  if (ownerChanged()) return;
  const attempt = ++captureAttempt;
  const owner = snapshot.owner, reportId = snapshot.draft.report.id;
  if (recorder && recorder.state !== "inactive") recorder.stop();
  releaseCapture();
  void endShare();
  await drainTranscription();
  await recorderDone;
  await queue.catch(() => {});
  if (ownerChanged() || snapshot.owner !== owner || snapshot.draft.report.id !== reportId || attempt !== captureAttempt) return;
  await deleteDraft(owner, reportId);
  if (ownerChanged() || snapshot.owner !== owner || snapshot.draft.report.id !== reportId || attempt !== captureAttempt) return;
  chunks = [];
  pendingChunks.clear();
  pendingSnapshot = null;
  clock.reset();
  recorder = null;
  live = null;
  void endShare();
  transcriptionDone = null;
  snapshot = blank(snapshot.owner);
  retainedOwnerTake = false;
  emit({});
}

/** Clears the session after its draft has been handed to the save pipeline. */
export function releaseAfterHandoff() {
  if (ownerChanged()) return;
  ++captureAttempt;
  releaseCapture();
  chunks = [];
  pendingChunks.clear();
  pendingSnapshot = null;
  clock.reset();
  recorder = null;
  live = null;
  void endShare();
  transcriptionDone = null;
  snapshot = blank(snapshot.owner);
  retainedOwnerTake = false;
  emit({});
}
