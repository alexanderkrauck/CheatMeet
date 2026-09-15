import { useEffect, useState, useSyncExternalStore } from "react";
import { CalendarDays, Check, X } from "lucide-react";
import { eventsAround, type CalendarEvent } from "../lib/calendar";
import { hasCalendarGrant, subscribeDriveSession } from "../lib/session";
import { rememberPeople } from "../lib/people";
import { uid } from "../lib/reports";

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });

/**
 * Which planned meeting this recording belongs to. Picking one names the
 * recording and, more usefully, tells the speaker editor who is in the room —
 * attendees are the only outside source of real names this app has.
 */
export default function CalendarMatch({
  atMs,
  selectedId,
  onPick,
}: {
  atMs: number;
  selectedId?: string;
  onPick: (event: CalendarEvent | null) => void;
}) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState("");
  // The token is usually minted after this mounts; without re-running, the
  // component would sit on "wird geladen …" forever.
  const granted = useSyncExternalStore(
    subscribeDriveSession,
    hasCalendarGrant,
    () => false,
  );

  useEffect(() => {
    if (!granted) return;
    let active = true;
    eventsAround(atMs)
      .then((found) => {
        if (!active) return;
        setEvents(found);
        // Everyone invited becomes a suggestion, whether or not an event is
        // picked: they are people you meet.
        void rememberPeople(uid(), found.flatMap((e) => e.attendees)).catch(() => {});
      })
      .catch((cause) => active && setError((cause as Error).message));
    return () => {
      active = false;
    };
  }, [atMs, granted]);

  if (!granted) return null;
  if (error) return <p className="muted small">{error}</p>;
  if (!events) return <p className="muted small">Kalender wird geladen …</p>;
  if (!events.length)
    return (
      <p className="muted small">
        <CalendarDays size={14} /> Kein Termin in der Nähe dieser Uhrzeit.
      </p>
    );

  return (
    <div className="calendar-match" role="group" aria-label="Zugehöriger Termin">
      {events.map((event) => {
        const picked = event.id === selectedId;
        return (
          <button
            key={event.id}
            type="button"
            className={picked ? "choice active" : "choice"}
            aria-pressed={picked}
            onClick={() => onPick(picked ? null : event)}
          >
            {picked ? <Check size={16} /> : <CalendarDays size={16} />}
            <span>
              <strong>{event.title}</strong>
              <small>
                {clock(event.startMs)}
                {event.attendees.length
                  ? ` · ${event.attendees.slice(0, 3).join(", ")}${event.attendees.length > 3 ? " …" : ""}`
                  : ""}
              </small>
            </span>
          </button>
        );
      })}
      {selectedId && (
        <button type="button" className="text-button" onClick={() => onPick(null)}>
          <X size={14} /> Zuordnung aufheben
        </button>
      )}
    </div>
  );
}
