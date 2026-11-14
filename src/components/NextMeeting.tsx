import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ExternalLink, Mic } from "lucide-react";
import { recordHref } from "./EventRow";
import { eventKey, reportEventKey } from "../lib/dayAgenda";
import {
  countdownLabel,
  guestLabel,
  imminentMeeting,
  providerEventUrl,
  timeLabel,
} from "../lib/upcoming";
import { useCalendarEvents } from "../lib/useCalendarEvents";
import { localDayKey, type ReportSummary } from "../lib/meetingMeta";

/** Fetched ahead of the alert window, so a refetch cannot miss a start. */
const WINDOW_MS = 90 * 60 * 1000;
/** Re-asking Google. */
const REFETCH_MS = 5 * 60 * 1000;
/** Moving the countdown without a reload. */
const TICK_MS = 30 * 1000;

/**
 * The meeting that is about to start, on the screen the user is already on.
 *
 * Deliberately one row and no more: the home screen is not a second calendar.
 * No calendar grant is optional; failed or budget-limited reads get a quiet,
 * retryable status rather than pretending there is definitely nothing next.
 */
export default function NextMeeting({ reports }: { reports: ReportSummary[] }) {
  // Only moves every five minutes, so the fetch is not restarted on every tick.
  const [windowStart, setWindowStart] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNowMs(at);
      setWindowStart((start) => (at - start >= REFETCH_MS ? at : start));
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const range = useMemo(
    () => ({ fromMs: windowStart, toMs: windowStart + WINDOW_MS }),
    [windowStart],
  );
  const feed = useCalendarEvents(range, 20);
  const next = imminentMeeting(feed.events, nowMs);
  const day = localDayKey(new Date(nowMs).toISOString());
  const calendarHref = `/calendar?m=${day.slice(0, 7)}&d=${day}`;
  const feedback = (feed.truncated || feed.error) && (
    <p className="upcoming-note calendar-feed-partial" role="status">
      {feed.error
        ? "Kalender konnte nicht aktualisiert werden."
        : "Nur ein Teil der Termine ist geladen; weitere Meetings können fehlen."}
      <Link to={calendarHref}>Kalender ansehen</Link>
      <button
        type="button"
        className="text-button"
        disabled={feed.loading}
        onClick={feed.retry}
      >
        Aktualisieren
      </button>
    </p>
  );
  if (!next) return feedback || null;
  const source = providerEventUrl(next);

  const reportId =
    reports.find((report) => reportEventKey(report) === eventKey(next))?.id ||
    "";
  const guests = guestLabel(next);

  return (
    <section className="attention" aria-label="Nächstes Meeting">
      <div className="attention-row is-brand">
        <span className="attention-icon">
          <Mic size={17} />
        </span>
        <div>
          <strong>
            {source ? (
              <a
                className="calendar-source-link"
                href={source}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${next.title} beim Kalenderanbieter öffnen (neuer Tab)`}
              >
                {next.title} <ExternalLink size={12} aria-hidden="true" />
              </a>
            ) : (
              next.title
            )}
          </strong>
          <p role="status">
            {countdownLabel(next, nowMs)} · {timeLabel(next)}
            {guests && ` · ${guests}`}
            {feed.stale && " · zuletzt geladener Stand"}
          </p>
        </div>
        {reportId ? (
          <Link className="btn" to={`/report/${reportId}`}>
            Bericht <ArrowRight size={15} />
          </Link>
        ) : (
          <Link className="btn btn-primary" to={recordHref(next)}>
            <Mic size={15} /> Aufnehmen
          </Link>
        )}
      </div>
      {feedback}
    </section>
  );
}
