import { useEffect, useState, useSyncExternalStore } from "react";
import { CalendarDays, Check, X } from "lucide-react";
import { eventsAround, type CalendarEvent } from "../lib/calendar";
import { hasCalendarGrant, subscribeDriveSession } from "../lib/session";
import { rememberPeople } from "../lib/people";
import { uid } from "../lib/reports";
import { eventLine } from "../lib/upcoming";

/**
 * Which planned meeting this recording belongs to. Picking one names the
 * recording and, more usefully, tells the speaker editor who is in the room —
 * attendees are the only outside source of real names this app has.
 *
 * Once something is picked it becomes one card that owns its own removal
 * control. The remove action used to be a bare ✕ and an underlined link
 * dangling below the list, bound to nothing the eye could connect it to.
 */
export default function CalendarMatch({
  atMs,
  selectedId,
  label,
  onPick,
}: {
  atMs: number;
  selectedId?: string;
  /** An eyebrow above the control. Omitted where a heading already says it. */
  label?: string;
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

  const picked = events?.find((event) => event.id === selectedId);
  const frame = (children: React.ReactNode) => (
    <div className="calendar-match" role="group" aria-label="Zugehöriger Termin">
      {label && <span className="calendar-match-label">{label}</span>}
      {children}
    </div>
  );

  // An assignment made days ago, or to an event since moved, falls outside the
  // window this fetches. Rendering nothing would claim the recording belongs
  // to nothing while it still carries the link — and would take away the only
  // control that can clear it.
  if (selectedId && !picked && events)
    return frame(
      <div className="calendar-picked is-unknown">
        <CalendarDays size={16} aria-hidden="true" />
        <span>
          <strong>Zugeordneter Termin</strong>
          <small>Liegt außerhalb dieses Zeitraums.</small>
        </span>
        <button type="button" className="calendar-clear" onClick={() => onPick(null)}>
          <X size={15} /> Zuordnung aufheben
        </button>
      </div>,
    );

  if (picked)
    return frame(
      <div className="calendar-picked">
        <Check size={16} aria-hidden="true" />
        <span>
          <strong title={picked.title}>{picked.title}</strong>
          <small>{eventLine(picked)}</small>
        </span>
        {/* Inside the card, on the thing it removes. */}
        <button
          type="button"
          className="calendar-clear"
          aria-label={`Zuordnung zu „${picked.title}“ aufheben`}
          onClick={() => onPick(null)}
        >
          <X size={15} /> Zuordnung aufheben
        </button>
      </div>,
    );

  if (error) return frame(<p className="muted small">{error}</p>);
  if (!events) return frame(<p className="muted small">Kalender wird geladen …</p>);
  if (!events.length)
    return frame(
      <p className="muted small">
        <CalendarDays size={14} /> Kein Termin in der Nähe dieser Uhrzeit.
      </p>,
    );

  return frame(
    events.map((event) => (
      <button
        key={event.id}
        type="button"
        className="choice"
        onClick={() => onPick(event)}
      >
        <CalendarDays size={16} />
        <span>
          <strong>{event.title}</strong>
          <small>{eventLine(event)}</small>
        </span>
      </button>
    )),
  );
}
