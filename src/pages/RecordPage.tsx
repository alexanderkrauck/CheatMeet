import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Download,
  Mic,
  Pause,
  Play,
  ArrowRight,
  FolderOpen,
  MoreHorizontal,
  Loader2,
  Trash2,
  Upload,
  WandSparkles,
  CloudUpload,
} from "lucide-react";
import { AudioPreview } from "../components/UI";
import {
  startLiveTranscription,
  type LiveTranscription,
} from "../lib/liveTranscription";
import { mergeAudioStreams, type MergedAudio } from "../lib/audioMerge";
import RecordingSheet from "../components/RecordingSheet";
import LiveMeeting from "../components/LiveMeeting";
import { savedDriveFolder } from "../lib/driveSettings";
import "./record.css";
import { useRecordingLifecycle } from "../lib/useRecordingLifecycle";
import {
  getDraft,
  putDraft,
  putLocal,
  deleteDraft,
  appendRecordingChunk,
} from "../lib/local";
import { uid } from "../lib/reports";
import { verifyDriveAccess } from "../lib/drive";
import { errorMessage, connectGoogle, driveToken } from "../lib/session";
import { startProcessing } from "../lib/pipeline";
import {
  AUDIO_MIME_TYPES,
  MAX_FILE_BYTES,
  audioExtension,
} from "../../shared/analysis";
import type { Draft } from "../types";
import DriveSettings from "../components/DriveSettings";
import { RecordingClock, preferredRecordingMimeType } from "../lib/recording";
const fresh = (): Draft => ({
  report: {
    id: crypto.randomUUID(),
    date: new Date().toISOString(),
    title: "",
    summary: "",
    transcription: "",
    todos: [],
    takeaways: [],
    status: "pending",
  },
});
export const formatTime = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}`;
export default function RecordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedDraft = useRef(searchParams.get("draft")).current;
  const startNew = useRef(searchParams.has("new")).current;
  const [accountId] = useState(uid);
  const [draft, setDraft] = useState<Draft>(fresh);
  const current = useRef(draft);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<
    "ready" | "recording" | "paused" | "review"
  >("ready");
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [saved, setSaved] = useState(false);
  const [checkpointMs, setCheckpointMs] = useState(0);
  const [sheet, setSheet] = useState<
    "settings" | "options" | "leave" | null
  >(null);
  const [localStartOffered, setLocalStartOffered] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [folder, setFolder] = useState(savedDriveFolder);
  const [, refreshDriveSession] = useState(0);
  const driveReady = !!driveToken(state === "ready" ? 10 * 60 * 1000 : 0);
  useEffect(() => {
    const update = () => refreshDriveSession((n) => n + 1);
    const timer = window.setInterval(update, 5000);
    window.addEventListener("cheatmeet:drive-session", update);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("cheatmeet:drive-session", update);
      window.removeEventListener("focus", update);
    };
  }, []);
  const saveButton = useRef<HTMLButtonElement>(null);
  const recording = state === "recording" || state === "paused";
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const update = () => setOnline(navigator.onLine);
    const updateFolder = () => setFolder(savedDriveFolder());
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    window.addEventListener("cheatmeet:drive-settings", updateFolder);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      window.removeEventListener("cheatmeet:drive-settings", updateFolder);
    };
  }, []);
  useEffect(() => {
    if (state === "review" && !loading)
      saveButton.current?.focus({ preventScroll: true });
  }, [state, loading]);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const chunkSequence = useRef(0);
  const pendingChunks = useRef(
    new Map<number, { blob: Blob; durationMs: number; reportId: string }>(),
  );
  const clock = useRef(new RecordingClock());
  const live = useRef<LiveTranscription | null>(null);
  const capture = useRef<{
    mic?: MediaStream;
    system?: MediaStream;
    merged?: MergedAudio;
  }>({});
  const captureTracks = useRef<MediaStreamTrack[]>([]);
  const transcriptionTicker = useRef<number | undefined>(undefined);
  const transcriptionDone = useRef<Promise<string> | null>(null);
  const [transcribing, setTranscribing] = useState(0);
  const operation = useRef(false);
  const revision = useRef(0);
  const queue = useRef(Promise.resolve());
  const pendingSnapshot = useRef<Draft | null>(null);
  const active = useRef(true);
  const audioInput = useRef<HTMLInputElement>(null);
  const elapsedNow = () => clock.current.read();
  /**
   * Releases every device this page opened. The recorder's own stream may be a
   * mixing destination, so stopping it alone leaves the microphone and the
   * screen-share indicator running.
   */
  const releaseCapture = () => {
    const { mic, system, merged } = capture.current;
    merged?.dispose();
    for (const source of [mic, system])
      source?.getTracks().forEach((track) => track.stop());
    capture.current = {};
    captureTracks.current = [];
  };
  const flushChunks = async () => {
    for (const [sequence, chunk] of [...pendingChunks.current]) {
      await appendRecordingChunk(
        accountId,
        chunk.reportId,
        sequence,
        chunk.blob,
        chunk.durationMs,
      );
      pendingChunks.current.delete(sequence);
      if (active.current) setCheckpointMs(chunk.durationMs);
    }
  };
  const queueWrite = (write: () => Promise<void>) => {
    const writeRevision = ++revision.current;
    if (active.current) setSaved(false);
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        await flushChunks();
        const snapshot = pendingSnapshot.current;
        if (snapshot) {
          await putDraft(accountId, snapshot);
          if (pendingSnapshot.current === snapshot)
            pendingSnapshot.current = null;
        }
        await write();
      });
    queue.current
      .then(() => {
        if (
          active.current &&
          writeRevision === revision.current &&
          pendingChunks.current.size === 0 &&
          !pendingSnapshot.current
        ) {
          setSaved(true);
          setError((previous) =>
            previous.startsWith("Lokales Speichern fehlgeschlagen.")
              ? ""
              : previous,
          );
        }
      })
      .catch(() => {
        if (active.current)
          setError(
            "Lokales Speichern fehlgeschlagen. Die Aufnahme bleibt im Arbeitsspeicher. Bitte die Seite geöffnet lassen, die Meeting abschließen und das Audio über Weitere Optionen herunterladen.",
          );
      });
    return queue.current;
  };
  const persist = (next: Draft) => {
    current.current = next;
    if (active.current) setDraft(next);
    // Audio is journaled separately: never rewrite an hour-long Blob every second.
    const snapshot = chunks.current.length
      ? { ...next, audio: undefined }
      : next;
    pendingSnapshot.current = snapshot;
    return queueWrite(async () => {});
  };
  const { wakeLockState } = useRecordingLifecycle({
    recorderRef: recorder,
    tracksRef: captureTracks,
    active: recording,
    onInterrupted: (reason) => {
      if (!active.current) return;
      const rec = recorder.current;
      if (reason === "muted" && rec?.state === "recording") {
        pause();
        setWarning(
          "Das Telefon hat das Mikrofon unterbrochen. Die Aufnahme ist pausiert. Prüfe das Mikrofon und tippe dann auf Weiter.",
        );
      } else if (reason !== "muted") {
        clock.current.pause();
        if (rec && rec.state !== "inactive") stop();
        else {
          setDuration(elapsedNow());
          setState("review");
        }
        setWarning(
          "Das Telefon hat die Aufnahme beendet. Die bisher erfassten Audiodaten sind im Entwurf. Bitte anhören und sichern.",
        );
      }
    },
    onVisibilityReturn: () => {
      void queueWrite(async () => {}).catch(() => {});
    },
  });
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    const restore = startNew
      ? Promise.resolve(undefined)
      : getDraft(accountId, requestedDraft || undefined);
    restore
      .then((d) => {
        if (d && !cancelled) {
          current.current = d;
          setDraft(d);
          setState(d.audio ? "review" : "ready");
          setDuration(d.report.durationMs || 0);
          setCheckpointMs(d.report.durationMs || 0);
          clock.current.reset(d.report.durationMs || 0);
          setSaved(true);
          if (d.audio && d.report.captureState !== "stopped")
            setWarning(
              "Eine frühere Aufnahme wurde wiederhergestellt. Bitte die gesicherten Audiodaten anhören und anschließend in Drive sichern.",
            );
        }
        if (!cancelled)
          navigate(`/record?draft=${(d || current.current).report.id}`, {
            replace: true,
          });
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const timer = setInterval(() => {
      if (recorder.current?.state !== "recording") return;
      setDuration(elapsedNow());
      // A visible tab gets exact segment boundaries; a throttled one falls back
      // to the recorder's own data events.
      live.current?.tick();
    }, 250);
    const unload = (e: BeforeUnloadEvent) => {
      if (
        (recorder.current && recorder.current.state !== "inactive") ||
        current.current.audio
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      cancelled = true;
      active.current = false;
      clearInterval(timer);
      window.removeEventListener("beforeunload", unload);
      clock.current.pause();
      if (transcriptionTicker.current !== undefined)
        clearInterval(transcriptionTicker.current);
      void live.current?.finish().catch(() => {});
      live.current = null;
      if (recorder.current && recorder.current.state !== "inactive")
        recorder.current.stop();
      releaseCapture();
    };
  }, []);
  async function authorizeDrive() {
    if (operation.current) return;
    operation.current = true;
    setError("");
    setBusy("Google Drive freigeben …");
    try {
      const token = await connectGoogle();
      await verifyDriveAccess(token);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      operation.current = false;
      if (active.current) {
        setBusy("");
        refreshDriveSession((n) => n + 1);
      }
    }
  }
  async function start(localOnly = false) {
    // Recheck at the actual click: the displayed token state may be a few seconds old.
    if (!localOnly && navigator.onLine && !driveToken(10 * 60 * 1000)) {
      await authorizeDrive();
      return;
    }
    if (operation.current) return;
    operation.current = true;
    let stream: MediaStream | undefined;
    setBusy("Aufnahme vorbereiten …");
    setError("");
    setLocalStartOffered(false);
    try {
      if (!localOnly && navigator.onLine) {
        const token = driveToken();
        if (!token) throw new Error("Bitte zuerst Google Drive freigeben.");
        setBusy("Drive-Berechtigung prüfen …");
        try {
          await verifyDriveAccess(token);
        } catch (e) {
          if (active.current && driveToken()) setLocalStartOffered(true);
          throw e;
        }
      }
      if (!active.current || uid() !== accountId) return;
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          "Aufnahme wird in diesem Browser nicht unterstützt. Bitte eine Audiodatei importieren oder einen aktuellen Browser über HTTPS verwenden.",
        );

      setBusy("Mikrofon vorbereiten …");
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      capture.current.mic = micStream;

      // Browsers only expose system audio through a display-capture prompt, and
      // only alongside a video track. Declining it is a normal outcome: the
      // meeting is then recorded from the microphone alone.
      let systemStream: MediaStream | undefined;
      if (navigator.mediaDevices.getDisplayMedia) {
        setBusy(
          "Systemaudio freigeben … Teile den Tab oder Bildschirm und aktiviere „Audio teilen“. Ohne Freigabe wird nur das Mikrofon aufgenommen.",
        );
        try {
          systemStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
          capture.current.system = systemStream;
          if (!systemStream.getAudioTracks().length)
            setWarning(
              "Die Freigabe enthält kein Systemaudio. Es wird nur das Mikrofon aufgenommen.",
            );
        } catch (e) {
          console.warn("System audio was not shared", e);
        }
      }

      const merged = mergeAudioStreams(micStream, systemStream);
      capture.current.merged = merged;
      stream = merged.stream;
      captureTracks.current = [
        ...micStream.getAudioTracks(),
        ...(systemStream?.getAudioTracks() || []),
      ];

      if (!active.current) {
        releaseCapture();
        return;
      }

      const mime = preferredRecordingMimeType();
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream, {
          ...(mime ? { mimeType: mime } : {}),
          audioBitsPerSecond: 64000,
        });
      } catch (e) {
        releaseCapture();
        throw e;
      }
      recorder.current = rec;
      chunks.current = [];
      chunkSequence.current = 0;
      transcriptionDone.current = null;
      clock.current.reset();
      await persist({
        ...current.current,
        report: { ...current.current.report, captureState: "recording" },
      });
      if (!active.current) {
        releaseCapture();
        return;
      }
      void navigator.storage?.persist?.().catch(() => {});
      live.current = startLiveTranscription(stream, elapsedNow, (transcription) => {
        const next = {
          ...current.current,
          report: { ...current.current.report, transcription },
        };
        current.current = next;
        if (active.current) setDraft(next);
        void queueWrite(async () => {}).catch(() => {});
      });
      transcriptionTicker.current = window.setInterval(() => {
        if (active.current) setTranscribing(live.current?.pendingSegments || 0);
      }, 1000);
      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        chunks.current.push(e.data);
        const audio = new Blob(chunks.current, {
          type: rec.mimeType || e.data.type,
        });
        const durationMs = elapsedNow();
        const next = {
          ...current.current,
          audio,
          report: { ...current.current.report, durationMs },
        };
        current.current = next;
        if (active.current) setDraft(next);
        pendingChunks.current.set(chunkSequence.current++, {
          blob: e.data,
          durationMs,
          reportId: next.report.id,
        });
        void queueWrite(async () => {}).catch(() => {});
        // Media-pipeline driven, so segment boundaries survive a hidden tab
        // whose timers are throttled.
        live.current?.tick();
      };
      rec.onerror = () => {
        if (active.current)
          setError(
            "Die Aufnahme wurde unterbrochen. Prüfe die bisher gespeicherte Aufnahme.",
          );
        if (rec.state !== "inactive") stop();
        else {
          clock.current.pause();
          releaseCapture();
          if (active.current) setState("review");
        }
      };
      rec.onstop = () => {
        const finalDuration = clock.current.pause();
        releaseCapture();
        if (current.current.audio)
          void persist({
            ...current.current,
            report: {
              ...current.current.report,
              durationMs: finalDuration,
              captureState: "stopped",
            },
          }).catch(() => {});
        if (active.current) {
          setDuration(finalDuration);
          setState("review");
        }
      };
      // Journals the durable recording to IndexedDB; transcription segments are
      // captured separately so they stay independently decodable.
      rec.start(10_000);
      clock.current.resume();
      setState("recording");
      setDuration(0);
    } catch (e) {
      releaseCapture();
      if (active.current)
        setError(
          (e as Error).name === "NotAllowedError"
            ? "Mikrofonzugriff nicht erlaubt. Bitte in den Browser-Einstellungen freigeben oder Audio importieren."
            : errorMessage(e),
        );
    } finally {
      operation.current = false;
      if (active.current) setBusy("");
    }
  }
  function pause() {
    const rec = recorder.current;
    if (!rec) return;
    if (rec.state === "recording") {
      const time = clock.current.pause();
      rec.pause();
      rec.requestData();
      void live.current?.pause();
      setState("paused");
      setDuration(time);
      void persist({
        ...current.current,
        report: { ...current.current.report, captureState: "paused" },
      }).catch(() => {});
    } else if (rec.state === "paused") {
      // Check the real capture devices: when system audio is mixed in, the
      // recorder's own track is synthetic and never reports a dead microphone.
      if (
        captureTracks.current.some(
          (track) => track.muted || track.readyState === "ended",
        )
      ) {
        setWarning(
          "Das Mikrofon ist noch nicht verfügbar. Die Aufnahme bleibt pausiert.",
        );
        return;
      }
      void live.current?.resume();
      setWarning("");
      clock.current.resume();
      rec.resume();
      setState("recording");
      void persist({
        ...current.current,
        report: { ...current.current.report, captureState: "recording" },
      }).catch(() => {});
    }
  }
  /**
   * Transcribes the trailing segment and adopts the completed transcript.
   * Analysis must not run against a transcript that stops seconds before the
   * meeting did, so this resolves once every queued segment has been applied.
   */
  function finishTranscription(): Promise<string> {
    const pipeline = live.current;
    if (!pipeline)
      return Promise.resolve(current.current.report.transcription || "");
    transcriptionDone.current ||= pipeline.finish().then((transcription) => {
      if (transcriptionTicker.current !== undefined)
        clearInterval(transcriptionTicker.current);
      const next = {
        ...current.current,
        report: { ...current.current.report, transcription },
      };
      current.current = next;
      if (active.current) {
        setDraft(next);
        setTranscribing(0);
        if (pipeline.failedSegments)
          setWarning(
            `${pipeline.failedSegments} Abschnitt(e) konnten nicht transkribiert werden. Das Transkript ist möglicherweise unvollständig; die Originalaufnahme ist vollständig.`,
          );
      }
      void queueWrite(async () => {}).catch(() => {});
      return transcription;
    });
    return transcriptionDone.current;
  }

  function stop() {
    const rec = recorder.current;
    if (!rec || rec.state === "inactive") return;
    const time = clock.current.pause();
    if (active.current) setDuration(time);
    rec.stop();
    void finishTranscription().catch(() => {});
  }
    async function importAudio(file?: File) {
    if (!file || operation.current) return;
    setError("");
    if (
      file.size > MAX_FILE_BYTES ||
      !file.size ||
      !(AUDIO_MIME_TYPES as readonly string[]).includes(file.type)
    ) {
      setError(
        "Bitte eine Audiodatei wählen (WebM, M4A, MP3, WAV, Ogg, AAC oder FLAC).",
      );
      return;
    }
    // The in-memory audio remains downloadable even if IndexedDB is full.
    clock.current.reset();
    setDuration(0);
    setState("review");
    await persist({
      ...current.current,
      audio: file,
      report: { ...current.current.report, durationMs: 0 },
    });
  }
  async function process(analyze: boolean) {
    if (!current.current.audio || operation.current) return;
    operation.current = true;
    setError("");
    setWarning("");
    setBusy("Transkription abschließen …");
    try {
      // Saving never starts an unexpected OAuth popup.
      const token = driveToken();
      if (!token) {
        refreshDriveSession((n) => n + 1);
        throw new Error(
          "Die Drive-Freigabe ist abgelaufen. Bitte zuerst Google Drive verbinden. Dein Entwurf bleibt erhalten.",
        );
      }
      if (!active.current || uid() !== accountId) return;
      await finishTranscription().catch(() => {});
      if (!active.current || uid() !== accountId) return;

      setBusy("Entwurf lokal sichern …");
      await queue.current.catch(() => {});
      if (!active.current || uid() !== accountId) return;
      const d = current.current;
      d.report.title ||= `Meeting vom ${new Date(d.report.date).toLocaleDateString("de-AT")}`;
      d.report.status = analyze ? "analyzing" : d.report.status;
      await persist(d);
      // The report must be readable before its page opens; the rest of the
      // pipeline continues in the background.
      await putLocal(accountId, d.report);
      if (!active.current || uid() !== accountId) return;

      void startProcessing({ owner: accountId, draft: d, token, analyze });
      current.current = fresh();
      navigate(`/report/${d.report.id}`);
    } catch (e) {
      if (active.current) setError(errorMessage(e));
    } finally {
      operation.current = false;
      if (active.current) setBusy("");
    }
  }
  async function discard() {
    if (
      !window.confirm(
        "Diesen lokalen Entwurf einschließlich der Aufnahme verwerfen? Bereits in Drive gespeicherte Dateien bleiben erhalten.",
      )
    )
      return;
    await queue.current.catch(() => {});
    await deleteDraft(accountId, current.current.report.id);
    chunks.current = [];
    pendingChunks.current.clear();
    pendingSnapshot.current = null;
    const d = fresh();
    current.current = d;
    setDraft(d);
    setState("ready");
    clock.current.reset();
    setDuration(0);
    setCheckpointMs(0);
    setError("");
    setWarning("");
    setSaved(false);
    navigate(`/record?draft=${d.report.id}`, { replace: true });
  }
  function download() {
    if (!draft.audio) return;
    const url = URL.createObjectURL(draft.audio);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aufnahme.${audioExtension(draft.audio.type)}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function leave() {
    if (busy || recording) return;
    if (current.current.audio) setSheet("leave");
    else navigate("/dashboard");
  }
      return (
    <div className={`walk-page walk-${state}`}>
      <div className="walk-frame" inert={sheet !== null}>
        <header className="walk-header">
          <button
            className="walk-icon"
            aria-label="Zur Übersicht"
            disabled={recording || !!busy || loading}
            onClick={leave}
          >
            <ArrowLeft size={21} />
          </button>
          <div>
            <span className="walk-step">
              {state === "review" ? "SCHRITT 2 VON 2" : "SCHRITT 1 VON 2"}
            </span>
            <strong>
              {state === "review"
                ? "Sichern & analysieren"
                : "Meeting aufnehmen"}
            </strong>
          </div>
          <button
            className="walk-icon"
            aria-label="Weitere Optionen"
            disabled={recording || !!busy || loading}
            onClick={() => setSheet("options")}
          >
            <MoreHorizontal size={23} />
          </button>
        </header>
        {(error || warning || !online) && (
          <div
            className={`walk-message ${error ? "is-error" : ""}`}
            role={error ? "alert" : "status"}
          >
            {error ||
              warning ||
              "Offline · Aufnahme möglich. Zum Sichern in Drive benötigst du Internet."}
          </div>
        )}
        {loading ? (
          <main className="walk-progress" role="status">
            <Loader2 className="spin" />
            <h1>Entwurf laden …</h1>
          </main>
        ) : (
          <>
            <main className="walk-content">
              {state === "ready" ? (
                <>
                  <label className="walk-project">
                    <span>PROJEKT / MEETING</span>
                    <input
                      id="title"
                      placeholder="z. B. Weekly Sync · Q3 Planning"
                      value={draft.report.title}
                      onChange={(e) => {
                        void persist({
                          ...current.current,
                          report: {
                            ...current.current.report,
                            title: e.target.value,
                            projectName: e.target.value,
                          },
                        }).catch(() => {});
                      }}
                    />
                  </label>
                  <div className="walk-ready-intro">
                    <div className="walk-mic-symbol">
                      <Mic size={32} />
                    </div>
                    <h1>
                      Ein Meeting.
                      <br />
                      Alles festgehalten.
                    </h1>
                    <p>
                      Sprich und diskutiere frei, CheatMeet protokolliert im Hintergrund.
                    </p>
                  </div>
                  <button
                    className="walk-folder"
                    onClick={() => setSheet("settings")}
                  >
                    <FolderOpen size={18} />
                    <span>
                      <small>SPEICHERORT IN GOOGLE DRIVE</small>
                      <strong>
                        {folder?.name || "CheatMeet Recordings"}
                      </strong>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                </>
              ) : recording ? (
                <LiveMeeting
                  transcript={draft.report.transcription}
                  pending={transcribing}
                  paused={state === "paused"}
                  timer={formatTime(duration)}
                />
              ) : (
                <>
                  <div className="walk-review-intro">
                    <span className="walk-pending">
                      Noch nicht fertig · Sichern steht aus
                    </span>
                    <h1>
                      Aufnahme fertig.
                      <br />
                      Jetzt den Bericht erstellen.
                    </h1>
                    <p>
                      Audio in Drive sichern und automatisch Zusammenfassungen,
                      Takeaways und To-Dos erstellen.
                    </p>
                  </div>
                  <div className="walk-review-media">
                    <div className="walk-review-stats">
                      <span>
                        <Mic size={18} />
                        {formatTime(duration)} Aufnahme
                      </span>
                    </div>
                    {draft.audio && <AudioPreview blob={draft.audio} />}
                  </div>
                  <button
                    className="walk-folder"
                    onClick={() => setSheet("settings")}
                  >
                    <FolderOpen size={18} />
                    <span>
                      <small>SPEICHERORT IN GOOGLE DRIVE</small>
                      <strong>
                        {folder?.name || "CheatMeet Recordings"}
                      </strong>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                </>
              )}
            </main>
            <footer className="walk-dock">
              {busy && (
                <p className="walk-busy" role="status" aria-live="polite">
                  <Loader2 className="spin" size={15} />
                  {busy}
                </p>
              )}
              {recording ? (
                <>
                  <div className="walk-capture-controls">
                    <button
                      className="walk-pause"
                      onClick={pause}
                      aria-label={
                        state === "paused"
                          ? "Aufnahme fortsetzen"
                          : "Aufnahme pausieren"
                      }
                    >
                      {state === "paused" ? (
                        <Play size={23} />
                      ) : (
                        <Pause size={23} />
                      )}
                      <span>{state === "paused" ? "Weiter" : "Pause"}</span>
                    </button>
                    
                  </div>
                  <button className="walk-finish" onClick={stop}>
                    <span>
                      <strong>Meeting abschließen</strong>
                      <small>Weiter zum Sichern & Analysieren</small>
                    </span>
                    <ArrowRight size={22} />
                  </button>
                </>
              ) : state === "ready" ? (
                <>
                  <button
                    className="walk-primary"
                    disabled={!!busy}
                    onClick={() => void start()}
                  >
                    <Mic size={22} />
                    {online && !driveReady
                      ? "Google Drive freigeben"
                      : "Aufnahme starten"}
                  </button>
                  {localStartOffered && (
                    <button
                      className="walk-secondary"
                      onClick={() => void start(true)}
                    >
                      Trotzdem lokal aufnehmen · später in Drive sichern
                    </button>
                  )}
                  <button
                    className="walk-secondary"
                    onClick={() => {
                      if (navigator.onLine && !driveToken(10 * 60 * 1000))
                        void authorizeDrive();
                      else audioInput.current?.click();
                    }}
                    disabled={online && !driveReady}
                  >
                    <Upload size={16} />
                    Vorhandenes Audio importieren
                  </button>
                </>
              ) : (
                <>
                  {online && !driveReady && (
                    <button className="walk-secondary" onClick={authorizeDrive}>
                      Google Drive vor dem Speichern verbinden
                    </button>
                  )}
                  <button
                    ref={saveButton}
                    className="walk-primary"
                    disabled={
                      !!busy || !online || !driveReady || !draft.audio?.size
                    }
                    onClick={() => process(true)}
                  >
                    <WandSparkles size={21} />
                    In Drive sichern & analysieren
                    <ArrowRight size={18} />
                  </button>
                  <p className="walk-save-hint">
                    {!online
                      ? "Sobald du online bist, kannst du hier fortfahren."
                      : !driveReady
                        ? "Drive-Freigabe fehlt oder ist abgelaufen. Dein Entwurf bleibt lokal gesichert."
                        : "Originale sichern → KI-Bericht erstellen → fertig"}
                  </p>
                </>
              )}
              {recording && (
                <p className="walk-lock-status">
                  {wakeLockState === "active"
                    ? "Bildschirm bleibt wach · manuelles Sperren kann unterbrechen"
                    : "Bildschirm bitte offen lassen · automatisches Wachhalten nicht aktiv"}
                </p>
              )}
              <p className="walk-local-status">
                {recording ? (
                  checkpointMs > 0 ? (
                    `Audio lokal gesichert bis ${formatTime(checkpointMs)}`
                  ) : (
                    "Erste Audiosicherung läuft …"
                  )
                ) : state === "ready" ? (
                  online ? (
                    driveReady ? (
                      "Drive verbunden · Aufnahme bereit"
                    ) : (
                      "Zuerst Drive freigeben, dann die Aufnahme starten."
                    )
                  ) : (
                    "Offline aufnehmen · später mit Drive verbinden"
                  )
                ) : saved ? (
                  <>
                    <Check size={13} />
                    Entwurf auf diesem Gerät gespeichert
                  </>
                ) : draft.audio ? (
                  "Lokale Sicherung läuft …"
                ) : online && !driveReady ? (
                  "Zuerst Drive freigeben, dann die Aufnahme starten."
                ) : online ? (
                  "Drive verbunden · Aufnahme bereit"
                ) : (
                  "Offline aufnehmen · später mit Drive verbinden"
                )}
              </p>
            </footer>
          </>
        )}
      </div>
      <input
        type="file"
        ref={audioInput}
        hidden
        accept="audio/*"
        onChange={(e) => {
          void importAudio(e.target.files?.[0]).catch((e) =>
            setError(errorMessage(e)),
          );
          e.target.value = "";
        }}
      />
      
      
      {sheet && (
        <RecordingSheet
          title={
            sheet === "settings"
              ? "Speicherort"
              : sheet === "leave"
                ? "Dein Bericht ist noch nicht gesichert"
                : "Weitere Optionen"
          }
          onClose={() => setSheet(null)}
        >
          {sheet === "settings" ? (
            <DriveSettings />
          ) : sheet === "leave" ? (
            <div className="walk-leave">
              <p>
                Audio bleibt als lokaler Entwurf auf diesem Gerät.
                Der Drive-Upload und die Analyse stehen noch aus.
              </p>
              <button
                className="walk-primary"
                onClick={() => {
                  setSheet(null);
                  saveButton.current?.focus();
                }}
              >
                Zurück zum Sichern & Analysieren
              </button>
              <button
                className="walk-secondary"
                onClick={() => navigate("/dashboard")}
              >
                Bewusst als Entwurf verlassen
              </button>
            </div>
          ) : (
            <div className="walk-options">
              {draft.audio && (
                <>
                  <button
                    onClick={() => {
                      download();
                      setSheet(null);
                    }}
                  >
                    <Download size={19} />
                    Audio herunterladen
                  </button>
                  <button
                    disabled={!online || !driveReady}
                    onClick={() => {
                      setSheet(null);
                      void process(false);
                    }}
                  >
                    <CloudUpload size={19} />
                    Nur in Drive sichern, ohne Analyse
                  </button>
                  <button onClick={() => setSheet("leave")}>
                    <ArrowLeft size={19} />
                    Als Entwurf später fortsetzen
                  </button>
                </>
              )}
              <button onClick={() => setSheet("settings")}>
                <FolderOpen size={19} />
                Speicherort ändern
              </button>
              <button
                className="danger"
                onClick={() => {
                  void discard()
                    .then(() => setSheet(null))
                    .catch((e) => setError(errorMessage(e)));
                }}
              >
                <Trash2 size={19} />
                Entwurf verwerfen
              </button>
            </div>
          )}
        </RecordingSheet>
      )}
    </div>
  );
}
