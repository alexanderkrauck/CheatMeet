import { dayIntensity, dayKeyLabel, plural, type DayCell } from "../lib/meetingMeta";

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/**
 * A retrospective month: which days were recorded on, and roughly how much.
 * Density is three discrete steps rather than a continuous heatmap — with a
 * handful of meetings a day a smooth scale reads as noise.
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
                "Meeting",
                "Meetings",
              )}`}
              disabled={!cell.count}
              onClick={() => onSelect(cell.key === selected ? "" : cell.key)}
            >
              <span className="day-number">{cell.day}</span>
              {cell.count > 0 && <span className="day-count">{cell.count}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
