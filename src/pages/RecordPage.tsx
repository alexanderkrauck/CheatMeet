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
  Languages,
  Loader2,
  Trash2,
  Upload,
  WandSparkles,
  CloudUpload,
  Volume2,
  MonitorUp,
} from "lucide-react";
import MeetingAudioPlayer from "../components/MeetingAudioPlayer";
import LiveMeeting from "../components/LiveMeeting";
import RecordingSheet from "../components/RecordingSheet";
import { savedDriveFolder } from "../lib/driveSettings";
import { ArmedMeeting } from "../components/ArmedMeeting";
import { draftConsentNotice } from "../lib/consentDraft";
import { consentStepEnabled, savedRetention } from "../lib/meetingDefaults";
import {
  assembleConsentText,
  acceptConsentParts,
  decisionFacts,
  everyoneAgreed,
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
import { auth } from "../lib/firebase";
import { DEFAULT_FOLDER_NAME, verifyDriveAccess } from "../lib/drive";
import PeopleDatalist from "../components/PeopleDatalist";
import CalendarMatch from "../components/CalendarMatch";
import { getEvent, type CalendarEvent, type CalendarSelection } from "../lib/calendar";
import {
  errorMessage,
  connectGoogle,
  driveToken,
  ensureDriveToken,
} from "../lib/session";
import { startProcessing } from "../lib/pipeline";
import { audioExtension } from "../../shared/analysis";
import MeetingLanguages, {
  languageLabel,
} from "../components/MeetingLanguages";
import MicrosoftSettings from "../components/MicrosoftSettings";
import { savedMeetingHome, loadMeetingHome } from "../lib/providerSettings";
import {
  cachedMicrosoftConnections,
  ensureMicrosoftToken,
  connectMicrosoft,
} from "../lib/microsoft";
import { getOneDriveItem } from "../lib/onedrive";
import { liveStatus, shareNotice } from "../lib/liveStatus";
import {
  captureQueue,
  captureSnapshot,
  discardCapture,
  finishTranscription,
  importAudio,
  openDraft,
  pauseCapture,
  restartLive,
  releaseAfterHandoff,
  setCaptureBusy,
  setCaptureError,
  setCaptureTitle,
  setCaptureHome,
  isCapturing,
  setCaptureEvent,
  setCaptureLanguages,
  setCaptureRetranscribe,
  setCaptureProcessing,
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
  const requestedBinding = useRef<CalendarSelection>({
    provider: searchParams.get("provider") === "microsoft" ? "microsoft" : "google",
    connectionId: searchParams.get("connection") || undefined,
    calendarId: searchParams.get("calendar") || "primary",
  }).current;
  const [eventUnresolved, setEventUnresolved] = useState(!!requestedEvent);
  const unresolvedEvent = useRef(!!requestedEvent);
  const [eventError, setEventError] = useState("");
  const [eventLoading, setEventLoading] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent>();
  const eventAttempt = useRef(0);
  const eventDraft = useRef("");
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
    liveConnection,
    liveShare,
    localStartOffered,
    wakeLock,
    failed,
    sources: liveSources,
  } = snap;

  // What the user decides before consenting. The notice is derived from it, so
  // the text on screen and the text in the record are the same function.
  // The folder is not a decision made here: it comes from settings and is
  // read at render time, so it cannot go stale while the notice is on screen.
  const [decision, setDecision] = useState<Omit<ConsentDecision, "folderName">>(
    () => ({
      method: "spoken",
      participants: [],
      language: "de",
      address: "du",
      retention: savedRetention(),
    }),
  );
  // Who the calendar says is in this meeting. The consent roster starts from
  // this, so the normal case costs no typing at all.
  const [invited, setInvited] = useState<string[]>([]);
  const [consentParts, setConsentParts] = useState<ConsentParts | null>(null);
  const partsFactsKey = useRef("");
  const [approvalFactsKey, setApprovalFactsKey] = useState("");
  const [consentChat, setConsentChat] = useState<string[]>([]);
  const [showConsent, setShowConsent] = useState(consentStepEnabled);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const draftRequest = useRef(0);
  const pageActive = useRef(true);
  const preparationRequest = useRef(0);
  const preparingReport = useRef<string | null>(null);

  // Preparation (including pending permissions) is page-local. Only an already
  // recording/paused session survives navigation through the global bar.
  useEffect(() => {
    pageActive.current = true;
    return () => {
      pageActive.current = false;
      preparationRequest.current++;
      const current = captureSnapshot();
      if (current.owner === accountId && (current.state === "armed" ||
          (current.state === "ready" && preparingReport.current === current.draft.report.id)))
        disarmCapture(); // Invalidates captureAttempt and stops late device results.
      preparingReport.current = null;
    };
  }, []);

  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<
    | "settings"
    | "options"
    | "leave"
    | "discard"
    | "sources"
    | "languages"
    | "share-explainer"
    | null
  >(null);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState("");
  const discardTarget = useRef<{ id: string; title: string } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [folder, setFolder] = useState(savedDriveFolder);
  const [selectedHome, setSelectedHome] = useState(savedMeetingHome);
  const [homeReady, setHomeReady] = useState(false);
  const homeOverride = useRef(false);
  const meetingHome = state === "ready" ? selectedHome : draft.report.home;
  const storageName = meetingHome ? "OneDrive" : "Google Drive";
  useEffect(() => {
    let live = true;
    void loadMeetingHome()
      .then((home) => {
        if (live && !homeOverride.current) {
          setSelectedHome(home);
          setHomeReady(true);
        }
      })
      .catch(() => {
        if (live && !homeOverride.current)
          setCaptureError(
            "Der Standard-Speicherort konnte nicht geladen werden. Bitte unter Speicherort ausdrücklich Google Drive oder einen OneDrive-Ordner wählen. Es wird nicht automatisch gewechselt.",
          );
      });
    return () => {
      live = false;
    };
  }, []);
  const systemAudioAvailable =
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
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
  const ownsSession = () => auth.currentUser?.uid === accountId && captureSnapshot().owner === accountId;
  const armed = state === "armed";
  // The readiness label must never be stricter than the gate the action
  // itself applies: a 10-minute preflight against ensureDriveToken's 5-minute
  // renewal margin made the button read "Google Drive freigeben" and then
  // start recording instead.
  const driveReady = meetingHome
    ? cachedMicrosoftConnections().some(
        (c) => c.connectionId === meetingHome.connectionId,
      )
    : !!driveToken();

  useEffect(() => {
    const update = () => refreshDriveSession((n) => n + 1);
    const timer = window.setInterval(update, 5000);
    window.addEventListener("cheatmeet:drive-session", update);
    window.addEventListener("cheatmeet:provider-settings", update);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("cheatmeet:drive-session", update);
      window.removeEventListener("cheatmeet:provider-settings", update);
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
        if (cancelled || !ownsSession()) return;
        // Only for a session this navigation actually started: arriving here
        // while another meeting is recording must leave that one alone.
        if (requestedEvent && !isCapturing() && captureSnapshot().state !== "armed") {
          eventDraft.current = id;
          // Keep the complete requested destination through reload and failed lookups.
          const pending = new URLSearchParams(searchParams);
          pending.delete("new");
          pending.set("draft", id);
          navigate(`/record?${pending}`, { replace: true });
          await loadRequestedEvent(id);
        } else {
          unresolvedEvent.current = false;
          setEventUnresolved(false);
          navigate(`/record?draft=${id}`, { replace: true });
        }
      })
      .catch((e) => !cancelled && setCaptureError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      eventAttempt.current++;
    };
  }, [accountId, requestedDraft, startNew, requestedEvent, navigate]);

  async function loadRequestedEvent(id: string) {
    if (!requestedEvent || !unresolvedEvent.current || !ownsSession() ||
        captureSnapshot().draft.report.id !== id || isCapturing() || captureSnapshot().state === "armed") return;
    const attempt = ++eventAttempt.current;
    const current = () => attempt === eventAttempt.current && unresolvedEvent.current &&
      ownsSession() && captureSnapshot().draft.report.id === id &&
      !isCapturing() && captureSnapshot().state !== "armed";
    setEventLoading(true);
    setEventError("");
    try {
      const event = await getEvent(requestedBinding.calendarId || "primary", requestedEvent,
        requestedBinding.provider, requestedBinding.connectionId);
      if (!current()) return;
      if (!event) throw new Error("Der gewünschte Termin ist nicht mehr verfügbar.");
      setCaptureEvent(event);
      setSelectedEvent(event);
      setInvited(event.attendees);
      resetNotice();
      unresolvedEvent.current = false;
      setEventUnresolved(false);
      navigate(`/record?draft=${id}`, { replace: true });
    } catch (cause) {
      if (current()) setEventError(errorMessage(cause));
    } finally {
      if (attempt === eventAttempt.current) setEventLoading(false);
    }
  }

  function continueWithoutEvent() {
    if (!ownsSession() || captureSnapshot().draft.report.id !== eventDraft.current ||
        isCapturing() || captureSnapshot().state === "armed") return;
    eventAttempt.current++;
    unresolvedEvent.current = false;
    setEventUnresolved(false);
    setEventLoading(false);
    setEventError("");
    setCaptureEvent(null);
    setSelectedEvent(undefined);
    setInvited([]);
    resetNotice();
    navigate(`/record?draft=${eventDraft.current}`, { replace: true });
  }

  const calendarBinding: CalendarSelection | undefined = draft.report.calendarEventId
      ? { provider: draft.report.calendarProvider || "google",
          connectionId: draft.report.calendarConnectionId,
          calendarId: draft.report.calendarId || "primary" }
      : eventUnresolved ? requestedBinding : undefined;
  const pickedEvent = selectedEvent?.id === draft.report.calendarEventId &&
    (selectedEvent?.provider || "google") === calendarBinding?.provider &&
    selectedEvent?.connectionId === calendarBinding?.connectionId &&
    selectedEvent?.calendarId === calendarBinding?.calendarId ? selectedEvent : undefined;

  function pickEvent(event: CalendarEvent | null) {
    if (unresolvedEvent.current || !ownsSession() || isCapturing() || busy ||
        captureSnapshot().draft.report.id !== draft.report.id) return;
    setCaptureEvent(event);
    setSelectedEvent(event || undefined);
    setInvited(event?.attendees || []);
    resetNotice();
  }

  async function authorizeDrive() {
    if (operation.current || !ownsSession()) return;
    operation.current = true;
    setCaptureError("");
    setCaptureBusy(`${storageName} freigeben …`);
    try {
      if (meetingHome) {
        await connectMicrosoft(false);
        if (!ownsSession()) return;
        await ensureMicrosoftToken(meetingHome.connectionId);
      } else await verifyDriveAccess(await connectGoogle());
    } catch (e) {
      if (ownsSession()) setCaptureError(errorMessage(e));
    } finally {
      operation.current = false;
      if (ownsSession()) setCaptureBusy("");
      refreshDriveSession((n) => n + 1);
    }
  }

  // The notice on screen and the notice in the record come from the same pure
  // functions over the same inputs, so they cannot disagree.
  // Read at render time, not frozen at mount: the storage folder can be
  // changed from this very screen, and the notice names where files go.
  const decisionNow: ConsentDecision = {
    ...decision,
    folderName: meetingHome?.rootName || folder?.name || DEFAULT_FOLDER_NAME,
    storageService: meetingHome ? "Microsoft OneDrive" : "Google Drive",
  };
  const consentFactsNow = decisionFacts(
    decisionNow,
    liveSources.length ? liveSources : ["mic"],
  );
  const factsKey = JSON.stringify(consentFactsNow);
  const latestFactsKey = useRef(factsKey);
  latestFactsKey.current = factsKey;
  const acceptedParts = acceptConsentParts(consentFactsNow, partsFactsKey.current === factsKey ? consentParts : null);
  const consentText = assembleConsentText(consentFactsNow, acceptedParts);
  useEffect(() => {
    if (armed) resetNotice();
  }, [factsKey]);

  async function refineNotice(instruction: string) {
    if (!ownsSession()) return;
    const request = ++draftRequest.current;
    const requestFacts = factsKey;
    setApprovalFactsKey("");
    setConsentChat((lines) => [...lines, instruction]);
    setDrafting(true);
    setDraftError("");
    try {
      const parts = await draftConsentNotice(consentFactsNow, [
        ...consentChat,
        instruction,
      ]);
      if (ownsSession() && request === draftRequest.current && requestFacts === latestFactsKey.current) {
        partsFactsKey.current = requestFacts;
        setConsentParts(parts);
        setApprovalFactsKey("");
        setDecision(current => ({ ...current, participants: current.participants.map(p => ({ ...p, stance: "silent" })) }));
      }
    } catch (e) {
      if (request === draftRequest.current) setDraftError(errorMessage(e));
    } finally {
      if (request === draftRequest.current) setDrafting(false);
    }
  }

  function resetNotice() {
    draftRequest.current++;
    partsFactsKey.current = "";
    setApprovalFactsKey("");
    setDecision(current => ({ ...current, participants: current.participants.map(p => ({ ...p, stance: "silent" })) }));
    setConsentParts(null);
    setConsentChat([]);
    setDraftError("");
    setDrafting(false);
  }

  function consentGiven() {
    if (!pageActive.current || !ownsSession() || busy || drafting || approvalFactsKey !== factsKey || !everyoneAgreed(decision.participants)) return;
    void beginRecording({ ...decisionNow, parts: acceptedParts }).catch((e) =>
      setCaptureError(errorMessage(e)),
    );
  }

  function cancelArmed() {
    if (!ownsSession()) return;
    disarmCapture();
    resetNotice();
    setDecision((current) => ({ ...current, participants: [] }));
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
    if (!pageActive.current || !ownsSession() || unresolvedEvent.current || preparingReport.current) return;
    if (!homeReady) {
      setCaptureError(
        "Bitte zuerst den Speicherort laden oder ausdrücklich im Speicherort-Menü wählen.",
      );
      return;
    }
    const request = ++preparationRequest.current;
    const reportId = captureSnapshot().draft.report.id;
    preparingReport.current = reportId;
    const current = () => pageActive.current && request === preparationRequest.current &&
      ownsSession() && captureSnapshot().draft.report.id === reportId;
    try {
      setCaptureHome(selectedHome);
      const verifyStorage = async () => {
        const home = captureSnapshot().draft.report.home;
        if (home) {
          await ensureMicrosoftToken(home.connectionId);
          if (!current()) return;
          await getOneDriveItem(home, home.rootId);
          return;
        }
        const token = await ensureDriveToken();
        if (!current()) return;
        if (!token) throw new Error("Bitte zuerst Google Drive freigeben.");
        await verifyDriveAccess(token);
      };
      // The explainer's confirmation click must reach getDisplayMedia without
      // an intervening await (native browser activation requirement).
      if (sharingExplained && sources === "mic+system") {
        await armCapture(localOnly, verifyStorage, sources);
        if (!current() || captureSnapshot().state !== "armed") return;
        seedRoster();
        await skipConsentStep();
        return;
      }
      try {
        // Signed in should already mean authorized; only prompt if that fails.
        if (
          !localOnly &&
          navigator.onLine &&
          !selectedHome &&
          !(await ensureDriveToken())
        ) {
          if (!current()) return;
          await authorizeDrive();
          return;
        }
      } catch (e) {
        // This runs from `void begin()`, so a rejection would vanish silently.
        if (current()) setCaptureError(errorMessage(e));
        return;
      }
      if (!current()) return;
      // A cached Drive token can expire and then renew without a popup. Decide
      // after renewal so this path still explains sharing before requesting it.
      if (sources === "mic+system" && systemAudioAvailable && !sharingExplained) {
        pendingLocalOnly.current = localOnly;
        setSheet("share-explainer");
        return;
      }
      await armCapture(localOnly, verifyStorage, sources);
      if (!current() || captureSnapshot().state !== "armed") return;
      seedRoster();
      await skipConsentStep();
    } finally {
      if (request === preparationRequest.current) preparingReport.current = null;
    }
  }

  /** The guest list is the roster; nobody should have to retype it. */
  function seedRoster() {
    resetNotice();
    setDecision((current) => ({
      ...current,
      participants: invited.map((name) => ({ name, stance: "silent" as const })),
    }));
  }

  /** No notice means no record: the meeting documents no consent at all. */
  async function skipConsentStep() {
    if (!pageActive.current || !ownsSession() || showConsent || captureSnapshot().state !== "armed") return;
    await beginRecording(null).catch((e) => setCaptureError(errorMessage(e)));
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
    if (!ownsSession() || unresolvedEvent.current || state !== "review" || !draft.audio || operation.current) return;
    operation.current = true;
    setCaptureError("");
    setCaptureBusy("Transkription abschließen …");
    try {
      await setCaptureProcessing(analyze);
      if (!ownsSession()) return;
      // Renewing is a server call, never a popup.
      const token = draft.report.home
        ? (await ensureMicrosoftToken(draft.report.home.connectionId))
            .accessToken
        : await ensureDriveToken();
      if (!token) {
        refreshDriveSession((n) => n + 1);
        throw new Error(
          "Die Drive-Freigabe ist abgelaufen. Bitte zuerst Google Drive verbinden. Dein Entwurf bleibt erhalten.",
        );
      }
      if (!ownsSession()) return;
      await finishTranscription().catch(() => {});
      if (!ownsSession()) return;

      setCaptureBusy("Entwurf lokal sichern …");
      await captureQueue().catch(() => {});
      if (!ownsSession()) return;
      const d = captureSnapshot().draft;
      d.report.title ||= `Meeting vom ${new Date(d.report.date).toLocaleDateString("de-AT")}`;
      d.report.status = analyze ? "analyzing" : d.report.status;
      // The report must be readable before its page opens; the rest of the
      // pipeline continues in the background.
      await putLocal(accountId, d.report);
      if (!ownsSession()) return;

      void startProcessing({ owner: accountId, draft: d, token, analyze });
      releaseAfterHandoff();
      navigate(`/report/${d.report.id}`);
    } catch (e) {
      if (ownsSession()) setCaptureError(errorMessage(e));
    } finally {
      operation.current = false;
      if (ownsSession()) setCaptureBusy("");
    }
  }

  function download() {
    if (!ownsSession() || !draft.audio) return;
    const url = URL.createObjectURL(draft.audio);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aufnahme.${audioExtension(draft.audio.type)}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function confirmDiscard() {
    if (operation.current) return;
    const target = discardTarget.current;
    const current = captureSnapshot();
    if (!target || !ownsSession() || current.owner !== accountId ||
        current.draft.report.id !== target.id || isCapturing()) {
      setDiscardError("Der Entwurf hat sich geändert. Bitte schließen und erneut auswählen.");
      return;
    }
    operation.current = true;
    setDiscarding(true);
    setDiscardError("");
    try {
      await discardCapture();
      if (!ownsSession()) return;
      resetNotice();
      setSheet(null);
      navigate("/dashboard", { replace: true });
    } catch (e) {
      setDiscardError(errorMessage(e));
      if (ownsSession()) setSheet("discard");
    } finally {
      operation.current = false;
      setDiscarding(false);
    }
  }

  function requestDiscard() {
    if (!ownsSession() || recording || busy) return;
    discardTarget.current = {
      id: draft.report.id,
      title: draft.report.title || "Unbenannte Aufnahme",
    };
    setDiscardError("");
    if (draft.audio?.size || draft.report.transcription.trim()) setSheet("discard");
    else void confirmDiscard();
  }

  function leave() {
    if (!ownsSession() || busy) return;
    // Armed holds an open microphone and screen share with no bar to stop them
    // from anywhere else, and nothing has been recorded — so leaving releases.
    if (armed) disarmCapture();
    // A running meeting keeps going: the session lives outside this screen and
    // stays reachable from the recording bar.
    if (recording || !draft.audio) navigate("/dashboard");
    else setSheet("leave");
  }

  if (!ownsSession()) return <main className="walk-progress" role="status">Aufnahme für dein Konto laden …</main>;

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
            aria-haspopup="dialog"
            disabled={!!busy || loading}
            onClick={() => setSheet("options")}
          >
            <MoreHorizontal size={23} />
          </button>
        </header>
        {!error && liveStatus(liveConnection, state) && (
          <div className="walk-message is-live-status" role="status">
            {liveStatus(liveConnection, state)!.text}
            {liveStatus(liveConnection, state)!.canRestart && (
              <button type="button" onClick={restartLive}>
                Live neu starten
              </button>
            )}
          </div>
        )}
        {!error && shareNotice(liveShare, state) && (
          <div className="walk-message is-live-status" role="status">
            {shareNotice(liveShare, state)}
          </div>
        )}
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
        {eventUnresolved && (
          <div className="walk-message is-error" role={eventError ? "alert" : "status"}>
            <p>{eventError || "Gewünschten Termin laden …"} Die Terminzuordnung ist noch offen. Bitte erneut laden oder ausdrücklich ohne Termin fortfahren.</p>
            <button type="button" className="walk-secondary" disabled={loading || eventLoading}
              onClick={() => loadRequestedEvent(eventDraft.current)}>Erneut versuchen</button>
            <button type="button" className="walk-secondary" disabled={loading}
              onClick={continueWithoutEvent}>Ohne Termin fortfahren</button>
          </div>
        )}
        {loading ? (
          <main className="walk-progress" role="status">
            <Loader2 className="spin" />
            <h1>Entwurf laden …</h1>
          </main>
        ) : (
          <>
            <main
              className={`walk-content${state === "ready" ? " is-ready" : ""}`}
            >
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
                      binding={calendarBinding}
                      selectedEvent={pickedEvent}
                      disabled={eventUnresolved || !!busy}
                      onPick={pickEvent}
                    />
                    <label className="walk-project">
                      <input
                        id="title"
                        aria-label="Titel des Meetings"
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
                        <strong>
                          {storageName} ·{" "}
                          {meetingHome?.rootName ||
                            folder?.name ||
                            DEFAULT_FOLDER_NAME}
                        </strong>
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
                  {!showConsent && (
                    <div className="walk-message">
                      <p><strong>Einwilligungsschritt ausgeschaltet</strong> · Für Solo-Aufnahmen.
                        Nach der Gerätefreigabe beginnen Aufnahme und Live-Transkription direkt.
                        Es wird keine Einwilligung dokumentiert.</p>
                      <button type="button" className="walk-secondary"
                        onClick={() => setShowConsent(true)}>Für dieses Meeting einschalten</button>
                    </div>
                  )}
                </>
              ) : armed ? (
                <ArmedMeeting
                  sources={liveSources}
                  text={consentText}
                  decision={decisionNow}
                  onDecision={(patch) => {
                    if (patch.participants) setApprovalFactsKey(factsKey);
                    else resetNotice();
                    setDecision((current) => ({ ...current, ...patch }));
                  }}
                  onDraft={(instruction) => void refineNotice(instruction)}
                  onResetDraft={resetNotice}
                  drafting={drafting}
                  draftError={draftError}
                  chat={consentChat}
                  hasDraft={Object.keys(acceptedParts).length > 0}
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
                      Aufnahme beendet · Sichern steht aus
                    </span>
                    <h1>Aufnahme abgeschlossen</h1>
                    <p>
                      {draft.report.transcriptionOrigin === "import"
                        ? "Audio sichern, einmal transkribieren und zusammenfassen."
                        : "Audio sichern und das Live-Transkript zusammenfassen. Deine Namen und Audioquellen bleiben erhalten."}
                    </p>
                  </div>
                  <div className="walk-review-media">
                    <div className="walk-review-stats">
                      <span>
                        <Mic size={18} />
                        {formatTime(durationMs)} Aufnahme
                      </span>
                    </div>
                    {draft.audio && (
                      <MeetingAudioPlayer
                        blob={draft.audio}
                        loading={false}
                        durationMs={durationMs}
                        onRequestPlay={() => {}}
                        onReady={() => {}}
                      />
                    )}
                    {failed > 0 && (
                      <p className="walk-gap">
                        Das Live-Transkript kann Lücken enthalten. Es wird ohne
                        automatische erneute Transkription verwendet. Du kannst
                        unter Transkription einen zusätzlichen Durchlauf wählen.
                        Die Originalaufnahme wird gesichert.
                      </p>
                    )}
                  </div>
                  {draft.report.transcriptionOrigin !== "import" && (
                    <fieldset className="walk-speaker-assumptions">
                      <legend>Transkription</legend>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!draft.retranscribe}
                          disabled={!!busy}
                          onChange={(event) =>
                            setCaptureRetranscribe(event.target.checked)
                          }
                        />
                        Gesamte Aufnahme neu transkribieren
                      </label>
                      <p>
                        Optional und kostenpflichtig: ein zusätzlicher AssemblyAI-Durchlauf
                        kann Lücken schließen. Ohne Auswahl wird das Live-Transkript
                        verwendet. Du kannst die Volltranskription auch später im fertigen
                        Bericht starten. Eindeutige Namen bleiben erhalten; unklare
                        Sprecher kannst du prüfen.
                      </p>
                    </fieldset>
                  )}
                  {draft.report.transcriptionOrigin === "import" &&
                    draft.report.speech?.phase !== "final" && (
                      <MeetingLanguages
                        value={draft.report.speech?.languages}
                        onChange={setCaptureLanguages}
                      />
                    )}
                  {/* The link can still be made after the fact: before this the
                      picker existed only on the pre-recording screen, so a
                      recording started without one could never be attached. */}
                  <CalendarMatch
                    atMs={Date.parse(draft.report.date) || Date.now()}
                    selectedId={draft.report.calendarEventId}
                    binding={calendarBinding}
                    selectedEvent={pickedEvent}
                    disabled={eventUnresolved || !!busy}
                    label="TERMIN"
                    onPick={pickEvent}
                  />
                  <button
                    className="walk-folder"
                    onClick={() => setSheet("settings")}
                  >
                    <FolderOpen size={18} />
                    <span>
                      <small>SPEICHERORT</small>
                      <strong>
                        {storageName} ·{" "}
                        {meetingHome?.rootName ||
                          folder?.name ||
                          DEFAULT_FOLDER_NAME}
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
                      onClick={() => { if (ownsSession()) pauseCapture(); }}
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
                    <button className="walk-finish" onClick={() => { if (ownsSession()) stopCapture(); }}>
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
                    disabled={!!busy || drafting || approvalFactsKey !== factsKey || !everyoneAgreed(decision.participants)}
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
                    disabled={!!busy || !homeReady || eventUnresolved}
                    onClick={() => startRecording()}
                  >
                    <Mic size={22} />
                    {!homeReady
                      ? "Speicherort wird geladen …"
                      : online && !driveReady
                        ? `${storageName} freigeben`
                        : showConsent ? "Aufnahme vorbereiten" : "Ohne Einwilligungsschritt aufnehmen"}
                  </button>
                  {localStartOffered && (
                    <button
                      className="walk-secondary"
                      disabled={eventUnresolved || !!busy}
                      onClick={() => startRecording(true)}
                    >
                      {showConsent ? "Lokal vorbereiten" : "Ohne Einwilligungsschritt lokal aufnehmen"} · später im gewählten Archiv sichern
                    </button>
                  )}
                  <button
                    className="walk-secondary"
                    onClick={() => audioInput.current?.click()}
                    disabled={!homeReady || !!busy || eventUnresolved}
                  >
                    <Upload size={16} />
                    Vorhandenes Audio importieren
                  </button>
                </>
              ) : (
                <>
                  {online && !driveReady && (
                    <button className="walk-secondary" onClick={authorizeDrive}>
                      {storageName} vor dem Speichern verbinden
                    </button>
                  )}
                  <button
                    ref={saveButton}
                    className="walk-primary"
                    disabled={
                      !!busy || eventUnresolved || !online || !driveReady || !draft.audio?.size
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
          if (file && ownsSession() && !unresolvedEvent.current && homeReady && captureSnapshot().state === "ready") {
            setCaptureHome(selectedHome);
            void importAudio(file)
              .then((id) => {
                if (id && ownsSession()) navigate(`/record?draft=${id}`, { replace: true });
              })
              .catch((err) => setCaptureError(errorMessage(err)));
          }
          e.target.value = "";
        }}
      />
      {sheet && (
        <RecordingSheet
          title={
            sheet === "discard"
              ? "Entwurf endgültig verwerfen?"
              : sheet === "settings"
              ? state === "ready" ? "Speicherort dieses Meetings" : "Festgelegter Speicherort"
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
          onClose={() => { if (!operation.current) setSheet(null); }}
        >
          {sheet === "discard" ? (
            <div className="walk-leave">
              <p><strong>{discardTarget.current?.title}</strong></p>
              <p>
                Audio und Transkript dieses lokalen Entwurfs werden endgültig
                gelöscht. Das kann die einzige Kopie sein. Ein vorhandenes
                Cloud-Archiv wird nicht gelöscht; prüfe deine Sicherung vorher.
              </p>
              {discardError && <p className="notice" role="alert">{discardError}</p>}
              <button className="walk-primary" disabled={discarding}
                onClick={() => setSheet(null)}>Abbrechen</button>
              {draft.audio && <button className="walk-secondary" disabled={discarding}
                onClick={download}><Download size={16} /> Audio vorher herunterladen</button>}
              <button className="btn danger" disabled={discarding} onClick={confirmDiscard}>
                {discarding ? "Wird verworfen …" : "Endgültig verwerfen"}
              </button>
            </div>
          ) : sheet === "settings" ? (
            <div className="sheet-stack">
              {state === "ready" ? (
                <>
                <p className="muted">Die Auswahl gilt nur für dieses Meeting, nicht für zukünftige Aufnahmen.
                  Google Drive verwendet den bestehenden Ordner „{folder?.name || DEFAULT_FOLDER_NAME}“.</p>
                <MicrosoftSettings
                  meetingOnly
                  value={selectedHome}
                  onSelect={(home) => {
                    homeOverride.current = true;
                    setHomeReady(true);
                    setSelectedHome(home);
                    setCaptureHome(home);
                    resetNotice();
                    setCaptureError("");
                  }}
                />
                </>
              ) : (
                <>
                  <p><strong>{storageName} · {meetingHome?.rootName || folder?.name || DEFAULT_FOLDER_NAME}</strong></p>
                  {meetingHome && <p>{cachedMicrosoftConnections().find(c => c.connectionId === meetingHome.connectionId)?.accountName || "Die ursprünglich gewählte Microsoft-Verbindung wird benötigt."}</p>}
                  <p className="muted">{meetingHome
                    ? "Dieser Speicherort bleibt für dieses Meeting festgelegt."
                    : "Für dieses Meeting ist Google Drive festgelegt. Ein bereits angelegter Meeting-Ordner bleibt erhalten; andernfalls wird beim Sichern der gewählte Google-Drive-Ordner verwendet."}
                    Erneutes Verbinden ändert weder den Ordner noch den Standard für zukünftige Meetings.</p>
                </>
              )}
              <button type="button" className="btn" disabled={!!busy} onClick={authorizeDrive}>
                {storageName} erneut verbinden
              </button>
              {error && <p className="notice" role="alert">{error}</p>}
            </div>
          ) : sheet === "sources" ? (
            <div
              className="walk-sources"
              role="group"
              aria-label="Audioquelle auswählen"
            >
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
                    Für Gespräche ohne Bildschirmfreigabe. Kein Freigabe-Dialog
                    beim Start.
                  </small>
                </span>
                {audioSources === "mic" && <Check size={18} />}
              </button>
              {/* Who is on each source is a property of the sources, so it
                  lives with them rather than as a fieldset in the main flow. */}
              <fieldset className="walk-speaker-assumptions">
                <legend>Personen pro Audioquelle</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={!!draft.report.singleSpeakerSources?.mic}
                    onChange={(event) =>
                      setCaptureSingleSpeaker("mic", event.target.checked)
                    }
                  />
                  Nur eine Person am Mikrofon
                </label>
                {audioSources === "mic+system" && (
                  <label>
                    <input
                      type="checkbox"
                      checked={!!draft.report.singleSpeakerSources?.system}
                      onChange={(event) =>
                        setCaptureSingleSpeaker("system", event.target.checked)
                      }
                    />
                    Nur eine Person im Systemaudio
                  </label>
                )}
                <p>
                  Für dieses Meeting: Alle Beiträge der gewählten Quelle gehören
                  zu einer Person, auch nach einer Pause. Namen kannst du direkt
                  im Transkript ändern. Ohne Häkchen werden Stimmen automatisch
                  unterschieden.
                </p>
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
                Der Browser fragt jetzt, welchen Tab oder Bildschirm du teilst.
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
                    Ohne freigegebenen Ton nimmt CheatMeet nur dein Mikrofon
                    auf.
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
              {state === "review" && draft.audio && (
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
                    disabled={!online || !driveReady || eventUnresolved}
                    onClick={() => {
                      setSheet(null);
                      void process(false);
                    }}
                  >
                    <CloudUpload size={19} />
                    Nur in {storageName} sichern, ohne Analyse
                  </button>
                  <button onClick={() => setSheet("leave")}>
                    <ArrowLeft size={19} />
                    Als Entwurf später fortsetzen
                  </button>
                </>
              )}
              {recording && (
                <button onClick={() => navigate("/dashboard")}>
                  <ArrowLeft size={19} /> Zur Übersicht · Aufnahme bleibt aktiv
                </button>
              )}
              <button onClick={() => setSheet("settings")}>
                <FolderOpen size={19} />
                {state === "ready" ? "Speicherort für dieses Meeting wählen" : "Speicherort & Verbindung prüfen"}
              </button>
              <button
                className="danger"
                disabled={recording}
                onClick={requestDiscard}
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
