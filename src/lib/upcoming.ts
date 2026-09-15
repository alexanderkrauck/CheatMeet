import type { CalendarEvent } from "./calendar";

/**
 * Turning a raw calendar feed into something a meeting recorder can use.
 *
 * A calendar holds a life, not a meeting list: karaoke, the gym, a concert,
 * a dentist. Two separate questions follow from that, and conflating them was
 * the bug: *can* this be recorded at all, and is it *worth* putting forward.
 */
export const hasGuests = (event: CalendarEvent) => event.attendees.length > 0;

/**
 * Worth emphasising. Other people, or a video link to meet them in — this
 * ranks entries, it no longer hides them.
 */
export const isMeeting = (event: CalendarEvent) =>
  hasGuests(event) || event.conference;

/**
 * Kinds Google itself says are not appointments with anyone. Excluding these
 * is not a guess about the title: a birthday has no start you attend, a
 * working-location marker is a status, and "fromGmail" is a ticket or booking
 * parsed out of a confirmation mail.
 */
const NOT_AN_APPOINTMENT = new Set([
  "birthday",
  "workingLocation",
  "outOfOffice",
  "fromGmail",
]);

/**
 * Could be recorded, whatever it turns out to be. A whole-day entry counts: a
 * workshop blocked out across a day is a sitting you can sit in. What does not
 * count is an entry with nobody to meet — see above.
 */
export const isRecordable = (event: CalendarEvent) =>
  !NOT_AN_APPOINTMENT.has(event.kind);

/** Over, so not something you can still record. A running one is not over. */
export const isOver = (event: CalendarEvent, nowMs: number) =>
  event.endMs <= nowMs;

export const isRunning = (event: CalendarEvent, nowMs: number) =>
  // A whole-day entry spans the day but is not "in progress" — treating it as
  // running put it in the hero, ahead of the meeting actually starting next.
  !event.allDay && event.startMs <= nowMs && event.endMs > nowMs;

/** How far ahead the home screen starts caring. */
export const ALERT_LEAD_MS = 30 * 60 * 1000;

/**
 * The one entry the home screen should interrupt for, or null.
 *
 * Guests rank, they do not gate. Requiring attendees here is what made the
 * previous version invisible to anyone whose meetings are plain calendar
 * entries: their feed has no attendee lists, so nothing ever qualified and the
 * feature looked broken rather than quiet. A timed entry starting in ten
 * minutes is recordable whether or not Google knows who else is in it.
 */
export function imminentMeeting(
  events: CalendarEvent[],
  nowMs: number,
  leadMs = ALERT_LEAD_MS,
): CalendarEvent | null {
  const candidates = events.filter(
    (event) =>
      isRecordable(event) &&
      // A whole-day block has no start to arrive at, so counting down to it
      // would be counting down to midnight.
      !event.allDay &&
      !isOver(event, nowMs) &&
      event.startMs - nowMs <= leadMs,
  );
  if (!candidates.length) return null;
  // Already started beats about to start; then the soonest; then, only as a
  // tie-break, the one with people in it.
  return candidates.sort((a, b) => {
    const running = Number(isRunning(b, nowMs)) - Number(isRunning(a, nowMs));
    if (running) return running;
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return Number(isMeeting(b)) - Number(isMeeting(a));
  })[0];
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
