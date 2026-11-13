/** Choose the last closed opener, never an orphan before a later valid block. */
function replaceClosed(
  existing: string,
  fresh: string,
  opener: RegExp,
  closer: RegExp,
): string | null {
  let region: { start: number; end: number } | undefined;
  for (const match of existing.matchAll(opener)) {
    const from = match.index + match[0].length;
    const close = closer.exec(existing.slice(from));
    if (close)
      region = {
        start: match.index,
        end: from + close.index + close[0].length,
      };
  }
  return region
    ? existing.slice(0, region.start) + fresh + existing.slice(region.end)
    : null;
}

/** Preserve every byte outside our bounded block, especially the Teams blob. */
export function mergeMicrosoftBody(
  existing: string,
  block: string,
  bodyType: "html" | "text",
): string {
  if (bodyType === "text") {
    const fresh = `--- CheatMeet ---\n${block}\n--- Ende CheatMeet ---`;
    const replaced = replaceClosed(
      existing,
      fresh,
      /^--- CheatMeet ---\r?$/gm,
      /^--- Ende CheatMeet ---(?=\r?\n|$)/m,
    );
    return replaced ?? `${existing}${existing ? "\n\n" : ""}${fresh}`;
  }
  const escaped = block
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r?\n/g, "<br>");
  const fresh = `<p>--- CheatMeet ---</p><p>${escaped}</p><p>--- Ende CheatMeet ---</p>`;
  const replaced = replaceClosed(
    existing,
    fresh,
    /<p(?:\s[^>]*)?>\s*--- CheatMeet ---\s*<\/p>/gi,
    /<p(?:\s[^>]*)?>\s*--- Ende CheatMeet ---\s*<\/p>/i,
  );
  if (replaced !== null) return replaced;
  const end = /<\/body\s*>/i.exec(existing);
  const index = end?.index ?? existing.length;
  return existing.slice(0, index) + fresh + existing.slice(index);
}

export interface GraphCalendarEvent {
  id?: string;
  subject?: string;
  type?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeetingUrl?: string;
  webLink?: string;
  originalStartTimeZone?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  attendees?: {
    type?: string;
    emailAddress?: { name?: string; address?: string };
  }[];
  body?: { contentType?: string; content?: string };
  "@odata.etag"?: string;
}

/** Graph requests use UTC; an offset-less UTC value must not use browser time. */
export function graphEventToCalendarEvent(
  raw: GraphCalendarEvent,
  calendarId: string,
  connectionId: string,
) {
  const time = (slot: GraphCalendarEvent["start"]) => {
    const value = slot?.dateTime;
    if (!value) return NaN;
    if (raw.isAllDay)
      return new Date(`${value.slice(0, 10)}T00:00:00`).getTime();
    if (slot?.timeZone !== "UTC" && !/(Z|[+-]\d\d:\d\d)$/i.test(value))
      return NaN;
    return Date.parse(value + (/(Z|[+-]\d\d:\d\d)$/i.test(value) ? "" : "Z"));
  };
  const startMs = time(raw.start);
  if (
    !raw.id ||
    raw.isCancelled ||
    raw.type === "seriesMaster" ||
    !Number.isFinite(startMs)
  )
    return null;
  return {
    id: raw.id,
    calendarId,
    provider: "microsoft" as const,
    connectionId,
    title: raw.subject?.trim() || "Ohne Titel",
    startMs,
    endMs: Number.isFinite(time(raw.end)) ? time(raw.end) : startMs,
    allDay: !!raw.isAllDay,
    attendees: (raw.attendees || [])
      .filter((a) => a.type !== "resource")
      .map((a) =>
        (
          a.emailAddress?.name ||
          a.emailAddress?.address?.split("@")[0]?.replace(/[._]+/g, " ") ||
          ""
        ).trim(),
      )
      .filter(Boolean),
    conference: !!(raw.isOnlineMeeting || raw.onlineMeetingUrl),
    kind: "default",
    description: raw.body?.content || "",
    bodyType:
      raw.body?.contentType?.toLowerCase() === "html"
        ? ("html" as const)
        : ("text" as const),
    etag: raw["@odata.etag"],
    htmlLink: raw.webLink,
  };
}
