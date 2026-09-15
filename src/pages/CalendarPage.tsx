import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import MeetingRow from "../components/MeetingRow";
import MonthGrid from "../components/MonthGrid";
import UpcomingMeetings from "../components/UpcomingMeetings";
import { Busy, Notice } from "../components/UI";
import {
  buildMonthGrid,
  dayKeyLabel,
  isMonthKey,
  isValidDate,
  localDayKey,
  formatDuration,
  monthKeyOf,
  monthLabel,
  plural,
  shiftMonth,
} from "../lib/meetingMeta";
import { useReports } from "../lib/useReports";

/**
 * Both directions of the calendar: what is coming up, from Google, with a way
 * into recording it; and below that, when recordings actually happened, from
 * the archive already in memory.
 *
 * The upcoming half appears only once the calendar grant exists — without it
 * this is exactly the retrospective view it started as.
 */
export default function CalendarPage() {
  const { reports, dirty, running, loading, error } = useReports();
  const [params, setParams] = useSearchParams();
  const now = new Date();
  const [removalWarning, setRemovalWarning] = useState("");
  // ?m= is user input; a bad value must fall back rather than render NaN.
  const raw = params.get("m");
  const month = isMonthKey(raw) ? raw : monthKeyOf(now.toISOString());
  const selected = params.get("d") || "";

  const weeks = buildMonthGrid(month, reports, now);

  const inMonth = reports.filter(
    (r) => isValidDate(r.date) && monthKeyOf(r.date) === month,
  );
  const listed = selected
    ? inMonth.filter((r) => localDayKey(r.date) === selected)
    : inMonth;
  const undated = reports.filter((r) => !isValidDate(r.date));
  const minutes = Math.round(
    inMonth.reduce((sum, r) => sum + r.durationMs, 0) / 60000,
  );

  const go = (next: string) => setParams(next ? { m: next } : {});

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

      <UpcomingMeetings reports={reports} />

      {removalWarning && (
        <Notice>{removalWarning}</Notice>
      )}

      {/* The archive's own numbers belong to the archive, not to the page head,
          which now introduces the upcoming half. */}
      <div className="archive-head">
        <h2 className="group-heading">Aufgezeichnet</h2>
        <p className="muted small">
          {plural(inMonth.length, "Meeting", "Meetings")} in diesem Zeitraum
          {minutes ? ` · ${formatDuration(minutes * 60000)}` : ""}
        </p>
      </div>
      <div className="month-head">
        <button
          className="btn btn-ghost"
          aria-label="Vorheriger Monat"
          onClick={() => go(shiftMonth(month, -1))}
        >
          <ChevronLeft size={18} />
        </button>
        {/* The navigator always names the month; "Dieser Monat" belongs on a
            list heading, not on the control that moves between months. */}
        <strong aria-live="polite">{monthLabel(month, now, true)}</strong>
        <button
          className="btn btn-ghost"
          aria-label="Nächster Monat"
          onClick={() => go(shiftMonth(month, 1))}
        >
          <ChevronRight size={18} />
        </button>
        <button className="btn" onClick={() => go("")}>
          Heute
        </button>
      </div>

      {loading ? (
        <Busy text="Meetings laden …" />
      ) : (
        <div className="calendar-layout">
          <MonthGrid
            weeks={weeks}
            selected={selected}
            onSelect={(day) =>
              setParams(day ? { m: month, d: day } : { m: month })
            }
          />
          <div className="calendar-day">
            <h2 className="group-heading">
              {selected ? dayKeyLabel(selected) : monthLabel(month, now)}
            </h2>
            {listed.length ? (
              listed.map((report) => (
                <MeetingRow
                  key={report.id}
                  report={report}
                  dirty={dirty.includes(report.id)}
                  running={running.has(report.id)}
                  onWarning={setRemovalWarning}
                />
              ))
            ) : (
              <p className="calendar-empty">
                <CalendarDays size={18} /> In diesem Zeitraum wurde nichts
                aufgezeichnet.
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
