import { useEffect, useState } from "react";
import { CalendarDays, Check, X } from "lucide-react";
import {
  getEvent,
  type CalendarEvent,
  type CalendarSelection,
} from "../lib/calendar";
import { auth } from "../lib/firebase";
import { localDayKey } from "../lib/meetingMeta";
import { eventKey } from "../lib/dayAgenda";
import { eventLine } from "../lib/upcoming";
import { useCalendarEvents } from "../lib/useCalendarEvents";
import { Link } from "react-router-dom";

/** Full bindings are independent of today's default provider/account. */
export default function CalendarMatch({
  atMs,
  selectedId,
  selectedEvent,
  binding,
  disabled = false,
  label,
  onPick,
}: {
  atMs: number;
  selectedId?: string;
  selectedEvent?: CalendarEvent;
  binding?: CalendarSelection;
  disabled?: boolean;
  label?: string;
  onPick: (event: CalendarEvent | null) => void;
}) {
  const feed = useCalendarEvents(
    selectedId
      ? null
      : { fromMs: atMs - 3 * 60 * 60 * 1000, toMs: atMs + 3 * 60 * 60 * 1000 },
    50,
    binding,
  );
  const [lookup, setLookup] = useState<{
    key: string;
    event: CalendarEvent | null;
    error: string;
    loading: boolean;
  }>({ key: "", event: null, error: "", loading: false });
  const [attempt, setAttempt] = useState(0);
  const provider = binding?.provider || selectedEvent?.provider || "google";
  const calendarId =
    binding?.calendarId || selectedEvent?.calendarId || "primary";
  const connectionId = binding?.connectionId || selectedEvent?.connectionId;
  const owner = auth.currentUser?.uid;
  const lookupKey = JSON.stringify([
    owner,
    selectedId,
    provider,
    connectionId,
    calendarId,
  ]);
  const day = localDayKey(new Date(atMs).toISOString());
  useEffect(() => {
    if (!owner || !selectedId || selectedEvent) return;
    let active = true;
    const current = () => active && auth.currentUser?.uid === owner;
    setLookup({ key: lookupKey, event: null, error: "", loading: true });
    getEvent(calendarId, selectedId, provider, connectionId)
      .then((event) => {
        if (!current()) return;
        setLookup({
          key: lookupKey,
          event,
          error: event
            ? ""
            : "Der zugeordnete Termin ist nicht mehr verfügbar.",
          loading: false,
        });
        // Only an intentional retry changes the recording; merely rendering an old link does not.
        if (attempt > 0 && event && !disabled) onPick(event);
      })
      .catch((cause) => {
        if (current())
          setLookup({
            key: lookupKey,
            event: null,
            error:
              cause instanceof Error
                ? cause.message
                : "Der Termin konnte nicht geladen werden.",
            loading: false,
          });
      });
    return () => {
      active = false;
    };
  }, [lookupKey, selectedEvent, attempt, disabled]);

  const key = selectedId
    ? eventKey({ id: selectedId, calendarId, provider, connectionId })
    : "";
  const picked =
    selectedEvent ||
    feed.events.find((event) => eventKey(event) === key) ||
    (lookup.key === lookupKey ? lookup.event : null);
  return (
    <div
      className="calendar-match"
      role="group"
      aria-label="Zugehöriger Termin"
      aria-busy={feed.loading || (!!selectedId && !picked && lookup.loading)}
    >
      {label && <span className="calendar-match-label">{label}</span>}
      {selectedId ? (
        <>
          <div className={`calendar-picked${picked ? "" : " is-unknown"}`}>
            {picked ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <CalendarDays size={16} aria-hidden="true" />
            )}
            <span>
              <strong title={picked?.title}>
                {picked?.title || "Zugeordneter Termin"}
              </strong>
              <small>
                {picked
                  ? eventLine(picked, true)
                  : lookup.key === lookupKey && lookup.error
                    ? "Zuordnung bleibt erhalten; Termindetails nicht geladen."
                    : "Termindetails werden geladen …"}
              </small>
            </span>
            <button
              type="button"
              className="calendar-clear"
              disabled={disabled}
              onClick={() => onPick(null)}
            >
              <X size={15} /> Zuordnung aufheben
            </button>
          </div>
          {!picked && lookup.key === lookupKey && lookup.error && (
            <p className="calendar-feed-status" role="status">
              {lookup.error}{" "}
              <button
                type="button"
                className="text-button"
                disabled={disabled || lookup.loading}
                onClick={() => setAttempt((n) => n + 1)}
              >
                Termin erneut laden
              </button>
            </p>
          )}
        </>
      ) : (
        <>
          {feed.error && (
            <p className="calendar-feed-status" role="status">
              {feed.error}{" "}
              <button
                type="button"
                className="text-button"
                disabled={disabled || feed.loading}
                onClick={feed.retry}
              >
                Erneut versuchen
              </button>
            </p>
          )}
          {feed.loading && !feed.events.length && (
            <p className="muted small" role="status">
              Kalender wird geladen …
            </p>
          )}
          {feed.connected === false && !feed.loading && !feed.error && (
            <p className="muted small">
              Kein Kalender freigegeben.{" "}
              <Link to="/settings">Kalender verbinden oder auswählen</Link>
            </p>
          )}
          {!feed.loading &&
            !feed.error &&
            feed.connected &&
            !feed.events.length && (
              <p className="muted small">
                <CalendarDays size={14} /> Kein Termin in der Nähe dieser
                Uhrzeit.
              </p>
            )}
          {feed.stale && (
            <p className="muted small" role="status">
              Zuletzt geladene Termine; Aktualisierung noch ausstehend.
            </p>
          )}
          {feed.events.map((event) => (
            <button
              key={eventKey(event)}
              type="button"
              className="choice"
              disabled={disabled || feed.loading}
              onClick={() => onPick(event)}
            >
              <CalendarDays size={16} />
              <span>
                <strong>{event.title}</strong>
                <small>{eventLine(event, true)}</small>
              </span>
            </button>
          ))}
          {feed.truncated && (
            <p className="calendar-feed-partial muted small" role="status">
              Nur ein Teil der Termine in diesem Zeitfenster ist geladen.{" "}
              <Link to={`/calendar?m=${day.slice(0, 7)}&d=${day}`}>
                Weitere Termine im Kalender prüfen
              </Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
