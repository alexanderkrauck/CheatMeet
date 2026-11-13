import { auth } from "./firebase";
import { microsoftRequest, ensureMicrosoftToken } from "./microsoft";
import { CalendarError, type CalendarEvent } from "./calendar";
import {
  graphEventToCalendarEvent,
  mergeMicrosoftBody,
  type GraphCalendarEvent,
} from "../../shared/microsoftCalendar";

const PREFER =
  'IdType="ImmutableId", outlook.timezone="UTC", outlook.body-content-type="html"';

async function call(
  path: string,
  init: RequestInit,
  connectionId: string,
): Promise<Response> {
  try {
    return await microsoftRequest(
      path,
      {
        ...init,
        headers: {
          Prefer: PREFER,
          "Content-Type": "application/json",
          ...init.headers,
        },
      },
      connectionId,
    );
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status)
      throw new CalendarError(
        status === 412
          ? "Der Termin wurde inzwischen geändert. Bitte erneut versuchen."
          : status === 404 || status === 410
            ? "Der Kalendereintrag existiert nicht mehr."
            : (error as Error).message,
        status,
      );
    throw error;
  }
}

/** A multi-page operation must not re-pin to a new owner between requests. */
function calendarOwner() {
  const owner = auth.currentUser?.uid;
  if (!owner) throw new Error("Bitte zuerst anmelden.");
  const check = () => {
    if (auth.currentUser?.uid !== owner)
      throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  const request = async (
    path: string,
    init: RequestInit,
    connectionId: string,
  ) => {
    check();
    try {
      return await call(path, init, connectionId);
    } finally {
      check();
    }
  };
  const read = async (
    path: string,
    init: RequestInit,
    connectionId: string,
  ) => {
    const response = await request(path, init, connectionId);
    const data = await response.json();
    check();
    return { data, response };
  };
  return { request, read, check };
}

function eventPath(calendarId: string, id: string): string {
  return calendarId === "primary"
    ? `/me/events/${encodeURIComponent(id)}`
    : `/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`;
}

/** UTC shifts all-day midnight east of Greenwich into the previous date.
 * Ask Graph for that event in its original zone rather than maintaining an
 * incomplete Windows/IANA timezone table in the browser. */
async function normalize(
  raw: GraphCalendarEvent,
  calendarId: string,
  connectionId: string,
  operation: ReturnType<typeof calendarOwner>,
): Promise<CalendarEvent | null> {
  const zone = raw.originalStartTimeZone;
  if (
    raw.id &&
    raw.isAllDay &&
    zone &&
    zone !== "UTC" &&
    raw.start?.timeZone === "UTC"
  ) {
    if (!/^[A-Za-z0-9_ +\-/:().]+$/.test(zone) || zone.startsWith("tzone:"))
      throw new Error(
        "Die ursprüngliche Zeitzone des Ganztagstermins wird nicht unterstützt.",
      );
    const { data, response } = await operation.read(
      eventPath(calendarId, raw.id),
      {
        headers: {
          Prefer: `IdType="ImmutableId", outlook.timezone="${zone}", outlook.body-content-type="html"`,
        },
      },
      connectionId,
    );
    raw = data as GraphCalendarEvent;
    raw["@odata.etag"] ||= response.headers.get("ETag") || undefined;
  }
  operation.check();
  return graphEventToCalendarEvent(raw, calendarId, connectionId);
}

export async function getMicrosoftEvent(
  calendarId: string,
  id: string,
  connectionId?: string,
): Promise<CalendarEvent | null> {
  const operation = calendarOwner();
  const pinned = connectionId || (await ensureMicrosoftToken()).connectionId;
  const { data, response } = await operation.read(
    eventPath(calendarId, id),
    {},
    pinned,
  );
  const raw = data as GraphCalendarEvent;
  raw["@odata.etag"] ||= response.headers.get("ETag") || undefined;
  return normalize(raw, calendarId, pinned, operation);
}

export async function updateMicrosoftEventDescription(
  event: Pick<
    CalendarEvent,
    "calendarId" | "id" | "description" | "connectionId" | "bodyType" | "etag"
  >,
  block: string,
): Promise<void> {
  if (!event.etag)
    throw new Error(
      "Die Version des Termins fehlt. Bitte den Termin erneut laden.",
    );
  if (!event.connectionId)
    throw new Error(
      "Die Microsoft-Kalenderverbindung fehlt. Bitte den Termin erneut zuordnen.",
    );
  const operation = calendarOwner();
  const bodyType = event.bodyType || "text";
  await operation.request(
    eventPath(event.calendarId, event.id),
    {
      method: "PATCH",
      headers: { "If-Match": event.etag },
      body: JSON.stringify({
        body: {
          contentType: bodyType === "html" ? "HTML" : "Text",
          content: mergeMicrosoftBody(event.description, block, bodyType),
        },
      }),
    },
    event.connectionId,
  );
}

export async function createMicrosoftEvent(input: {
  title: string;
  startMs: number;
  endMs: number;
  block: string;
  connectionId?: string;
}) {
  const operation = calendarOwner();
  const pinned =
    input.connectionId || (await ensureMicrosoftToken()).connectionId;
  const { data } = await operation.read(
    "/me/events",
    {
      method: "POST",
      body: JSON.stringify({
        subject: input.title,
        body: {
          contentType: "HTML",
          content: mergeMicrosoftBody("", input.block, "html"),
        },
        start: {
          dateTime: new Date(input.startMs).toISOString(),
          timeZone: "UTC",
        },
        end: {
          dateTime: new Date(
            Math.max(input.endMs, input.startMs + 60_000),
          ).toISOString(),
          timeZone: "UTC",
        },
        showAs: "free",
      }),
    },
    pinned,
  );
  if (!data.id)
    throw new Error(
      "Outlook hat keine Termin-ID zurückgegeben. Bitte den Kalender vor einem neuen Versuch prüfen.",
    );
  return {
    id: data.id as string,
    calendarId: "primary",
    htmlLink: data.webLink as string | undefined,
    calendarProvider: "microsoft" as const,
    calendarConnectionId: pinned,
  };
}

/** calendarView, unlike /events, expands recurring occurrences and exceptions. */
export async function microsoftEventsBetween(
  fromMs: number,
  toMs: number,
  budget = 250,
  connectionId?: string,
): Promise<CalendarEvent[]> {
  if (budget <= 0) return [];
  const operation = calendarOwner();
  const pinned = connectionId || (await ensureMicrosoftToken()).connectionId;
  const params = new URLSearchParams({
    startDateTime: new Date(fromMs).toISOString(),
    endDateTime: new Date(toMs).toISOString(),
    $orderby: "start/dateTime",
    $top: String(Math.min(100, budget)),
  });
  let next: string | undefined = `/me/calendarView?${params}`;
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  const pages = new Set<string>();
  while (next && events.length < budget) {
    if (pages.has(next))
      throw new Error(
        "Outlook Kalender lieferte eine wiederholte Ergebnisseite. Bitte erneut versuchen.",
      );
    pages.add(next);
    const { data } = await operation.read(next, {}, pinned);
    for (const raw of (data.value || []) as GraphCalendarEvent[]) {
      const event = await normalize(raw, "primary", pinned, operation);
      if (event && !seen.has(event.id)) {
        seen.add(event.id);
        events.push(event);
      }
      if (events.length >= budget) break;
    }
    next = data["@odata.nextLink"];
  }
  operation.check();
  return events.sort((a, b) => a.startMs - b.startMs);
}
