import type { CalendarEvent } from "./calendar";

/**
 * Turning a raw calendar feed into something a meeting recorder can use.
 *
 * A calendar holds a life, not a meeting list: karaoke, the gym, a concert,
 * a dentist. Offering "record this" on all of it equally is noise, and it
 * buries the one entry that matters. The discriminator is already in the
 * data — a meeting has other people in it.
 */
export const hasGuests = (event: CalendarEvent) => event.attendees.length > 0;

/** Over, so not something you can still record. A running one is not over. */
export const isOver = (event: CalendarEvent, nowMs: number) =>
  event.endMs <= nowMs;

export const isRunning = (event: CalendarEvent, nowMs: number) =>
  // A whole-day entry spans the day but is not "in progress" — treating it as
  // running put it in the hero, ahead of the meeting actually starting next.
  !event.allDay && event.startMs <= nowMs && event.endMs > nowMs;

export interface UpcomingSplit {
  /** The one thing worth a prominent offer. Null when nothing qualifies. */
  next: CalendarEvent | null;
  /** Everything else with guests, in start order. */
  meetings: CalendarEvent[];
  /** Solo blocks. Kept, but folded away — sometimes one is a call you dial into. */
  personal: CalendarEvent[];
}

export function splitUpcoming(
  events: CalendarEvent[],
  nowMs: number,
): UpcomingSplit {
  const live = events
    .filter((event) => !isOver(event, nowMs))
    .sort((a, b) => a.startMs - b.startMs);
  const withGuests = live.filter(hasGuests);
  return {
    next: withGuests[0] ?? null,
    meetings: withGuests.slice(1),
    personal: live.filter((event) => !hasGuests(event)),
  };
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });

/** "09:30–10:30", or the honest label for a day-long entry. */
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

export function timeLabel(event: CalendarEvent): string {
  if (event.allDay) return "Ganztägig";
  const start = clock(event.startMs);
  if (event.endMs <= event.startMs) return start;
  // An event that runs past midnight would otherwise read "22:00–08:00",
  // which looks like it ends before it starts.
  if (!sameDay(new Date(event.startMs), new Date(event.endMs)))
    return `${start} – ${new Date(event.endMs).toLocaleString("de-AT", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  return `${start}–${clock(event.endMs)}`;
}

/**
 * How long until it starts, in the terms a person actually thinks in. The
 * point of the hero is urgency, and "09:30" does not convey it at 09:18.
 */
export function countdownLabel(
  event: CalendarEvent,
  nowMs: number,
  today = new Date(nowMs),
): string {
  if (isRunning(event, nowMs)) return "läuft gerade";
  const delta = event.startMs - nowMs;
  // A whole-day entry has no start moment to count down to; "in 10 Min"
  // would be counting to midnight.
  if (!event.allDay && delta <= MINUTE) return "gleich";
  if (!event.allDay && delta < HOUR) return `in ${Math.round(delta / MINUTE)} Min`;
  if (!event.allDay && delta < 12 * HOUR) {
    const hours = Math.floor(delta / HOUR);
    const minutes = Math.round((delta % HOUR) / MINUTE);
    return minutes ? `in ${hours} Std ${minutes} Min` : `in ${hours} Std`;
  }
  const start = new Date(event.startMs);
  const tomorrow = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 1,
  );
  if (sameDay(start, today))
    return event.allDay ? "heute" : `heute ${clock(event.startMs)}`;
  if (sameDay(start, tomorrow))
    return event.allDay ? "morgen" : `morgen ${clock(event.startMs)}`;
  const weekday = start.toLocaleDateString("de-AT", { weekday: "short" });
  return event.allDay ? weekday : `${weekday} ${clock(event.startMs)}`;
}

/** At most three names, then a count — a guest list is context, not content. */
export function guestLabel(event: CalendarEvent): string {
  const { attendees } = event;
  if (!attendees.length) return "";
  if (attendees.length <= 3) return attendees.join(", ");
  return `${attendees.slice(0, 2).join(", ")} +${attendees.length - 2}`;
}
