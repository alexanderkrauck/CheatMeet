import {
  ensureDriveToken,
  hasCalendarGrant,
  subscribeDriveSession,
} from "./session";
import {
  savedCalendarProvider,
  hasMicrosoftCalendar,
  savedCalendarConnectionId,
  savedCalendarId,
  loadProviderSettings,
} from "./providerSettings";
import { cachedMicrosoftConnections } from "./microsoft";
import { auth } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import type { ServiceProvider } from "../../shared/storage";
import {
  microsoftEventsBetween,
  getMicrosoftEvent,
  updateMicrosoftEventDescription,
  createMicrosoftEvent,
  availableMicrosoftCalendars,
} from "./microsoftCalendar";

/** Grant for the selected calendar; storage home never selects a calendar. */
export function hasAnyCalendarGrant(
  provider: ServiceProvider = savedCalendarProvider(),
  connectionId = savedCalendarConnectionId(),
): boolean {
  return provider === "microsoft"
    ? hasMicrosoftCalendar(connectionId)
    : hasCalendarGrant();
}
export const calendarSelectionSnapshot = () =>
  `${auth.currentUser?.uid || ""}:${savedCalendarProvider()}:${savedCalendarConnectionId() || ""}:${savedCalendarId()}:${hasAnyCalendarGrant()}`;

function requireCalendarConnection(connectionId?: string): string {
  if (
    !connectionId ||
    !cachedMicrosoftConnections().some(
      (c) => c.connectionId === connectionId && c.calendar,
    )
  )
    throw new Error(
      "Das gewählte Outlook-Konto ist nicht verfügbar. Bitte die Kalenderverbindung in den Einstellungen auswählen oder erneut verbinden.",
    );
  return connectionId;
}
export function subscribeCalendar(listener: () => void): () => void {
  const drive = subscribeDriveSession(listener);
  const account = onAuthStateChanged(auth, listener);
  if (typeof window !== "undefined")
    window.addEventListener("cheatmeet:provider-settings", listener);
  return () => {
    drive();
    account();
    if (typeof window !== "undefined")
      window.removeEventListener("cheatmeet:provider-settings", listener);
  };
}

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
  error instanceof CalendarError &&
  (error.status === 404 || error.status === 410);

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  startMs: number;
  endMs: number;
  /** Google gives a date with no time; rendering it as 00:00 is a lie. */
  allDay: boolean;
  attendees: string[];
  /** A video link is the other tell that an entry is a meeting with people. */
  conference: boolean;
  /**
   * Google's own classification. A birthday, a working-location marker or a
   * ticket Gmail parsed out of a confirmation mail is never a meeting, and
   * guessing that from the title is guesswork the API already answers.
   */
  kind: string;
  description: string;
  htmlLink?: string;
  provider?: import("../../shared/storage").ServiceProvider;
  connectionId?: string;
  bodyType?: "html" | "text";
  etag?: string;
}

interface RawEvent {
  id?: string;
  etag?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  status?: string;
  eventType?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: unknown[] };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: {
    displayName?: string;
    email?: string;
    self?: boolean;
    resource?: boolean;
  }[];
}

/** The part of an attendee a person would recognise. */
const attendeeName = (a: NonNullable<RawEvent["attendees"]>[number]): string =>
  (
    a.displayName ||
    a.email?.split("@")[0]?.replace(/[._]+/g, " ") ||
    ""
  ).trim();

const time = (slot?: { dateTime?: string; date?: string }) => {
  if (slot?.dateTime) return Date.parse(slot.dateTime) || 0;
  // "2026-09-14" parses as UTC midnight, which is the previous day west of UTC.
  if (slot?.date) return new Date(`${slot.date}T00:00:00`).getTime() || 0;
  return 0;
};

export function toEvent(
  raw: RawEvent,
  calendarId: string,
): CalendarEvent | null {
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
    conference: Boolean(
      raw.hangoutLink || raw.conferenceData?.entryPoints?.length,
    ),
    kind: raw.eventType || "default",
    description: raw.description || "",
    htmlLink: raw.htmlLink,
    etag: raw.etag,
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
    if (response.status === 412)
      throw fail(
        "Der Termin wurde inzwischen geändert. Bitte erneut laden und die Ergänzung erneut versuchen.",
      );
    if (response.status === 404 || response.status === 410)
      throw fail("Der Kalendereintrag existiert nicht mehr.");
    throw fail(`Google Kalender: Anfrage fehlgeschlagen (${response.status}).`);
  }
  return response.json();
}

/** Array-compatible API; completeness is metadata, not an invented empty answer. */
export type CalendarEvents = CalendarEvent[] & { truncated?: boolean };
export interface CalendarSelection {
  provider: ServiceProvider;
  connectionId?: string;
  calendarId?: string;
}
export function calendarResult(
  events: CalendarEvent[],
  truncated = false,
): CalendarEvents {
  Object.defineProperty(events, "truncated", {
    value: truncated,
    enumerable: false,
  });
  return events;
}
const EVENT_BUDGET = 250;
const PAGE_SIZE = 100;

async function resolveSelection(
  selection?: CalendarSelection,
): Promise<CalendarSelection> {
  if (selection) return selection;
  const defaults = await loadProviderSettings();
  return {
    provider: defaults.calendarProvider,
    connectionId: defaults.calendarConnectionId || undefined,
    calendarId: defaults.calendarId,
  };
}

export async function eventsBetween(
  fromMs: number,
  toMs: number,
  budget = EVENT_BUDGET,
  selection?: CalendarSelection,
): Promise<CalendarEvents> {
  if (budget <= 0) return calendarResult([]);
  const owner = auth.currentUser?.uid;
  const target = await resolveSelection(selection);
  if (auth.currentUser?.uid !== owner)
    throw new Error("Das angemeldete Konto hat sich geändert.");
  const calendarId = target.calendarId || "primary";
  if (target.provider === "microsoft") {
    const connectionId = requireCalendarConnection(target.connectionId);
    return microsoftEventsBetween(
      fromMs,
      toMs,
      budget,
      connectionId,
      calendarId,
    );
  }
  if (!hasAnyCalendarGrant("google")) return calendarResult([]);
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let requests = 0;
  let remainder = false;
  do {
    const params = new URLSearchParams({
      timeMin: new Date(fromMs).toISOString(),
      timeMax: new Date(toMs).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(PAGE_SIZE, budget - events.length)),
      ...(pageToken ? { pageToken } : {}),
    });
    if (auth.currentUser?.uid !== owner)
      throw new Error("Das angemeldete Konto hat sich geändert.");
    const data = await call(
      `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    );
    if (auth.currentUser?.uid !== owner)
      throw new Error("Das angemeldete Konto hat sich geändert.");
    requests++;
    const items = (data.items || []) as RawEvent[];
    for (const [index, raw] of items.entries()) {
      const event = toEvent(raw, calendarId);
      if (event && !seen.has(event.id)) {
        events.push(event);
        seen.add(event.id);
      }
      if (events.length >= budget) {
        remainder = index < items.length - 1;
        break;
      }
    }
    pageToken = data.nextPageToken;
  } while (
    pageToken &&
    events.length < budget &&
    requests < Math.max(3, Math.ceil(budget / PAGE_SIZE))
  );
  return calendarResult(events, remainder || !!pageToken);
}

/** What you are plausibly in right now — the record screen's question. */
export const eventsAround = (
  atMs: number,
  windowMs = 3 * 60 * 60 * 1000,
  selection?: CalendarSelection,
) => eventsBetween(atMs - windowMs, atMs + windowMs, 50, selection);

/** Calendar IDs come from the actual provider; never synthesize an Outlook account. */
export async function availableCalendars(
  provider: ServiceProvider,
  connectionId?: string,
): Promise<{ id: string; name: string }[]> {
  const owner = auth.currentUser?.uid;
  if (!owner) throw new Error("Bitte zuerst anmelden.");
  const checkOwner = () => {
    if (auth.currentUser?.uid !== owner)
      throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  if (provider === "microsoft") {
    const pinned =
      connectionId ||
      (await loadProviderSettings()).calendarConnectionId ||
      undefined;
    checkOwner();
    const calendars = await availableMicrosoftCalendars(
      requireCalendarConnection(pinned),
    );
    checkOwner();
    return calendars;
  }
  const calendars: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({
      maxResults: "100",
      ...(pageToken ? { pageToken } : {}),
    });
    checkOwner();
    const data = await call(`/users/me/calendarList?${params}`);
    checkOwner();
    for (const item of data.items || [])
      if (
        typeof item.id === "string" &&
        !item.deleted &&
        !calendars.some((c) => c.id === item.id)
      )
        calendars.push({
          id: item.id,
          name:
            typeof item.summaryOverride === "string"
              ? item.summaryOverride
              : typeof item.summary === "string"
                ? item.summary
                : item.id,
        });
    pageToken = data.nextPageToken;
    if (!pageToken) return calendars;
  }
  throw new Error(
    "Die Kalenderliste ist zu groß und wurde nicht vollständig geladen. Bitte beim Anbieter prüfen.",
  );
}

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
  const opener = new RegExp(
    `(?<=${BR})[ \t]*--- CheatMeet ---[ \t]*(?=${BR})`,
    "g",
  );
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

export { summaryBlock } from "../../shared/calendarNotes";

/** The current state of one event, so a patch can merge rather than replace. */
export async function getEvent(
  calendarId: string,
  id: string,
  provider: ServiceProvider = "google",
  connectionId?: string,
): Promise<CalendarEvent | null> {
  if (provider === "microsoft") {
    return getMicrosoftEvent(calendarId, id, connectionId);
  }
  const data = await call(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
  );
  return toEvent(data, calendarId);
}

export const updateEventDescription = async (
  event: Pick<
    CalendarEvent,
    | "calendarId"
    | "id"
    | "description"
    | "provider"
    | "connectionId"
    | "bodyType"
    | "etag"
  >,
  block: string,
) => {
  if (event.provider === "microsoft") {
    return updateMicrosoftEventDescription(event, block);
  }
  if (!event.etag)
    throw new Error(
      "Die Version des Termins fehlt. Bitte den Termin erneut laden.",
    );
  return call(
    `/calendars/${encodeURIComponent(event.calendarId)}/events/${encodeURIComponent(event.id)}`,
    {
      method: "PATCH",
      headers: { "If-Match": event.etag },
      body: JSON.stringify({
        description: mergeDescription(event.description, block),
      }),
    },
  );
};

/** For a recording that belonged to no event: put the meeting on the calendar. */
export async function createEvent({
  title,
  startMs,
  endMs,
  block,
  provider,
  connectionId,
  calendarId,
}: {
  title: string;
  startMs: number;
  endMs: number;
  block: string;
  provider?: ServiceProvider;
  connectionId?: string;
  calendarId?: string;
}): Promise<{
  id: string;
  calendarId: string;
  htmlLink?: string;
  calendarProvider: ServiceProvider;
  calendarConnectionId?: string;
}> {
  const owner = auth.currentUser?.uid;
  const defaults =
    !provider || !calendarId || (provider === "microsoft" && !connectionId)
      ? await loadProviderSettings()
      : null;
  if (auth.currentUser?.uid !== owner)
    throw new Error("Das angemeldete Konto hat sich geändert.");
  const targetProvider = provider || defaults!.calendarProvider;
  const targetCalendar =
    calendarId ||
    (targetProvider === defaults?.calendarProvider
      ? defaults.calendarId
      : "primary");
  if (targetProvider === "microsoft") {
    const pinned = requireCalendarConnection(
      connectionId ||
        (defaults?.calendarProvider === "microsoft"
          ? defaults.calendarConnectionId || undefined
          : undefined),
    );
    return createMicrosoftEvent({
      title,
      startMs,
      endMs,
      block,
      connectionId: pinned,
      calendarId: targetCalendar,
    });
  }
  const data = await call(
    `/calendars/${encodeURIComponent(targetCalendar)}/events`,
    {
      method: "POST",
      body: JSON.stringify({
        summary: title,
        description: mergeDescription("", block),
        start: { dateTime: new Date(startMs).toISOString() },
        // A zero-length event is invalid; a recording always occupied some time.
        end: {
          dateTime: new Date(Math.max(endMs, startMs + 60_000)).toISOString(),
        },
        transparency: "transparent",
      }),
    },
  );
  return {
    id: data.id,
    calendarId: targetCalendar,
    htmlLink: data.htmlLink,
    calendarProvider: "google",
  };
}
