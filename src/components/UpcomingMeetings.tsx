import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarOff, Mic, Users } from "lucide-react";
import { eventsBetween, type CalendarEvent } from "../lib/calendar";
import { dayKeyLabel, localDayKey, plural } from "../lib/meetingMeta";
import { rememberPeople } from "../lib/people";
import { uid } from "../lib/reports";
import { hasCalendarGrant, subscribeDriveSession } from "../lib/session";
import {
  countdownLabel,
  guestLabel,
  splitUpcoming,
  timeLabel,
} from "../lib/upcoming";
import type { ReportSummary } from "../lib/meetingMeta";

const recordHref = (event: CalendarEvent) =>
  `/record?new=1&event=${encodeURIComponent(event.id)}`;

/** Today, tomorrow, then the weekday — the way a person reads a schedule. */
function dayHeading(key: string, now: Date): string {
  const today = localDayKey(now.toISOString());
  const tomorrow = localDayKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
  );
  if (key === today) return "Heute";
  if (key === tomorrow) return "Morgen";
  return dayKeyLabel(key, { weekday: "long", day: "numeric", month: "long" });
}

function EventRow({
  event,
  reportId,
}: {
  event: CalendarEvent;
  reportId?: string;
}) {
  return (
    <div className="upcoming-row">
      <span className="upcoming-time">{timeLabel(event)}</span>
      <span className="upcoming-body">
        <strong title={event.title}>{event.title}</strong>
        {guestLabel(event) && (
          <small>
            <Users size={12} aria-hidden="true" />
            {guestLabel(event)}
          </small>
        )}
      </span>
      {reportId ? (
        <Link className="btn btn-ghost" to={`/report/${reportId}`}>
          Bericht <ArrowRight size={15} />
        </Link>
      ) : (
        <Link className="btn" to={recordHref(event)} aria-label={`${event.title} aufnehmen`}>
          <Mic size={15} /> Aufnehmen
        </Link>
      )}
    </div>
  );
}

/**
 * What is coming up, and the way into recording it.
 *
 * A calendar feed is a life, not a meeting list — and rendering all of it with
 * an equally loud offer to record buried the one entry that mattered. So: one
 * prominent next meeting, the remaining meetings behind it, and everything
 * without other people in it folded away but still reachable.
 */
export default function UpcomingMeetings({
  reports,
  days = 7,
}: {
  reports: ReportSummary[];
  days?: number;
}) {
  const granted = useSyncExternalStore(
    subscribeDriveSession,
    hasCalendarGrant,
    () => false,
  );
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // The hero counts down, so it has to re-render without a reload.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!granted) return;
    let active = true;
    const now = Date.now();
    setError("");
    eventsBetween(now, now + days * 24 * 60 * 60 * 1000)
      .then((found) => {
        if (!active) return;
        setEvents(found);
        setError("");
        void rememberPeople(uid(), found.flatMap((e) => e.attendees)).catch(() => {});
      })
      .catch((cause) => active && setError((cause as Error).message));
    return () => {
      active = false;
    };
  }, [granted, days, attempt]);

  useEffect(() => {
    if (!events?.length) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [events]);

  if (!granted) return null;
  if (error)
    // Retryable: a throttle or a dropped connection must not hide the section
    // for the rest of the visit.
    return (
      <p className="upcoming-note" role="status">
        <CalendarOff size={15} /> {error}
        <button className="text-button" onClick={() => setAttempt((n) => n + 1)}>
          Erneut versuchen
        </button>
      </p>
    );
  if (!events) return <p className="upcoming-note">Termine werden geladen …</p>;

  const { next, meetings, personal } = splitUpcoming(events, nowMs);
  if (!next && !meetings.length && !personal.length)
    return (
      <p className="upcoming-note">
        <CalendarOff size={15} /> Keine Termine in den nächsten{" "}
        {plural(days, "Tag", "Tagen")}.
      </p>
    );

  // A meeting already recorded offers its report rather than a second take.
  const recorded = new Map(
    reports.filter((r) => r.calendarEventId).map((r) => [r.calendarEventId!, r.id]),
  );
  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of meetings) {
    const key = localDayKey(new Date(event.startMs).toISOString());
    byDay.set(key, [...(byDay.get(key) || []), event]);
  }
  const now = new Date(nowMs);

  return (
    <section className="upcoming" aria-labelledby="upcoming-title">
      <h2 className="sr-only" id="upcoming-title">
        Kommende Termine
      </h2>

      {next &&
        (recorded.has(next.id) ? (
          <div className="next-meeting is-done">
            <span className="eyebrow">ALS NÄCHSTES</span>
            <h3>{next.title}</h3>
            <p className="next-meta">
              {countdownLabel(next, nowMs, now)} · {timeLabel(next)}
            </p>
            <Link className="btn" to={`/report/${recorded.get(next.id)}`}>
              Bericht öffnen <ArrowRight size={16} />
            </Link>
          </div>
        ) : (
          <div className="next-meeting">
            <span className="eyebrow">ALS NÄCHSTES</span>
            <h3>{next.title}</h3>
            <p className="next-meta">
              <strong>{countdownLabel(next, nowMs, now)}</strong> · {timeLabel(next)}
              {guestLabel(next) && ` · ${guestLabel(next)}`}
            </p>
            <Link className="btn btn-primary" to={recordHref(next)}>
              <Mic size={17} /> Meeting aufnehmen
            </Link>
          </div>
        ))}

      {[...byDay.entries()].map(([key, items]) => (
        <div key={key} className="upcoming-day">
          <h3>{dayHeading(key, now)}</h3>
          {items.map((event) => (
            <EventRow key={event.id} event={event} reportId={recorded.get(event.id)} />
          ))}
        </div>
      ))}

      {personal.length > 0 && (
        /* Kept, not hidden: a solo block is sometimes a call you dial into. */
        <details className="upcoming-other">
          <summary>
            {plural(personal.length, "Termin", "Termine")} ohne Gäste
          </summary>
          <div>
            {personal.map((event) => (
              <EventRow key={event.id} event={event} reportId={recorded.get(event.id)} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
