import { useEffect, useRef, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router-dom";
import { Mic, Pause, Play, RefreshCw, Square } from "lucide-react";
import { liveStatus, shareNotice } from "../lib/liveStatus";
import { auth } from "../lib/firebase";
import {
  captureSnapshot,
  pauseCapture,
  restartLive,
  stopCapture,
  subscribeCapture,
} from "../lib/capture";

const clock = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}`;

/**
 * Keeps a running meeting visible and controllable from every screen, so
 * recording no longer means being locked into the capture page.
 */
export default function RecordingBar() {
  const snap = useSyncExternalStore(subscribeCapture, captureSnapshot);
  const location = useLocation();
  const owned = snap.owner === auth.currentUser?.uid;
  const live = owned && (snap.state === "recording" || snap.state === "paused");
  const bar = useRef<HTMLDivElement>(null);
  const visible = live && !location.pathname.startsWith("/record");
  useEffect(() => {
    const element = bar.current;
    if (!visible || !element || typeof ResizeObserver === "undefined") return;
    const style = document.documentElement.style;
    const measure = () => {
      const headerHeight = document.querySelector(".topbar")?.getBoundingClientRect().height || 0;
      style.setProperty("--recording-clearance", `${Math.ceil(element.getBoundingClientRect().bottom - headerHeight + 12)}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); style.removeProperty("--recording-clearance"); };
  }, [visible]);
  const act = (action: () => void) => {
    const current = captureSnapshot();
    if (current.owner === auth.currentUser?.uid && current.draft.report.id === snap.draft.report.id) action();
  };

  useEffect(() => {
    if (!live) return;
    // The session belongs to this tab; closing it would end the meeting.
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [live]);

  if (!visible) return null;
  const paused = snap.state === "paused";
  const status = liveStatus(snap.liveConnection, snap.state);
  const reading = shareNotice(snap.liveShare, snap.state);
  return (
    <div ref={bar} className="recording-bar no-print" role="region" aria-label="Laufende Aufnahme">
      <span className="sr-only" role="status" aria-live="polite">
        {paused ? "Aufnahme pausiert" : "Aufnahme läuft"}{status?.text ? ` · ${status.text}` : ""}{reading ? ` · ${reading}` : ""}
      </span>
      <Link to={`/record?draft=${snap.draft.report.id}`}>
        <span className={`recording-dot ${paused ? "is-paused" : ""}`} />
        <Mic size={15} />
        <strong>{clock(snap.durationMs)}</strong>
        <span className="recording-title">
          {paused
            ? "Pausiert"
            : status?.text ||
              reading ||
              snap.hint ||
              (snap.transcribing > 0
                ? `${snap.transcribing} Abschnitt(e) in Arbeit`
                : snap.draft.report.title || "Meeting läuft")}
        </span>
      </Link>
      {status?.canRestart && (
        <button onClick={() => act(restartLive)} aria-label="Live-Transkript neu starten">
          <RefreshCw size={15} />
        </button>
      )}
      <button
        onClick={() => act(pauseCapture)}
        aria-label={paused ? "Aufnahme fortsetzen" : "Aufnahme pausieren"}
      >
        {paused ? <Play size={16} /> : <Pause size={16} />}
      </button>
      <button onClick={() => act(stopCapture)} aria-label="Meeting abschließen">
        <Square size={15} />
      </button>
    </div>
  );
}
