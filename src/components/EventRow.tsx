import { useState } from "react";
import { Link } from "react-router-dom";
import { Mic, Users } from "lucide-react";
import type { CalendarEvent } from "../lib/calendar";
import { guestLabel, isRecordable, timeLabel } from "../lib/upcoming";

/** The drag payload a meeting row writes, and the only one this row accepts. */
export const MIME = "application/x-cheatmeet-report";

export const recordHref = (event: CalendarEvent) =>
  `/record?new=1&event=${encodeURIComponent(event.id)}`;

/**
 * A scheduled entry, sitting in the same list as the recordings around it.
 *
 * `quiet` is the whole difference between a meeting and the gym: both stay
 * visible and both stay actionable, but only one of them gets to look like the
 * reason you opened the page.
 */
export default function EventRow({
  event,
  quiet = false,
  onDropReport,
}: {
  event: CalendarEvent;
  quiet?: boolean;
  /** Receives a recording dragged onto this event, by its report id. */
  onDropReport?: (reportId: string) => void;
}) {
  const guests = guestLabel(event);
  const [over, setOver] = useState(false);
  // Only the app's own payload counts: a dragged file or link must not look
  // droppable here.
  const carriesReport = (types: readonly string[]) =>
    types.includes(MIME);

  // A birthday or an out-of-office block is not a sitting anyone recorded.
  const droppable = onDropReport && isRecordable(event);
  const drops = droppable
    ? {
        onDragOver: (drag: React.DragEvent) => {
          if (!carriesReport(drag.dataTransfer.types)) return;
          drag.preventDefault();
          drag.dataTransfer.dropEffect = "link";
          setOver(true);
        },
        onDragLeave: (drag: React.DragEvent) => {
          // dragleave also fires when the pointer crosses into a child, which
          // made the highlight flicker off over the title and the button.
          if (drag.currentTarget.contains(drag.relatedTarget as Node | null)) return;
          setOver(false);
        },
        onDrop: (drag: React.DragEvent) => {
          setOver(false);
          if (!carriesReport(drag.dataTransfer.types)) return;
          drag.preventDefault();
          const id = drag.dataTransfer.getData(MIME);
          if (id) onDropReport(id);
        },
      }
    : {};

  return (
    <div
      className={`event-row${quiet ? " is-quiet" : ""}${over ? " is-drop" : ""}`}
      {...drops}
    >
      <span className="event-time">{timeLabel(event)}</span>
      <span className="event-body">
        <strong title={event.title}>{event.title}</strong>
        {guests && (
          <small>
            <Users size={12} aria-hidden="true" />
            {guests}
          </small>
        )}
      </span>
      {/* A whole-day block or a birthday has no sitting to record. */}
      {isRecordable(event) && (
        <Link
          className={quiet ? "btn btn-ghost" : "btn"}
          to={recordHref(event)}
          aria-label={`${event.title} aufnehmen`}
        >
          <Mic size={15} />
          {quiet ? "" : "Aufnehmen"}
        </Link>
      )}
    </div>
  );
}
