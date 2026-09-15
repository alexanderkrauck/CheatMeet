import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
  Languages,
  Loader2,
  Trash2,
  Upload,
  WandSparkles,
  CloudUpload,
  Volume2,
  MonitorUp,
  Settings2,
} from "lucide-react";
import { AudioPreview } from "../components/UI";
import LiveMeeting from "../components/LiveMeeting";
import RecordingSheet from "../components/RecordingSheet";
import { savedDriveFolder } from "../lib/driveSettings";
import { ArmedMeeting } from "../components/ArmedMeeting";
import { draftConsentNotice } from "../lib/consentDraft";
import { savedRetention } from "../lib/meetingDefaults";
import {
  assembleConsentText,
  decisionFacts,
  type ConsentDecision,
  type ConsentParts,
} from "../../shared/consent";
import {
  audioSourcePreference,
  setAudioSourcePreference,
  type AudioSourcePreference,
} from "../lib/audioSources";
import "./record.css";
import { putLocal } from "../lib/local";
import { uid } from "../lib/reports";
import { DEFAULT_FOLDER_NAME, verifyDriveAccess } from "../lib/drive";
import PeopleDatalist from "../components/PeopleDatalist";
import CalendarMatch from "../components/CalendarMatch";
import { getEvent } from "../lib/calendar";
import {
  errorMessage,
  connectGoogle,
  driveToken,
  ensureDriveToken,
} from "../lib/session";
import { startProcessing } from "../lib/pipeline";
import { audioExtension } from "../../shared/analysis";
import MeetingLanguages, { languageLabel } from "../components/MeetingLanguages";
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
  isCapturing,
  setCaptureEvent,
  setCaptureLanguages,
  setCaptureSingleSpeaker,
  armCapture,
  beginRecording,
  disarmCapture,
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
  // Arriving from an upcoming meeting: the recording is tied to that event
  // before a single second is captured.
  const requestedEvent = useRef(searchParams.get("event")).current;
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
    sources: liveSources,
  } = snap;

  // What the user decides before consenting. The notice is derived from it, so
  // the text on screen and the text in the record are the same function.
  // The folder is not a decision made here: it comes from settings and is
  // read at render time, so it cannot go stale while the notice is on screen.
  const [decision, setDecision] = useState<Omit<ConsentDecision, "folderName">>(() => ({
    method: "spoken",
    allInformed: false,
    language: "de",
    address: "du",
    retention: savedRetention(),
  }));
  const [consentParts, setConsentParts] = useState<ConsentParts | null>(null);
  const [consentChat, setConsentChat] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const draftRequest = useRef(0);

  // Armed is page-local: it holds open devices and nothing else, and no other
  // surface can stop them — the recording bar deliberately ignores armed.
  useEffect(
    () => () => {
      if (captureSnapshot().state === "armed") disarmCapture();
    },
    [],
  );

  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<
    | "settings"
    | "options"
    | "leave"
    | "sources"
    | "languages"
    | "share-explainer"
    | null
  >(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [folder, setFolder] = useState(savedDriveFolder);
  const systemAudioAvailable = typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const [audioSources, setAudioSources] = useState<AudioSourcePreference>(() =>
    systemAudioAvailable ? audioSourcePreference() : "mic",
  );
  // The pill shows its value, including the speaker assumption that moved into
  // its sheet — a setting you cannot see is a setting you forget you set.
  const solo = draft.report.singleSpeakerSources;
  const sourceSummary =
    (audioSources === "mic" ? "Nur Mikrofon" : "Mikrofon + System") +
    (solo?.mic && solo?.system && audioSources === "mic+system"
      ? " · je 1 Person"
      : solo?.mic
        ? " · 1 Person am Mikro"
        : solo?.system && audioSources === "mic+system"
          ? " · 1 Person im System"
          : "");
  const [, refreshDriveSession] = useState(0);
  const operation = useRef(false);
  const pendingLocalOnly = useRef(false);
  const audioInput = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const recording = state === "recording" || state === "paused";
  const armed = state === "armed";
  // The readiness label must never be stricter than the gate the action
  // itself applies: a 10-minute preflight against ensureDriveToken's 5-minute
  // renewal margin made the button read "Google Drive freigeben" and then
  // start recording instead.
  const driveReady = !!driveToken();

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
      .then(async (id) => {
        if (cancelled) return;
        // Only for a session this navigation actually started: arriving here
        // while another meeting is recording must leave that one alone.
        if (requestedEvent && !isCapturing()) {
          // A failed lookup must not block the recording; the picker on this
          // screen is still there to link it by hand.
          const event = await getEvent("primary", requestedEvent).catch(() => null);
          if (!cancelled && event && !isCapturing()) setCaptureEvent(event);
        }
        if (!cancelled) navigate(`/record?draft=${id}`, { replace: true });
      })
      .catch((e) => !cancelled && setCaptureError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [accountId, requestedDraft, startNew, requestedEvent, navigate]);

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

  // The notice on screen and the notice in the record come from the same pure
  // functions over the same inputs, so they cannot disagree.
  // Read at render time, not frozen at mount: the storage folder can be
  // changed from this very screen, and the notice names where files go.
  const decisionNow: ConsentDecision = {
    ...decision,
    folderName: folder?.name || DEFAULT_FOLDER_NAME,
  };
  const consentFactsNow = decisionFacts(
    decisionNow,
    liveSources.length ? liveSources : ["mic"],
  );
  const consentText = assembleConsentText(consentFactsNow, consentParts);

  async function refineNotice(instruction: string) {
    const request = ++draftRequest.current;
    setConsentChat((lines) => [...lines, instruction]);
    setDrafting(true);
    setDraftError("");
    try {
      const parts = await draftConsentNotice(consentFactsNow, [
        ...consentChat,
        instruction,
      ]);
      if (request === draftRequest.current) setConsentParts(parts);
    } catch (e) {
      if (request === draftRequest.current) setDraftError(errorMessage(e));
    } finally {
      if (request === draftRequest.current) setDrafting(false);
    }
  }

  function resetNotice() {
    draftRequest.current++;
    setConsentParts(null);
    setConsentChat([]);
    setDraftError("");
    setDrafting(false);
  }

  function consentGiven() {
    void beginRecording({ ...decisionNow, parts: consentParts }).catch((e) =>
      setCaptureError(errorMessage(e)),
    );
  }

  function cancelArmed() {
    disarmCapture();
    resetNotice();
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
      await armCapture(localOnly, async () => {
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
    await armCapture(
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
    // Armed holds an open microphone and screen share with no bar to stop them
    // from anywhere else, and nothing has been recorded — so leaving releases.
    if (armed) disarmCapture();
    // A running meeting keeps going: the session lives outside this screen and
    // stays reachable from the recording bar.
    if (recording || !draft.audio) navigate("/dashboard");
    else setSheet("leave");
  }

  return (
    <div className={`walk-page walk-${state}`}>
      <PeopleDatalist />
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
                : armed
                  ? "NOCH WIRD NICHTS AUFGENOMMEN"
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
                  {/* One object, not two labelled rows: picking the event
                      fills the title, so they are the same thing. Neither
                      eyebrow survives — the placeholder names the field, and
                      the marketing hero that used to sit under them is what
                      pushed the actual controls below the fold. */}
                  <div className="walk-meeting-card">
                    <CalendarMatch
                      atMs={Date.parse(draft.report.date) || Date.now()}
                      selectedId={draft.report.calendarEventId}
                      onPick={(event) => setCaptureEvent(event)}
                    />
                    <label className="walk-project">
                      <input
                        id="title"
                        placeholder="Titel des Meetings"
                        value={draft.report.title}
                        onChange={(e) => setCaptureTitle(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="walk-settings-row">
                    <button
                      className="walk-folder"
                      onClick={() => setSheet("settings")}
                    >
                      <FolderOpen size={18} />
                      <span>
                        <small>SPEICHERORT</small>
                        <strong>{folder?.name || DEFAULT_FOLDER_NAME}</strong>
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
                        <strong>{sourceSummary}</strong>
                      </span>
                    </button>
                    <button
                      className="walk-folder"
                      aria-haspopup="dialog"
                      onClick={() => setSheet("languages")}
                    >
                      <Languages size={18} />
                      <span>
                        <small>SPRACHEN</small>
                        <strong>
                          {languageLabel(draft.report.speech?.languages)}
                        </strong>
                      </span>
                    </button>
                  </div>
                </>
              ) : armed ? (
                <ArmedMeeting
                  sources={liveSources}
                  text={consentText}
                  decision={decisionNow}
                  onDecision={(patch) =>
                    setDecision((current) => ({ ...current, ...patch }))
                  }
                  onDraft={(instruction) => void refineNotice(instruction)}
                  onResetDraft={resetNotice}
                  drafting={drafting}
                  draftError={draftError}
                  chat={consentChat}
                  hasDraft={!!consentParts}
                />
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
                  {/* The link can still be made after the fact: before this the
                      picker existed only on the pre-recording screen, so a
                      recording started without one could never be attached. */}
                  <CalendarMatch
                    atMs={Date.parse(draft.report.date) || Date.now()}
                    selectedId={draft.report.calendarEventId}
                    label="TERMIN"
                    onPick={(event) => setCaptureEvent(event)}
                  />
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
                      <strong>{folder?.name || DEFAULT_FOLDER_NAME}</strong>
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
              ) : armed ? (
                <>
                  <button
                    className="walk-primary"
                    disabled={!!busy || !decision.allInformed}
                    onClick={consentGiven}
                  >
                    <Mic size={22} />
                    Einwilligung erteilt · Aufnahme starten
                  </button>
                  <button className="walk-secondary" onClick={cancelArmed}>
                    Abbrechen
                  </button>
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
                      : "Aufnahme vorbereiten"}
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
                  : sheet === "languages"
                    ? "Sprachen"
                  : sheet === "share-explainer"
                    ? "Gleich fragt der Browser"
                    : "Weitere Optionen"
          }
          onClose={() => setSheet(null)}
        >
          {sheet === "settings" ? (
            <div className="sheet-stack">
              <DriveSettings />
              {/* Leaving mid-capture would abandon the recording, and the
                  settings page can sign you out. Offer the exit only when
                  there is nothing running to lose. */}
              {state === "recording" || state === "paused" ? (
                <p className="muted small">
                  Weitere Einstellungen nach dem Ende der Aufnahme.
                </p>
              ) : (
                <Link className="btn" to="/settings">
                  <Settings2 size={16} /> Alle Einstellungen
                </Link>
              )}
            </div>
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
              {/* Who is on each source is a property of the sources, so it
                  lives with them rather than as a fieldset in the main flow. */}
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
            </div>
          ) : sheet === "languages" ? (
            <MeetingLanguages
              value={draft.report.speech?.languages}
              onChange={setCaptureLanguages}
              bare
            />
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
                  if (armed) resetNotice();
                  void discardCapture()
                    .then(() => {
                      setSheet(null);
                      // Discarding means leaving. Navigating to the fresh blank
                      // draft discardCapture returns kept the user standing on
                      // the recorder, looking at the take they just threw away.
                      navigate("/dashboard", { replace: true });
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
