import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  Volume2,
  MonitorUp,
} from "lucide-react";
import { AudioPreview } from "../components/UI";
import LiveMeeting from "../components/LiveMeeting";
import RecordingSheet from "../components/RecordingSheet";
import { savedDriveFolder } from "../lib/driveSettings";
import {
  audioSourcePreference,
  setAudioSourcePreference,
  type AudioSourcePreference,
} from "../lib/audioSources";
import "./record.css";
import { putLocal } from "../lib/local";
import { uid } from "../lib/reports";
import { verifyDriveAccess } from "../lib/drive";
import {
  errorMessage,
  connectGoogle,
  driveToken,
  ensureDriveToken,
} from "../lib/session";
import { startProcessing } from "../lib/pipeline";
import { audioExtension } from "../../shared/analysis";
import MeetingLanguages from "../components/MeetingLanguages";
import DriveSettings from "../components/DriveSettings";
import {
  captureQueue,
  captureSnapshot,
  discardCapture,
  finishTranscription,
  importAudio,
  openDraft,
  pauseCapture,
  releaseAfterHandoff,
  setCaptureBusy,
  setCaptureError,
  setCaptureTitle,
  setCaptureLanguages,
  setCaptureSingleSpeaker,
  startCapture,
  stopCapture,
  subscribeCapture,
} from "../lib/capture";

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
  // The session lives outside this component so that leaving the screen does
  // not end the meeting.
  const snap = useSyncExternalStore(subscribeCapture, captureSnapshot);
  const {
    draft,
    state,
    durationMs,
    checkpointMs,
    transcribing,
    saved,
    busy,
    error,
    warning,
    localStartOffered,
    wakeLock,
    failed,
  } = snap;

  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<
    "settings" | "options" | "leave" | "sources" | "share-explainer" | null
  >(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [folder, setFolder] = useState(savedDriveFolder);
  const systemAudioAvailable = typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const [audioSources, setAudioSources] = useState<AudioSourcePreference>(() =>
    systemAudioAvailable ? audioSourcePreference() : "mic",
  );
  const [, refreshDriveSession] = useState(0);
  const operation = useRef(false);
  const pendingLocalOnly = useRef(false);
  const audioInput = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const recording = state === "recording" || state === "paused";
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

  useEffect(() => {
    let cancelled = false;
    openDraft(accountId, requestedDraft || undefined, startNew)
      .then((id) => {
        if (!cancelled) navigate(`/record?draft=${id}`, { replace: true });
      })
      .catch((e) => !cancelled && setCaptureError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [accountId, requestedDraft, startNew, navigate]);

  async function authorizeDrive() {
    if (operation.current) return;
    operation.current = true;
    setCaptureError("");
    setCaptureBusy("Google Drive freigeben …");
    try {
      await verifyDriveAccess(await connectGoogle());
    } catch (e) {
      setCaptureError(errorMessage(e));
    } finally {
      operation.current = false;
      setCaptureBusy("");
      refreshDriveSession((n) => n + 1);
    }
  }

  // `sources` is always explicit, never read from the component's own state,
  // because the explainer sheet below sometimes changes that state and starts
  // a recording in the same click -- reading `audioSources` there would race
  // against React's async state update and could still request a screen share
  // the user just declined.
  async function begin(
    localOnly: boolean,
    sources: AudioSourcePreference,
    sharingExplained = false,
  ) {
    // The explainer's confirmation click must reach getDisplayMedia without
    // an intervening await (native browser activation requirement).
    if (sharingExplained && sources === "mic+system") {
      await startCapture(localOnly, async () => {
        const token = await ensureDriveToken();
        if (!token) throw new Error("Bitte zuerst Google Drive freigeben.");
        await verifyDriveAccess(token);
      }, sources);
      return;
    }
    try {
      // Signed in should already mean authorized; only prompt if that fails.
      if (!localOnly && navigator.onLine && !(await ensureDriveToken())) {
        await authorizeDrive();
        return;
      }
    } catch (e) {
      // This runs from `void begin()`, so a rejection would vanish silently.
      setCaptureError(errorMessage(e));
      return;
    }
    // A cached Drive token can expire and then renew without a popup. Decide
    // after renewal so this path still explains sharing before requesting it.
    if (sources === "mic+system" && systemAudioAvailable && !sharingExplained) {
      pendingLocalOnly.current = localOnly;
      setSheet("share-explainer");
      return;
    }
    await startCapture(
      localOnly,
      async () => {
        const token = await ensureDriveToken();
        if (!token) throw new Error("Bitte zuerst Google Drive freigeben.");
        await verifyDriveAccess(token);
      },
      sources,
    );
  }

  function startRecording(localOnly = false) {
    void begin(localOnly, audioSources);
  }

  function chooseAudioSources(value: AudioSourcePreference) {
    setAudioSources(value);
    setAudioSourcePreference(value);
    setSheet(null);
  }

  async function process(analyze: boolean) {
    if (!draft.audio || operation.current) return;
    operation.current = true;
    setCaptureError("");
    setCaptureBusy("Transkription abschließen …");
    try {
      // Renewing is a server call, never a popup.
      const token = await ensureDriveToken();
      if (!token) {
        refreshDriveSession((n) => n + 1);
        throw new Error(
          "Die Drive-Freigabe ist abgelaufen. Bitte zuerst Google Drive verbinden. Dein Entwurf bleibt erhalten.",
        );
      }
      if (uid() !== accountId) return;
      await finishTranscription().catch(() => {});
      if (uid() !== accountId) return;

      setCaptureBusy("Entwurf lokal sichern …");
      await captureQueue().catch(() => {});
      if (uid() !== accountId) return;
      const d = captureSnapshot().draft;
      d.report.title ||= `Meeting vom ${new Date(d.report.date).toLocaleDateString("de-AT")}`;
      d.report.status = analyze ? "analyzing" : d.report.status;
      // The report must be readable before its page opens; the rest of the
      // pipeline continues in the background.
      await putLocal(accountId, d.report);
      if (uid() !== accountId) return;

      void startProcessing({ owner: accountId, draft: d, token, analyze });
      releaseAfterHandoff();
      navigate(`/report/${d.report.id}`);
    } catch (e) {
      setCaptureError(errorMessage(e));
    } finally {
      operation.current = false;
      setCaptureBusy("");
    }
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
    if (busy) return;
    // A running meeting keeps going: the session lives outside this screen and
    // stays reachable from the recording bar.
    if (recording || !draft.audio) navigate("/dashboard");
    else setSheet("leave");
  }

  return (
    <div className={`walk-page walk-${state}`}>
      <div className="walk-frame" inert={sheet !== null}>
        <header className="walk-header">
          <button
            className="walk-icon"
            aria-label="Zur Übersicht"
            disabled={!!busy || loading}
            onClick={leave}
          >
            <ArrowLeft size={21} />
          </button>
          <div>
            <span className="walk-step">
              {recording
                ? "LÄUFT IM HINTERGRUND WEITER"
                : state === "review"
                  ? "SCHRITT 2 VON 2"
                  : "SCHRITT 1 VON 2"}
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
            disabled={!!busy || loading}
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
            <main className={`walk-content${state === "ready" ? " is-ready" : ""}`}>
              {state === "ready" ? (
                <>
                  <label className="walk-project">
                    <span>PROJEKT / MEETING</span>
                    <input
                      id="title"
                      placeholder="z. B. Weekly Sync · Q3 Planning"
                      value={draft.report.title}
                      onChange={(e) => setCaptureTitle(e.target.value)}
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
                      Sprich und diskutiere frei, CheatMeet protokolliert im
                      Hintergrund.
                    </p>
                  </div>
                  <div className="walk-settings-row">
                    <button
                      className="walk-folder"
                      onClick={() => setSheet("settings")}
                    >
                      <FolderOpen size={18} />
                      <span>
                        <small>SPEICHERORT</small>
                        <strong>{folder?.name || "CheatMeet Recordings"}</strong>
                      </span>
                    </button>
                    <button
                      className="walk-folder"
                      aria-haspopup="dialog"
                      onClick={() => setSheet("sources")}
                    >
                      {audioSources === "mic" ? (
                        <Mic size={18} />
                      ) : (
                        <MonitorUp size={18} />
                      )}
                      <span>
                        <small>AUDIOQUELLEN</small>
                        <strong>
                          {audioSources === "mic"
                            ? "Nur Mikrofon"
                            : "Mikrofon + System"}
                        </strong>
                      </span>
                    </button>
                  </div>
                  <MeetingLanguages value={draft.report.speech?.languages} onChange={setCaptureLanguages} />
                  <fieldset className="walk-speaker-assumptions">
                    <legend>Personen pro Audioquelle</legend>
                    <label>
                      <input type="checkbox" checked={!!draft.report.singleSpeakerSources?.mic}
                        onChange={event => setCaptureSingleSpeaker("mic", event.target.checked)} />
                      Nur eine Person am Mikrofon
                    </label>
                    {audioSources === "mic+system" && <label>
                      <input type="checkbox" checked={!!draft.report.singleSpeakerSources?.system}
                        onChange={event => setCaptureSingleSpeaker("system", event.target.checked)} />
                      Nur eine Person im Systemaudio
                    </label>}
                    <p>Für dieses Meeting: Alle Beiträge der gewählten Quelle gehören zu einer Person, auch nach einer Pause. Namen kannst du direkt im Transkript ändern. Ohne Häkchen werden Stimmen automatisch unterschieden.</p>
                  </fieldset>
                </>
              ) : recording ? (
                <LiveMeeting
                  transcript={draft.report.transcription}
                  speech={draft.report.speech}
                  pending={transcribing}
                  paused={state === "paused"}
                  timer={formatTime(durationMs)}
                  startedAt={draft.report.date}
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
                      {draft.report.transcriptionOrigin === "import"
                        ? "Audio sichern, einmal transkribieren und zusammenfassen."
                        : "Audio sichern und das Live-Transkript zusammenfassen. Deine Namen und Audioquellen bleiben erhalten."}
                    </p>
                  </div>
                  {draft.report.transcriptionOrigin === "import" && draft.report.speech?.phase !== "final" && <MeetingLanguages value={draft.report.speech?.languages} onChange={setCaptureLanguages} />}
                  <div className="walk-review-media">
                    <div className="walk-review-stats">
                      <span>
                        <Mic size={18} />
                        {formatTime(durationMs)} Aufnahme
                      </span>
                    </div>
                    {draft.audio && (
                      <AudioPreview blob={draft.audio} durationMs={durationMs} />
                    )}
                    {failed > 0 && (
                      <p className="walk-gap">
                        Das Live-Transkript kann Lücken enthalten. Es wird ohne
                        erneute Transkription verwendet. Die Originalaufnahme wird gesichert.
                      </p>
                    )}
                  </div>
                  <button
                    className="walk-folder"
                    onClick={() => setSheet("settings")}
                  >
                    <FolderOpen size={18} />
                    <span>
                      <small>SPEICHERORT IN GOOGLE DRIVE</small>
                      <strong>{folder?.name || "CheatMeet Recordings"}</strong>
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
                      onClick={pauseCapture}
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
                    <button className="walk-finish" onClick={stopCapture}>
                      <span>
                        <strong>Meeting abschließen</strong>
                        <small>Weiter zum Sichern &amp; Zusammenfassen</small>
                      </span>
                      <ArrowRight size={22} />
                    </button>
                  </div>
                </>
              ) : state === "ready" ? (
                <>
                  <button
                    className="walk-primary"
                    disabled={!!busy}
                    onClick={() => startRecording()}
                  >
                    <Mic size={22} />
                    {online && !driveReady
                      ? "Google Drive freigeben"
                      : "Aufnahme starten"}
                  </button>
                  {localStartOffered && (
                    <button
                      className="walk-secondary"
                      onClick={() => startRecording(true)}
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
                    Sichern &amp; Zusammenfassen
                    <ArrowRight size={18} />
                  </button>
                  <p className="walk-save-hint">
                    {!online
                      ? "Sobald du online bist, kannst du hier fortfahren."
                      : !driveReady
                        ? "Drive-Freigabe fehlt oder ist abgelaufen. Dein Entwurf bleibt lokal gesichert."
                        : "Audio sichern → Zusammenfassung"}
                  </p>
                </>
              )}
              {recording && (
                <p className="walk-lock-status">
                  {wakeLock === "active"
                    ? "Bildschirm bleibt wach · du kannst zur Übersicht wechseln"
                    : "Aufnahme läuft weiter, auch wenn du die Seite wechselst"}
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
                ) : (
                  "Bereit"
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
          const file = e.target.files?.[0];
          if (file)
            void importAudio(file).then(id => {
              if (id) navigate(`/record?draft=${id}`, { replace: true });
            }).catch((err) => setCaptureError(errorMessage(err)));
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
                : sheet === "sources"
                  ? "Audioquellen"
                  : sheet === "share-explainer"
                    ? "Gleich fragt der Browser"
                    : "Weitere Optionen"
          }
          onClose={() => setSheet(null)}
        >
          {sheet === "settings" ? (
            <DriveSettings />
          ) : sheet === "sources" ? (
            <div className="walk-sources" role="group" aria-label="Audioquelle auswählen">
              <button
                className={`walk-source-option${audioSources === "mic+system" ? " is-selected" : ""}`}
                aria-pressed={audioSources === "mic+system"}
                disabled={!systemAudioAvailable}
                onClick={() => chooseAudioSources("mic+system")}
              >
                <MonitorUp size={19} />
                <span>
                  <strong>Mikrofon + Systemaudio</strong>
                  <small>
                    {systemAudioAvailable
                      ? "Für Video-Calls: dein Mikrofon und der Ton des geteilten Tabs oder Bildschirms, sofern dein Browser ihn unterstützt."
                      : "Bildschirmfreigabe ist in diesem Browser nicht verfügbar. Du kannst mit dem Mikrofon aufnehmen."}
                  </small>
                </span>
                {audioSources === "mic+system" && <Check size={18} />}
              </button>
              <button
                className={`walk-source-option${audioSources === "mic" ? " is-selected" : ""}`}
                aria-pressed={audioSources === "mic"}
                onClick={() => chooseAudioSources("mic")}
              >
                <Mic size={19} />
                <span>
                  <strong>Nur Mikrofon</strong>
                  <small>
                    Für Gespräche ohne Bildschirmfreigabe. Kein
                    Freigabe-Dialog beim Start.
                  </small>
                </span>
                {audioSources === "mic" && <Check size={18} />}
              </button>
            </div>
          ) : sheet === "share-explainer" ? (
            <div className="walk-explainer">
              <p>
                Der Browser fragt jetzt, welchen Tab oder Bildschirm du
                teilst.
              </p>
              <ul>
                <li>
                  Wähle den Tab oder Bildschirm, dessen Ton mit aufgenommen
                  werden soll.
                </li>
                <li className="walk-explainer-critical">
                  <Volume2 size={15} />
                  <span>
                    <strong>Aktiviere „Audio teilen“, wenn angeboten.</strong>{" "}
                    Ohne freigegebenen Ton nimmt CheatMeet nur dein Mikrofon auf.
                  </span>
                </li>
              </ul>
              <button
                className="walk-primary"
                onClick={() => {
                  setSheet(null);
                  void begin(pendingLocalOnly.current, "mic+system", true);
                }}
              >
                Verstanden, weiter
              </button>
              <button
                className="walk-secondary"
                onClick={() => {
                  chooseAudioSources("mic");
                  void begin(pendingLocalOnly.current, "mic");
                }}
              >
                Doch nur Mikrofon verwenden
              </button>
            </div>
          ) : sheet === "leave" ? (
            <div className="walk-leave">
              <p>
                Audio bleibt als lokaler Entwurf auf diesem Gerät. Der
                Drive-Upload und die Analyse stehen noch aus.
              </p>
              <button
                className="walk-primary"
                onClick={() => {
                  setSheet(null);
                  saveButton.current?.focus();
                }}
              >
                Zurück zum Sichern &amp; Analysieren
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
                disabled={recording}
                onClick={() => {
                  void discardCapture()
                    .then((id) => {
                      setSheet(null);
                      navigate(`/record?draft=${id}`, { replace: true });
                    })
                    .catch((e) => setCaptureError(errorMessage(e)));
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
