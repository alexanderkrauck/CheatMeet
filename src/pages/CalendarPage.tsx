import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CalendarOff, ChevronLeft, ChevronRight, Mic } from "lucide-react";
import AssignEvent from "../components/AssignEvent";
import EventRow from "../components/EventRow";
import MeetingRow from "../components/MeetingRow";
import MonthGrid from "../components/MonthGrid";
import { Busy, Notice } from "../components/UI";
import {
  buildAgenda,
  dayAgenda,
  eventKey,
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
import type { CalendarEvent } from "../lib/calendar";
import type { ReportSummary } from "../lib/meetingMeta";
import { useReports } from "../lib/useReports";
import { reportForDrop, reportHref } from "../lib/reports";
import { errorMessage } from "../lib/session";

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
  // A recording dropped onto an event, waiting for the user to confirm.
  const [dropped, setDropped] = useState<{
    report: ReportSummary;
    event: CalendarEvent;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const at = new Date();
      setNowMs(at.getTime());
      const midnight = new Date(
        at.getFullYear(),
        at.getMonth(),
        at.getDate() + 1,
      );
      clearTimeout(timer);
      timer = setTimeout(
        tick,
        Math.max(100, midnight.getTime() - at.getTime() + 100),
      );
    };
    tick();
    window.addEventListener("focus", tick);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);
  const now = new Date(nowMs);
  const thisMonth = monthKeyOf(now.toISOString());
  // ?m= is user input; a bad value must fall back rather than render NaN.
  const raw = params.get("m");
  const month = isMonthKey(raw) ? raw : thisMonth;
  const today = localDayKey(now.toISOString());
  // Opening the page answers "what have I got today" before anything else, so
  // an absent ?d= selects today whenever today is on screen.
  const rawDay = params.get("d") || "";
  const selected = params.has("d")
    ? /^\d{4}-\d{2}-\d{2}$/.test(rawDay) &&
      rawDay.startsWith(`${month}-`) &&
      localDayKey(`${rawDay}T00:00:00`) === rawDay
      ? rawDay
      : ""
    : month === thisMonth
      ? today
      : "";

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `today` is `now`'s
  // only observable part here, and it is what changes at midnight.
  const range = useMemo(() => monthEventRange(month, now), [month, today]);
  const feed = useCalendarEvents(range);
  const visibleRange = useMemo(() => {
    const [year, monthIndex] = month.split("-").map(Number);
    return {
      fromMs: new Date(year, monthIndex - 1, 1).getTime(),
      toMs: new Date(year, monthIndex, 1).getTime(),
    };
  }, [month]);
  const selectedRange = useMemo(() => {
    if (!selected) return null;
    const day = new Date(`${selected}T00:00:00`);
    const fromMs = day.getTime();
    day.setDate(day.getDate() + 1);
    return { fromMs, toMs: day.getTime() };
  }, [selected]);
  // A selected day gets its own bounded query if the month budget hid its tail.
  const narrowDay =
    !!selectedRange &&
    (feed.truncated || !range || selectedRange.fromMs < range.fromMs);
  const dayFeed = useCalendarEvents(narrowDay ? selectedRange : null);
  const agendaFeed = narrowDay ? dayFeed : feed;

  const recorded = useMemo(() => recordedEventIds(reports), [reports]);
  const scheduled = useMemo(
    () => scheduledByDay(feed.events, recorded, visibleRange),
    [feed.events, recorded, visibleRange],
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
  const plannedInMonth = new Set(
    [...scheduled.values()].flatMap((items) => items.map(eventKey)),
  ).size;

  const entries = selected
    ? dayAgenda(selected, reports, agendaFeed.events, recorded)
    : buildAgenda(inMonth, feed.events, recorded, visibleRange);

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

      <div className="month-head calendar-toolbar">
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
        <label className="calendar-month-jump">
          Monat wählen
          <input
            type="month"
            value={month}
            aria-label="Monat und Jahr wählen"
            onChange={(event) => {
              if (isMonthKey(event.target.value))
                setParams({ m: event.target.value, d: "" });
            }}
          />
        </label>
        <button
          className="btn"
          disabled={feed.loading || agendaFeed.loading}
          onClick={() => {
            feed.retry();
            if (narrowDay) dayFeed.retry();
          }}
        >
          {feed.loading || agendaFeed.loading
            ? "Aktualisieren …"
            : "Aktualisieren"}
        </button>
      </div>

      <p className="month-meta muted small">
        {plural(inMonth.length, "Meeting", "Meetings")} aufgezeichnet
        {minutes ? ` · ${formatDuration(minutes * 60000)}` : ""}
        {plannedInMonth
          ? ` · ${feed.truncated ? "mindestens " : ""}${plannedInMonth} geplant`
          : ""}
      </p>

      {!selected && range && range.fromMs > visibleRange.fromMs && (
        <p className="muted small calendar-feed-status">
          Geplante Termine ab heute. Wähle einen vergangenen Tag, um dessen
          Termine zu laden.
        </p>
      )}
      {/* Retryable: a throttle or a dropped connection must not hide the whole
          future half for the rest of the visit. */}
      {(agendaFeed.error || feed.error) && (
        <p className="upcoming-note calendar-feed-status" role="status">
          <CalendarOff size={15} /> {agendaFeed.error || feed.error}
          <button
            className="text-button"
            disabled={agendaFeed.loading}
            onClick={agendaFeed.error ? agendaFeed.retry : feed.retry}
          >
            Erneut versuchen
          </button>
        </p>
      )}

      {feed.truncated && (
        <p className="calendar-feed-partial muted small" role="status">
          Die Monatsliste ist wegen der Abrufgrenze unvollständig. Wähle einen
          Tag, um dessen Termine gezielt zu laden; Markierungen und Anzahl
          können unvollständig sein.
        </p>
      )}
      {agendaFeed.truncated && narrowDay && (
        <p className="calendar-feed-partial muted small" role="status">
          Auch dieser Tag enthält mehr Termine als geladen werden können. Bitte
          die vollständige Liste beim Kalenderanbieter prüfen.
        </p>
      )}
      {agendaFeed.stale && (
        <p className="calendar-feed-status muted small" role="status">
          Zuletzt geladene Termine dieses Zeitraums; die Aktualisierung ist noch
          ausstehend.
        </p>
      )}
      {agendaFeed.connected === false &&
        !agendaFeed.loading &&
        !agendaFeed.error && (
          <p className="calendar-feed-status muted small">
            Kein Kalender verbunden. Deine aufgezeichneten Meetings bleiben
            verfügbar.{" "}
            <Link to="/settings">Kalender verbinden oder auswählen</Link>
          </p>
        )}

      {loading ? (
        <Busy text="Meetings laden …" />
      ) : (
        <div className="calendar-layout">
          <MonthGrid
            weeks={weeks}
            selected={selected}
            onSelect={(day) =>
              setParams({ m: month, d: day === selected ? "" : day })
            }
          />
          <div className="calendar-day" aria-busy={agendaFeed.loading}>
            <div
              className="calendar-agenda-toggle"
              role="group"
              aria-label="Agenda-Ansicht"
            >
              <button
                className="btn btn-ghost"
                aria-pressed={!selected}
                onClick={() => setParams({ m: month, d: "" })}
              >
                Alle Tage
              </button>
              {!selected && (
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    setParams({
                      m: month,
                      d: month === thisMonth ? today : `${month}-01`,
                    })
                  }
                >
                  Tag auswählen
                </button>
              )}
            </div>
            <h2 className="group-heading">
              {selected ? dayHeading(selected, now) : monthLabel(month, now)}
            </h2>
            {agendaFeed.loading && (
              <p className="calendar-feed-status muted small" role="status">
                Termine werden geladen …
              </p>
            )}
            {entries.length ? (
              entries.map((entry, index) => (
                <Fragment
                  key={
                    entry.kind === "report"
                      ? reportHref(entry.report)
                      : `${eventKey(entry.event)}:${entry.dayKey}`
                  }
                >
                  {/* Only in month mode, where a row shows a clock but no date
                      and the day is otherwise left to be inferred. */}
                  {!selected && entry.dayKey !== entries[index - 1]?.dayKey && (
                    <h3 className="agenda-day">
                      {dayHeading(entry.dayKey, now)}
                    </h3>
                  )}
                  {entry.kind === "report" ? (
                    <MeetingRow
                      report={entry.report}
                      dirty={dirty.includes(reportHref(entry.report))}
                      running={running.has(reportHref(entry.report))}
                      draggable
                      onWarning={setRemovalWarning}
                    />
                  ) : (
                    <EventRow
                      event={entry.event}
                      quiet={entry.quiet}
                      onDropReport={(payload) => {
                        try {
                          const match = reportForDrop(reports, payload);
                          if (match) setDropped({ report: match, event: entry.event });
                        } catch (cause) {
                          setRemovalWarning(errorMessage(cause));
                        }
                      }}
                    />
                  )}
                </Fragment>
              ))
            ) : (
              <p className="calendar-empty">
                <CalendarOff size={18} />
                {agendaFeed.loading
                  ? "Termine werden geladen …"
                  : agendaFeed.error
                    ? "Keine Aufzeichnung für diesen Zeitraum. Geplante Termine konnten nicht geladen werden."
                    : agendaFeed.truncated
                      ? "Keine Aufzeichnung; die Terminliste ist unvollständig."
                      : agendaFeed.connected === false
                        ? "Keine Aufzeichnung für diesen Zeitraum. Ohne Kalenderzugriff sind geplante Termine unbekannt."
                        : !selected && !range
                          ? "Keine Aufzeichnung in diesem Monat. Vergangene Termine werden für einen ausgewählten Tag geladen."
                          : "Nichts geplant und nichts aufgezeichnet."}
                {selected === today && !agendaFeed.loading && (
                  <Link className="btn" to="/record?new=1">
                    <Mic size={15} /> Ohne Termin aufnehmen
                  </Link>
                )}
              </p>
            )}
          </div>
        </div>
      )}

      {dropped && (
        <AssignEvent
          report={dropped.report}
          event={dropped.event}
          onClose={() => setDropped(null)}
          onWarning={setRemovalWarning}
        />
      )}

      {undated.length > 0 && (
        <section className="undated">
          <h2 className="group-heading">Ohne Datum</h2>
          {undated.map((report) => (
            <MeetingRow
              key={reportHref(report)}
              report={report}
              dirty={dirty.includes(reportHref(report))}
              running={running.has(reportHref(report))}
              onWarning={setRemovalWarning}
            />
          ))}
        </section>
      )}
    </>
  );
}
