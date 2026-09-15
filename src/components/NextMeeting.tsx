import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Mic } from "lucide-react";
import { recordHref } from "./EventRow";
import { recordedEventIds } from "../lib/dayAgenda";
import { countdownLabel, guestLabel, imminentMeeting, timeLabel } from "../lib/upcoming";
import { useCalendarEvents } from "../lib/useCalendarEvents";
import type { ReportSummary } from "../lib/meetingMeta";

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
 * It stays silent without a calendar grant and silent when Google cannot be
 * reached — a red "Kalender nicht erreichbar" banner every time the API
 * throttles would be worse than not having the feature.
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
  const { events } = useCalendarEvents(range, 20);
  const next = imminentMeeting(events, nowMs);
  if (!next) return null;

  const reportId = recordedEventIds(reports).has(next.id)
    ? reports.find((report) => report.calendarEventId === next.id)?.id
    : "";
  const guests = guestLabel(next);

  return (
    <section className="attention" aria-label="Nächstes Meeting">
      <div className="attention-row is-brand">
        <span className="attention-icon">
          <Mic size={17} />
        </span>
        <div>
          <strong>{next.title}</strong>
          <p role="status">
            {countdownLabel(next, nowMs)} · {timeLabel(next)}
            {guests && ` · ${guests}`}
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
    </section>
  );
}
