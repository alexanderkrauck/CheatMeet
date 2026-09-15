import { Link } from "react-router-dom";
import { Mic, Users } from "lucide-react";
import type { CalendarEvent } from "../lib/calendar";
import { guestLabel, isRecordable, timeLabel } from "../lib/upcoming";

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
}: {
  event: CalendarEvent;
  quiet?: boolean;
}) {
  const guests = guestLabel(event);
  return (
    <div className={`event-row${quiet ? " is-quiet" : ""}`}>
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
