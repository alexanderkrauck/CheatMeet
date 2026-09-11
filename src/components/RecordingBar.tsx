import { useEffect, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router-dom";
import { Mic, Pause, Play, Square } from "lucide-react";
import {
  captureSnapshot,
  pauseCapture,
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
  const live = snap.state === "recording" || snap.state === "paused";

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

  if (!live || location.pathname.startsWith("/record")) return null;
  const paused = snap.state === "paused";
  return (
    <div className="recording-bar no-print" role="status" aria-live="polite">
      <Link to={`/record?draft=${snap.draft.report.id}`}>
        <span className={`recording-dot ${paused ? "is-paused" : ""}`} />
        <Mic size={15} />
        <strong>{clock(snap.durationMs)}</strong>
        <span className="recording-title">
          {paused
            ? "Pausiert"
            : snap.hint ||
              (snap.transcribing > 0
                ? `${snap.transcribing} Abschnitt(e) in Arbeit`
                : snap.draft.report.title || "Meeting läuft")}
        </span>
      </Link>
      <button
        onClick={pauseCapture}
        aria-label={paused ? "Aufnahme fortsetzen" : "Aufnahme pausieren"}
      >
        {paused ? <Play size={16} /> : <Pause size={16} />}
      </button>
      <button onClick={stopCapture} aria-label="Meeting abschließen">
        <Square size={15} />
      </button>
    </div>
  );
}
