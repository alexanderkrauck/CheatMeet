import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, CalendarDays, Loader2 } from "lucide-react";
import {
  calendarState,
  isValidDate,
  type CalendarState,
  type MeetingStatus,
} from "../lib/meetingMeta";
import { hasCalendarGrant, subscribeDriveSession } from "../lib/session";

/** Sized by CSS per surface, so callers only say where it goes. */
export function Brand({ className = "" }: { className?: string }) {
  return (
    <Link
      to="/dashboard"
      className={`brand ${className}`.trim()}
      aria-label="CheatMeet Übersicht"
    >
      <img className="brand-mark" src="/icons/logo.png" alt="" width={32} height={32} />
      Cheat<span className="brand-light">Meet</span>
      <span className="brand-dot">.</span>
    </Link>
  );
}
export function Notice({
  children,
  kind = "error",
}: {
  children: ReactNode;
  kind?: "error" | "success" | "info";
}) {
  return (
    <div
      className={`notice ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Busy({ text }: { text: string }) {
  return (
    <div className="busy" role="status">
      <Loader2 className="spin" size={20} />
      {text}
    </div>
  );
}
/** `date` is only ever checked as "a string" on the way in, so every label
 *  path has to survive a value that Date.parse cannot read. */
export const dateLabel = (date: string) =>
  isValidDate(date)
    ? new Date(date).toLocaleDateString("de-AT", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : "Ohne Datum";

/** The compact form a list row uses: "Di, 12. Sep · 14:30". */
export const dateTimeLabel = (date: string) => {
  if (!isValidDate(date)) return "Ohne Datum";
  const at = new Date(date);
  return `${at.toLocaleDateString("de-AT", {
    weekday: "short",
    day: "numeric",
    month: "short",
  })} · ${at.toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" })}`;
};

const STATUS_TEXT = {
  completed: "Bericht erstellt",
  error: "Analyse fehlgeschlagen",
  analyzing: "Analyse unterbrochen?",
  pending: "Entwurf",
};
const STATUS_TONE = {
  completed: "green",
  error: "red",
  analyzing: "amber",
  pending: "amber",
};

/**
 * `running` is what the pipeline knows and the stored status cannot: a report
 * mid-analysis is persisted as "analyzing", so without it the badge reads
 * "Analyse unterbrochen?" directly beneath a pill saying the analysis is live.
 */
const CALENDAR_TEXT: Record<CalendarState, string> = {
  none: "Kein Termin",
  linked: "Termin verknüpft",
  synced: "Im Kalender",
  error: "Kalender-Fehler",
};
const CALENDAR_TONE: Record<CalendarState, string> = {
  none: "",
  linked: "amber",
  synced: "green",
  error: "red",
};

/**
 * Where this meeting stands with Google Calendar. "Verknüpft" and "im
 * Kalender" are deliberately different words: a report can point at an event
 * whose notes were never written, and only naming that makes a silently failed
 * write-back visible.
 */
export function CalendarStatus({
  report,
}: {
  report: Parameters<typeof calendarState>[0];
}) {
  const granted = useSyncExternalStore(
    subscribeDriveSession,
    hasCalendarGrant,
    () => false,
  );
  // Without a grant every row would claim "Kein Termin", which is a statement
  // about the account, not about the meeting.
  if (!granted) return null;
  const state = calendarState(report);
  return (
    <span
      className={`badge ${CALENDAR_TONE[state]}`}
      title={state === "error" ? report.calendarError : undefined}
    >
      <CalendarDays size={12} aria-hidden="true" />
      {CALENDAR_TEXT[state]}
    </span>
  );
}

export function Status({
  status,
  syncedAt,
  local,
  running,
}: {
  status: MeetingStatus;
  syncedAt?: string;
  local?: boolean;
  running?: boolean;
}) {
  return (
    <span className="status-group">
      <span className={`badge ${running ? "blue" : STATUS_TONE[status]}`}>
        <span className="status-dot" />
        {running ? "Analyse läuft" : STATUS_TEXT[status]}
      </span>
      {local && (
        <span className="badge amber">
          {syncedAt
            ? "Drive gesichert · App-Index ausstehend"
            : "Cloud-Speichern ausstehend"}
        </span>
      )}
    </span>
  );
}
export function DriveLink({ id }: { id: string }) {
  return (
    <a
      className="btn"
      href={`https://drive.google.com/drive/folders/${encodeURIComponent(id)}`}
      target="_blank"
      rel="noreferrer"
    >
      Drive öffnen <ArrowUpRight size={16} />
    </a>
  );
}
export function BlobImage({ blob, alt }: { blob: Blob; alt: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return <img src={url || undefined} alt={alt} />;
}
/**
 * MediaRecorder omits the container duration, so a freshly recorded blob makes
 * the player report `Infinity` and refuse to seek. The recording clock knows
 * the real length, so state it rather than leaving the control broken.
 */
export function AudioPreview({
  blob,
  durationMs,
}: {
  blob: Blob;
  durationMs?: number;
}) {
  const [url, setUrl] = useState("");
  const [unseekable, setUnseekable] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    setUnseekable(false);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return (
    <div className="audio-preview">
      <audio
        controls
        src={url || undefined}
        aria-label="Aufnahme anhören"
        onLoadedMetadata={(e) =>
          setUnseekable(!Number.isFinite(e.currentTarget.duration))
        }
      />
      {unseekable && durationMs ? (
        <small>
          Länge {Math.floor(durationMs / 60000)}:
          {Math.floor((durationMs / 1000) % 60)
            .toString()
            .padStart(2, "0")}{" "}
          · springen erst nach dem Sichern in Drive möglich
        </small>
      ) : null}
    </div>
  );
}
