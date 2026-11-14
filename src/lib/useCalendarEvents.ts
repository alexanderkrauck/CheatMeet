import { useEffect, useState, useSyncExternalStore } from "react";
import {
  eventsBetween,
  hasAnyCalendarGrant,
  subscribeCalendar,
  calendarSelectionSnapshot,
  type CalendarEvent,
  type CalendarSelection,
} from "./calendar";
import { rememberPeople } from "./people";
import { uid } from "./reports";

export interface CalendarFeed {
  events: CalendarEvent[];
  loading: boolean;
  error: string;
  truncated: boolean;
  /** null while destination discovery is unresolved. */
  connected: boolean | null;
  /** Only same-range data may remain visible during/after a failed refresh. */
  stale: boolean;
  retry: () => void;
}
const NOTHING: CalendarEvent[] = [];
type Snapshot = Omit<CalendarFeed, "retry" | "stale"> & { key: string };
const empty = (key: string, loading: boolean): Snapshot => ({
  key,
  events: NOTHING,
  loading,
  error: "",
  truncated: false,
  connected: null,
});

/** Owner, binding and range are part of the snapshot identity, not just effect dependencies. */
export function useCalendarEvents(
  range: { fromMs: number; toMs: number } | null,
  budget?: number,
  binding?: CalendarSelection,
): CalendarFeed {
  const selection = useSyncExternalStore(
    subscribeCalendar,
    calendarSelectionSnapshot,
    () => "",
  );
  const fromMs = range?.fromMs ?? 0;
  const toMs = range?.toMs ?? 0;
  const provider = binding?.provider;
  const connectionId = binding?.connectionId;
  const calendarId = binding?.calendarId;
  const key = JSON.stringify([
    selection,
    fromMs,
    toMs,
    budget,
    provider,
    connectionId,
    calendarId,
  ]);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => empty("", !!toMs));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!toMs) {
      setSnapshot({
        ...empty(key, false),
        connected: hasAnyCalendarGrant(provider, connectionId),
      });
      return;
    }
    let owner: string;
    try {
      owner = uid();
    } catch {
      setSnapshot({ ...empty(key, false), connected: false });
      return;
    }
    const stillOwner = () => {
      try {
        return uid() === owner;
      } catch {
        return false;
      }
    };
    let active = true;
    setSnapshot((previous) =>
      previous.key === key
        ? { ...previous, loading: true, error: "" }
        : empty(key, true),
    );
    const target = provider
      ? { provider, connectionId, calendarId }
      : undefined;
    const request = target
      ? eventsBetween(fromMs, toMs, budget, target)
      : eventsBetween(fromMs, toMs, budget);
    request
      .then((found) => {
        if (!active || !stillOwner()) return;
        setSnapshot({
          key,
          events: found,
          loading: false,
          error: "",
          truncated: !!found.truncated,
          connected: hasAnyCalendarGrant(provider, connectionId),
        });
        void rememberPeople(
          owner,
          found.flatMap((event) => event.attendees),
        ).catch(() => {});
      })
      .catch((cause) => {
        if (!active || !stillOwner()) return;
        setSnapshot((previous) => ({
          ...(previous.key === key ? previous : empty(key, false)),
          loading: false,
          error:
            cause instanceof Error
              ? cause.message
              : "Der Kalender konnte nicht geladen werden.",
          connected: hasAnyCalendarGrant(provider, connectionId),
        }));
      });
    return () => {
      active = false;
    };
  }, [key, attempt]);

  // Bounded opportunistic refresh. Bursts of online/focus events do not multiply requests.
  useEffect(() => {
    if (!toMs || typeof window === "undefined") return;
    let lastRefresh = Date.now();
    const refresh = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      const now = Date.now();
      if (now - lastRefresh < 60_000) return;
      lastRefresh = now;
      setAttempt((n) => n + 1);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [key, toMs]);

  const current = snapshot.key === key ? snapshot : empty(key, !!toMs);
  return {
    ...current,
    stale: current.events.length > 0 && (current.loading || !!current.error),
    retry: () => setAttempt((n) => n + 1),
  };
}
