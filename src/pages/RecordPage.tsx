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
import { LiveTranscriber } from "../lib/liveTranscription";
import { mergeAudioStreams } from "../lib/audioMerge";
import RecordingSheet from "../components/RecordingSheet";
import { savedDriveFolder } from "../lib/driveSettings";
import "./record.css";
import { useRecordingLifecycle } from "../lib/useRecordingLifecycle";
import {
  getDraft,
  putDraft,
  deleteDraft,
  appendRecordingChunk,
} from "../lib/local";
import { uid, saveReport } from "../lib/reports";
import { verifyDriveAccess } from "../lib/drive";
import { errorMessage, connectGoogle, driveToken } from "../lib/session";
import { analyzeDraft, backupDraft, syncReport } from "../lib/workflow";
import {
  MAX_FILE_BYTES,
  MAX_PHOTOS,
  audioExtension,
} from "../../shared/analysis";
import type { Draft } from "../types";
import DriveSettings from "../components/DriveSettings";
import { RecordingClock } from "../lib/recording";
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
  photos: [],
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
  const liveTranscriber = useRef<LiveTranscriber | null>(null);
  const operation = useRef(false);
  const revision = useRef(0);
  const queue = useRef(Promise.resolve());
  const pendingSnapshot = useRef<Draft | null>(null);
  const active = useRef(true);
  const audioInput = useRef<HTMLInputElement>(null);
  const elapsedNow = () => clock.current.read();
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
      if (recorder.current?.state === "recording") setDuration(elapsedNow());
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
      if (recorder.current) {
        if (recorder.current.state !== "inactive") recorder.current.stop();
        recorder.current.stream.getTracks().forEach((t) => t.stop());
      }
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
      const isMac = navigator.userAgent.includes("Mac");
      const hint = isMac ? "Bitte gib im folgenden Dialog den Tab frei (inkl. Systemaudio)." : "Bitte teile deinen Bildschirm oder ein Fenster und setze den Haken bei 'Systemaudio teilen'.";
      setBusy(`Mikrofon und Systemaudio vorbereiten... ${hint}`);
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          "Aufnahme wird in diesem Browser nicht unterstützt. Bitte eine Audiodatei importieren oder einen aktuellen Browser über HTTPS verwenden.",
        );
      
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let systemStream: MediaStream | undefined;
      try {
        systemStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch(e) {
        console.warn("User cancelled system audio", e);
      }
      
      stream = mergeAudioStreams(micStream, systemStream);
      
      if (!active.current) {
        micStream.getTracks().forEach((t) => t.stop());
        systemStream?.getTracks().forEach((t) => t.stop());
        return;
      }
      
      liveTranscriber.current = new LiveTranscriber((newTranscript) => {
        if (active.current) {
          setDraft(prev => {
            const next = { ...prev, report: { ...prev.report, transcription: newTranscript } };
            current.current = next;
            return next;
          });
        }
      });
      const mime = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ].find((t) => MediaRecorder.isTypeSupported(t));
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream, {
          ...(mime ? { mimeType: mime } : {}),
          audioBitsPerSecond: 64000,
        });
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        throw e;
      }
      recorder.current = rec;
      chunks.current = [];
      chunkSequence.current = 0;
      clock.current.reset();
      await persist({
        ...current.current,
        report: { ...current.current.report, captureState: "recording" },
      });
      if (!active.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      void navigator.storage?.persist?.().catch(() => {});
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
        liveTranscriber.current?.addChunk(e.data);
        if (audio.size > MAX_FILE_BYTES - 512000 && rec.state !== "inactive") {
          if (active.current)
            setWarning(
              "Die maximale Aufnahmegröße ist erreicht. Die Aufnahme wurde beendet.",
            );
          stop();
        }
      };
      rec.onerror = () => {
        if (active.current)
          setError(
            "Die Aufnahme wurde unterbrochen. Prüfe die bisher gespeicherte Aufnahme.",
          );
        if (rec.state !== "inactive") stop();
        else {
          clock.current.pause();
          stream?.getTracks().forEach((t) => t.stop());
          if (active.current) setState("review");
        }
      };
      rec.onstop = () => {
        const finalDuration = clock.current.pause();
        stream?.getTracks().forEach((t) => t.stop());
        if (systemStream) systemStream.getTracks().forEach((t) => t.stop());
        if (micStream) micStream.getTracks().forEach((t) => t.stop());
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
      rec.start(10000); // 30 second chunks for live transcription
      clock.current.resume();
      setState("recording");
      setDuration(0);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
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
      setState("paused");
      setDuration(time);
      void persist({
        ...current.current,
        report: { ...current.current.report, captureState: "paused" },
      }).catch(() => {});
    } else if (rec.state === "paused") {
      if (
        rec.stream
          .getAudioTracks()
          .some((track) => track.muted || track.readyState === "ended")
      ) {
        setWarning(
          "Das Mikrofon ist noch nicht verfügbar. Die Aufnahme bleibt pausiert.",
        );
        return;
      }
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
  function stop() {
    const rec = recorder.current;
    if (!rec || rec.state === "inactive") return;
    const time = clock.current.pause();
    if (active.current) setDuration(time);
    rec.stop();
  }
    async function importAudio(file?: File) {
    if (!file || operation.current) return;
    setError("");
    if (
      file.size > MAX_FILE_BYTES ||
      !file.size ||
      ![
        "audio/webm",
        "audio/mp4",
        "audio/mpeg",
        "audio/wav",
        "audio/x-wav",
        "audio/ogg",
        "audio/aac",
        "audio/flac",
      ].includes(file.type)
    ) {
      setError(
        "Bitte eine Audiodatei bis 25 MB wählen (WebM, M4A, MP3, WAV, Ogg, AAC oder FLAC).",
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
    setBusy("Speichern vorbereiten …");
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
      setBusy("Entwurf lokal sichern …");
      await queue.current.catch(() => {});
      if (!active.current) return;
      let d = current.current;
      d.report.title ||= `Meeting vom ${new Date(d.report.date).toLocaleDateString("de-AT")}`;
      await persist(d);
      if (!active.current || uid() !== accountId) return;
      const cloudWarning = await saveReport(d.report);
      if (cloudWarning) setWarning(cloudWarning);
      if (!active.current || uid() !== accountId) return;
      await backupDraft(d, token, setBusy);
      await persist({ ...d });
      if (!active.current) return;
      if (analyze) {
        setBusy(
          "Dein Meeting analysieren …",
        );
        try {
          const result = await analyzeDraft(d);
          d = { ...d, report: result };
          await persist(d);
        } catch (e) {
          d = {
            ...d,
            report: { ...d.report, status: "error", error: errorMessage(e) },
          };
          await persist(d);
          if (!active.current || uid() !== accountId) throw e;
          await saveReport(d.report);
          try {
            if (!active.current || uid() !== accountId) throw e;
            await syncReport(d.report, token);
          } catch {
            /* primary analysis error remains visible */
          }
          throw e;
        }
      }
      if (!active.current) return;
      setBusy("Bericht in Google Drive speichern …");
      const result = await syncReport(d.report, token);
      await persist({ ...d, report: result.report });
      if (result.warning) setWarning(result.warning);
      await deleteDraft(accountId, result.report.id);
      current.current = fresh();
      if (active.current) navigate(`/report/${result.report.id}`);
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
        ) : busy ? (
          <main className="walk-progress" aria-live="polite" aria-busy="true">
            <div className="walk-progress-icon">
              <Loader2 className="spin" size={32} />
            </div>
            <span className="walk-step">BITTE DIESE SEITE GEÖFFNET LASSEN</span>
            <h1>{busy}</h1>
            <p>Du kommst direkt zum Bericht, sobald er bereit ist.</p>
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
                <>
                  <div className="walk-project-name">
                    {draft.report.title || "Deine Meeting"}
                  </div>
                  <div
                    className={`walk-live ${state === "paused" ? "is-paused" : ""}`}
                  >
                    <span className="walk-live-status">
                      <i />
                      {state === "paused"
                        ? "Aufnahme pausiert"
                        : "Aufnahme läuft"}
                    </span>
                    <div className="walk-timer" aria-label="Aufnahmedauer">
                      {formatTime(duration)}
                    </div>
                    <div className="walk-wave" aria-hidden="true">
                      {Array.from({ length: 29 }, (_, i) => (
                        <i
                          key={i}
                          style={{
                            height: `${8 + ((i * 17 + 9) % 34)}px`,
                            animationDelay: `${i * 0.04}s`,
                          }}
                        />
                      ))}
                    </div>
                    {draft.report.transcription ? (
                      <div className="walk-live-transcript" style={{ marginTop: 12, padding: "12px 16px", background: "#ffffff", borderRadius: 12, border: "1px solid #bfdbfe", maxHeight: "120px", overflowY: "auto", fontSize: 13, color: "#1e3a8a", textAlign: "left", lineHeight: 1.5 }}>
                        {draft.report.transcription}
                      </div>
                    ) : (
                      <p>
                        {state === "paused"
                          ? "Durchatmen. Weiter, wenn du bereit bist."
                          : "Die Transkription läuft automatisch mit."}
                      </p>
                    )}
                  </div>
                  </>
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
                  <button className="walk-primary" onClick={() => void start()}>
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
                    disabled={!online || !driveReady || !draft.audio?.size}
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
