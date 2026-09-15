import { dayIntensity, dayKeyLabel, plural, type DayCell } from "../lib/meetingMeta";

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
/** More than three dots in a cell this small is texture, not a count. */
const MAX_DOTS = 3;

/**
 * One month in two tenses. The background fill is the past — how much was
 * recorded that day, in three discrete steps, because with a handful of
 * meetings a smooth scale reads as noise. The dots underneath are the future:
 * what is scheduled and still unrecorded.
 *
 * Every day of the month is selectable, including empty ones: a day with
 * nothing on it is an answer to "what have I got today", not a dead cell.
 */
export default function MonthGrid({
  weeks,
  selected,
  onSelect,
}: {
  weeks: DayCell[][];
  selected: string;
  onSelect: (day: string) => void;
}) {
  return (
    <div className="month-grid">
      <div className="month-weekdays" aria-hidden="true">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      {weeks.map((week) => (
        <div className="month-week" key={week[0].key}>
          {week.map((cell) => (
            <button
              key={cell.key}
              className={`day level-${dayIntensity(cell)}${
                cell.inMonth ? "" : " is-outside"
              }${cell.isToday ? " is-today" : ""}${
                cell.key === selected ? " is-selected" : ""
              }`}
              aria-pressed={cell.key === selected}
              aria-label={`${dayKeyLabel(cell.key, {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}${cell.isToday ? " · heute" : ""} · ${plural(
                cell.count,
                "Meeting aufgezeichnet",
                "Meetings aufgezeichnet",
              )}${
                cell.events
                  ? ` · ${plural(cell.events, "Termin geplant", "Termine geplant")}`
                  : ""
              }`}
              disabled={!cell.inMonth}
              onClick={() => onSelect(cell.key)}
            >
              <span className="day-number">{cell.day}</span>
              <span className="day-marks">
                {cell.count > 0 && <span className="day-count">{cell.count}</span>}
                {cell.events > 0 &&
                  Array.from({ length: Math.min(cell.events, MAX_DOTS) }, (_, i) => (
                    <span
                      key={i}
                      className={`day-dot${
                        i === MAX_DOTS - 1 && cell.events > MAX_DOTS ? " is-more" : ""
                      }`}
                    />
                  ))}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
