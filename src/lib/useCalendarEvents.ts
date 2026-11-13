import { useEffect, useState, useSyncExternalStore } from "react";
import {
  eventsBetween,
  hasAnyCalendarGrant,
  subscribeCalendar,
  calendarSelectionSnapshot,
  type CalendarEvent,
} from "./calendar";
import { rememberPeople } from "./people";
import { uid } from "./reports";

export interface CalendarFeed {
  events: CalendarEvent[];
  loading: boolean;
  /** Empty unless the fetch failed; callers decide whether that is worth showing. */
  error: string;
  retry: () => void;
}

const NOTHING: CalendarEvent[] = [];

/**
 * A window of the calendar, with the grant, the failure and the retry handled
 * once. Two screens need this now — the month view and the home alert — and
 * duplicating the effect is how their behaviour drifts apart.
 *
 * Passing null asks for nothing: a month wholly in the past has no future to
 * fetch, and a signed-out or ungranted account has nothing to ask with.
 */
export function useCalendarEvents(
  range: { fromMs: number; toMs: number } | null,
  budget?: number,
): CalendarFeed {
  const selection = useSyncExternalStore(
    subscribeCalendar,
    calendarSelectionSnapshot,
    () => "",
  );
  const granted = hasAnyCalendarGrant();
  const [events, setEvents] = useState<CalendarEvent[]>(NOTHING);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const fromMs = range?.fromMs ?? 0;
  const toMs = range?.toMs ?? 0;

  useEffect(() => {
    if (!granted || !toMs) {
      setEvents(NOTHING);
      setError("");
      setLoading(false);
      return;
    }
    const owner = uid();
    const stillOwner = () => {
      try {
        return uid() === owner;
      } catch {
        return false;
      }
    };
    let active = true;
    setLoading(true);
    setError("");
    eventsBetween(fromMs, toMs, budget)
      .then((found) => {
        if (!active || !stillOwner()) return;
        setEvents(found);
        // Every attendee seen is a name the speaker editor can suggest later.
        void rememberPeople(
          owner,
          found.flatMap((event) => event.attendees),
        ).catch(() => {});
      })
      .catch((cause) => {
        if (!active || !stillOwner()) return;
        setEvents(NOTHING);
        setError((cause as Error).message);
      })
      .finally(() => active && stillOwner() && setLoading(false));
    return () => {
      active = false;
    };
  }, [granted, selection, fromMs, toMs, budget, attempt]);

  return { events, loading, error, retry: () => setAttempt((n) => n + 1) };
}
