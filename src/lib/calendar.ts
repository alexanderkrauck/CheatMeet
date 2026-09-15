import { ensureDriveToken, hasCalendarGrant } from "./session";

/**
 * Google Calendar, both directions.
 *
 * Reading gives a recording the two things it otherwise has to guess: what the
 * meeting is called, and who is in it — and attendees are the missing input to
 * speaker naming. Writing puts the summary back where the meeting was planned,
 * which is where anyone looking for it will go.
 *
 * The browser talks to Google directly with the same short-lived token Drive
 * uses; nothing passes through the server.
 */
const API = "https://www.googleapis.com/calendar/v3";

/** Carries the HTTP status so callers can tell "gone" from "could not ask". */
export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason = "",
  ) {
    super(message);
    this.name = "CalendarError";
  }
}

/** Only a deleted event justifies dropping a report's link to it. */
export const isEventGone = (error: unknown) =>
  error instanceof CalendarError && (error.status === 404 || error.status === 410);

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  startMs: number;
  endMs: number;
  /** Google gives a date with no time; rendering it as 00:00 is a lie. */
  allDay: boolean;
  attendees: string[];
  description: string;
  htmlLink?: string;
}

interface RawEvent {
  id?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { displayName?: string; email?: string; self?: boolean; resource?: boolean }[];
}

/** The part of an attendee a person would recognise. */
const attendeeName = (a: NonNullable<RawEvent["attendees"]>[number]): string =>
  (a.displayName || a.email?.split("@")[0]?.replace(/[._]+/g, " ") || "").trim();

const time = (slot?: { dateTime?: string; date?: string }) => {
  if (slot?.dateTime) return Date.parse(slot.dateTime) || 0;
  // "2026-09-14" parses as UTC midnight, which is the previous day west of UTC.
  if (slot?.date) return new Date(`${slot.date}T00:00:00`).getTime() || 0;
  return 0;
};

export function toEvent(raw: RawEvent, calendarId: string): CalendarEvent | null {
  if (!raw.id || raw.status === "cancelled") return null;
  const startMs = time(raw.start);
  if (!startMs) return null;
  return {
    id: raw.id,
    calendarId,
    title: (raw.summary || "Ohne Titel").trim(),
    startMs,
    endMs: time(raw.end) || startMs,
    allDay: !raw.start?.dateTime && !!raw.start?.date,
    // Rooms and equipment are attendees to Google; they are not people.
    attendees: (raw.attendees || [])
      .filter((a) => !a.resource && !a.self)
      .map(attendeeName)
      .filter(Boolean),
    description: raw.description || "",
    htmlLink: raw.htmlLink,
  };
}

async function call(path: string, init: RequestInit = {}) {
  const token = await ensureDriveToken();
  if (!token) throw new Error("Google ist nicht verbunden.");
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const reason = String(body?.error?.errors?.[0]?.reason || "");
    const fail = (message: string) =>
      new CalendarError(message, response.status, reason);
    if (response.status === 401)
      throw fail(
        "Der Kalenderzugriff fehlt. Bitte Google erneut verbinden und den Kalender freigeben.",
      );
    if (response.status === 403)
      throw fail(
        reason.startsWith("forbiddenForNonOrganizer") ||
        reason === "cannotChangeOrganizer"
          ? "Der Termin gehört jemand anderem und kann nicht ergänzt werden."
          : // Throttling and quota are transient; telling the user their grant
            // is broken sends them through a pointless re-authorization.
            reason === "rateLimitExceeded" ||
              reason === "userRateLimitExceeded" ||
              reason === "quotaExceeded"
            ? "Google Kalender ist gerade ausgelastet. Bitte kurz später erneut versuchen."
            : "Der Kalenderzugriff fehlt. Bitte Google erneut verbinden und den Kalender freigeben.",
      );
    if (response.status === 404 || response.status === 410)
      throw fail("Der Kalendereintrag existiert nicht mehr.");
    throw fail(`Google Kalender: Anfrage fehlgeschlagen (${response.status}).`);
  }
  return response.json();
}

/** Events in a time range on the primary calendar, in start order. */
/** How many events are worth fetching at all; a week of a busy calendar. */
const EVENT_BUDGET = 250;
const PAGE_SIZE = 100;

export async function eventsBetween(
  fromMs: number,
  toMs: number,
  budget = EVENT_BUDGET,
): Promise<CalendarEvent[]> {
  if (!hasCalendarGrant()) return [];
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  // Results come back in start order, so a single capped page silently drops
  // the later days of the range — a meeting on day six would never appear.
  do {
    const params = new URLSearchParams({
      timeMin: new Date(fromMs).toISOString(),
      timeMax: new Date(toMs).toISOString(),
      // Expands recurring series into the individual occurrences a person sees.
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(PAGE_SIZE, budget - events.length)),
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await call(`/calendars/primary/events?${params}`);
    for (const raw of (data.items || []) as RawEvent[]) {
      const event = toEvent(raw, "primary");
      if (event) events.push(event);
    }
    pageToken = data.nextPageToken;
  } while (pageToken && events.length < budget);
  return events;
}

/** What you are plausibly in right now — the record screen's question. */
export const eventsAround = (atMs: number, windowMs = 3 * 60 * 60 * 1000) =>
  eventsBetween(atMs - windowMs, atMs + windowMs, 50);

const MARKER_START = "--- CheatMeet ---";
const MARKER_END = "--- Ende CheatMeet ---";

/**
 * Replaces this app's own block and leaves everything else the organiser wrote
 * exactly as it was — including anything written *below* the block, which is
 * the natural place to add a note since the block is appended at the end.
 *
 * Both ends are marked so the replaced span is bounded. A block written before
 * the end marker existed has no closing line; rather than guess where it ends
 * and risk eating the organiser's text, that case appends.
 */
export function mergeDescription(existing: string, block: string): string {
  const fresh = `${MARKER_START}\n${block}\n${MARKER_END}`;
  // Only a marker that owns its own line, and is actually closed, delimits our
  // block. Matching the bare string anywhere would let the same words inside
  // the organiser's own prose swallow everything after them.
  // Google may store and return the description with <br> instead of newlines.
  // Treat a line break as either, so a block written once is still recognised.
  const BR = "(?:<br\\s*/?>|\\r?\\n|^|$)";
  // Look-behind rather than consuming: consuming the preceding <br> left it in
  // `before`, so the description grew a blank line on every sync.
  const opener = new RegExp(`(?<=${BR})[ \t]*--- CheatMeet ---[ \t]*(?=${BR})`, "g");
  const closer = new RegExp(`[ \t]*--- Ende CheatMeet ---[ \t]*(?=${BR})`);
  let region: { start: number; end: number } | null = null;
  for (const match of existing.matchAll(opener)) {
    const from = match.index ?? 0;
    const rest = existing.slice(from + match[0].length);
    const close = closer.exec(rest);
    if (close)
      region = {
        start: from,
        end: from + match[0].length + (close.index ?? 0) + close[0].length,
      };
  }
  if (!region) {
    // No closed block of ours: append rather than guess where one ends.
    const kept = existing.replace(/(?:\s|<br\s*\/?>)+$/i, "");
    return `${kept ? `${kept}\n\n` : ""}${fresh}`;
  }
  // trimEnd cannot strip a <br>, so the separator would accumulate one per
  // sync round when Google hands the description back as HTML.
  const trimBreaksEnd = (text: string) =>
    text.replace(/(?:\s|<br\s*\/?>)+$/i, "");
  const trimBreaksStart = (text: string) =>
    text.replace(/^(?:\s|<br\s*\/?>)+/i, "");
  const before = trimBreaksEnd(existing.slice(0, region.start));
  const after = trimBreaksStart(existing.slice(region.end));
  return [before, fresh, after].filter(Boolean).join("\n\n");
}

export function summaryBlock({
  summary,
  todos,
  link,
}: {
  summary: string;
  todos: string[];
  link?: string;
}): string {
  const lines = [summary.trim()].filter(Boolean);
  if (todos.length) lines.push("", "Aufgaben:", ...todos.map((t) => `• ${t}`));
  if (link) lines.push("", `Bericht & Aufnahme: ${link}`);
  return lines.join("\n");
}

/** The current state of one event, so a patch can merge rather than replace. */
export async function getEvent(
  calendarId: string,
  id: string,
): Promise<CalendarEvent | null> {
  const data = await call(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
  );
  return toEvent(data, calendarId);
}

export const updateEventDescription = (
  event: { calendarId: string; id: string; description: string },
  block: string,
) =>
  call(
    `/calendars/${encodeURIComponent(event.calendarId)}/events/${encodeURIComponent(event.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        description: mergeDescription(event.description, block),
      }),
    },
  );

/** For a recording that belonged to no event: put the meeting on the calendar. */
export async function createEvent({
  title,
  startMs,
  endMs,
  block,
}: {
  title: string;
  startMs: number;
  endMs: number;
  block: string;
}): Promise<{ id: string; calendarId: string; htmlLink?: string }> {
  const data = await call("/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify({
      summary: title,
      description: mergeDescription("", block),
      start: { dateTime: new Date(startMs).toISOString() },
      // A zero-length event is invalid; a recording always occupied some time.
      end: { dateTime: new Date(Math.max(endMs, startMs + 60_000)).toISOString() },
      transparency: "transparent",
    }),
  });
  return { id: data.id, calendarId: "primary", htmlLink: data.htmlLink };
}
