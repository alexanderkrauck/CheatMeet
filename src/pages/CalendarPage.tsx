import { Fragment, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CalendarOff, ChevronLeft, ChevronRight, Mic } from "lucide-react";
import EventRow from "../components/EventRow";
import MeetingRow from "../components/MeetingRow";
import MonthGrid from "../components/MonthGrid";
import { Busy, Notice } from "../components/UI";
import {
  buildAgenda,
  dayAgenda,
  recordedEventIds,
  scheduledByDay,
} from "../lib/dayAgenda";
import {
  buildMonthGrid,
  dayHeading,
  formatDuration,
  isMonthKey,
  isValidDate,
  localDayKey,
  monthEventRange,
  monthKeyOf,
  monthLabel,
  plural,
  shiftMonth,
} from "../lib/meetingMeta";
import { useCalendarEvents } from "../lib/useCalendarEvents";
import { useReports } from "../lib/useReports";

/**
 * One calendar, both tenses.
 *
 * This page used to be two calendars stacked on one screen: everything
 * scheduled in a flat list at the top, and — under its own heading, far below —
 * a grid of what had been recorded. They describe the same days. Now the grid
 * carries both (fill for what was recorded, dots for what is still to come)
 * and selecting a day opens a single list in time order.
 *
 * Without a calendar grant the future half is simply empty and this is exactly
 * the retrospective view it started as.
 */
export default function CalendarPage() {
  const { reports, dirty, running, loading, error } = useReports();
  const [params, setParams] = useSearchParams();
  const [removalWarning, setRemovalWarning] = useState("");
  // Recomputed every render rather than pinned at mount: a tab left open past
  // midnight was keeping yesterday's ring, yesterday's "Heute" and yesterday's
  // fetch window. The memos below key on the day string, so this costs nothing.
  const now = new Date();
  const thisMonth = monthKeyOf(now.toISOString());
  // ?m= is user input; a bad value must fall back rather than render NaN.
  const raw = params.get("m");
  const month = isMonthKey(raw) ? raw : thisMonth;
  const today = localDayKey(now.toISOString());
  // Opening the page answers "what have I got today" before anything else, so
  // an absent ?d= selects today whenever today is on screen.
  const selected = params.get("d") || (month === thisMonth ? today : "");

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `today` is `now`'s
  // only observable part here, and it is what changes at midnight.
  const range = useMemo(() => monthEventRange(month, now), [month, today]);
  const feed = useCalendarEvents(range);

  const recorded = useMemo(() => recordedEventIds(reports), [reports]);
  const scheduled = useMemo(
    () => scheduledByDay(feed.events, recorded),
    [feed.events, recorded],
  );
  const weeks = useMemo(
    () => buildMonthGrid(month, reports, now, scheduled),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above.
    [month, reports, today, scheduled],
  );

  const inMonth = reports.filter(
    (r) => isValidDate(r.date) && monthKeyOf(r.date) === month,
  );
  const undated = reports.filter((r) => !isValidDate(r.date));
  const minutes = Math.round(
    inMonth.reduce((sum, r) => sum + r.durationMs, 0) / 60000,
  );
  const plannedInMonth = [...scheduled.values()].reduce(
    (sum, items) => sum + items.length,
    0,
  );

  const entries = selected
    ? dayAgenda(selected, reports, feed.events, recorded)
    : buildAgenda(inMonth, feed.events, recorded);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Kalender</h1>
          <p className="muted">
            Was ansteht, und was davon schon aufgezeichnet ist.
          </p>
        </div>
      </div>

      {error && <Notice>{error}</Notice>}
      {removalWarning && <Notice>{removalWarning}</Notice>}

      <div className="month-head">
        {/* Changing month clears the day, so the panel widens to the whole
            month rather than carrying a selection into a month it is not in. */}
        <button
          className="btn btn-ghost"
          aria-label="Vorheriger Monat"
          onClick={() => setParams({ m: shiftMonth(month, -1) })}
        >
          <ChevronLeft size={18} />
        </button>
        <strong aria-live="polite">{monthLabel(month, now, true)}</strong>
        <button
          className="btn btn-ghost"
          aria-label="Nächster Monat"
          onClick={() => setParams({ m: shiftMonth(month, 1) })}
        >
          <ChevronRight size={18} />
        </button>
        <button
          className="btn"
          onClick={() => setParams({ m: thisMonth, d: today })}
        >
          Heute
        </button>
      </div>

      <p className="month-meta muted small">
        {plural(inMonth.length, "Meeting", "Meetings")} aufgezeichnet
        {minutes ? ` · ${formatDuration(minutes * 60000)}` : ""}
        {plannedInMonth ? ` · ${plannedInMonth} geplant` : ""}
      </p>

      {/* Retryable: a throttle or a dropped connection must not hide the whole
          future half for the rest of the visit. */}
      {feed.error && (
        <p className="upcoming-note" role="status">
          <CalendarOff size={15} /> {feed.error}
          <button className="text-button" onClick={feed.retry}>
            Erneut versuchen
          </button>
        </p>
      )}

      {loading ? (
        <Busy text="Meetings laden …" />
      ) : (
        <div className="calendar-layout">
          <MonthGrid
            weeks={weeks}
            selected={selected}
            onSelect={(day) => setParams({ m: month, d: day })}
          />
          <div className="calendar-day">
            <h2 className="group-heading">
              {selected ? dayHeading(selected, now) : monthLabel(month, now)}
            </h2>
            {entries.length ? (
              entries.map((entry, index) => (
                <Fragment key={entry.kind === "report" ? entry.report.id : entry.event.id}>
                  {/* Only in month mode, where a row shows a clock but no date
                      and the day is otherwise left to be inferred. */}
                  {!selected && entry.dayKey !== entries[index - 1]?.dayKey && (
                    <h3 className="agenda-day">{dayHeading(entry.dayKey, now)}</h3>
                  )}
                  {entry.kind === "report" ? (
                    <MeetingRow
                      report={entry.report}
                      dirty={dirty.includes(entry.report.id)}
                      running={running.has(entry.report.id)}
                      onWarning={setRemovalWarning}
                    />
                  ) : (
                    <EventRow event={entry.event} quiet={entry.quiet} />
                  )}
                </Fragment>
              ))
            ) : (
              <p className="calendar-empty">
                <CalendarOff size={18} />
                {feed.loading
                  ? "Termine werden geladen …"
                  : "Nichts geplant und nichts aufgezeichnet."}
                {selected === today && !feed.loading && (
                  <Link className="btn" to="/record?new=1">
                    <Mic size={15} /> Ohne Termin aufnehmen
                  </Link>
                )}
              </p>
            )}
          </div>
        </div>
      )}

      {undated.length > 0 && (
        <section className="undated">
          <h2 className="group-heading">Ohne Datum</h2>
          {undated.map((report) => (
            <MeetingRow
              key={report.id}
              report={report}
              dirty={dirty.includes(report.id)}
              running={running.has(report.id)}
              onWarning={setRemovalWarning}
            />
          ))}
        </section>
      )}
    </>
  );
}
