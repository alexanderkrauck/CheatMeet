import {
  createEvent,
  getEvent,
  isEventGone,
  summaryBlock,
  updateEventDescription,
  type CalendarEvent,
} from "./calendar";
import { formatTodoLine } from "../../shared/analysis";
import { hasCalendarGrant } from "./session";
import type { ReportData } from "../types";

const driveLink = (id?: string) =>
  id ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}` : undefined;

/**
 * Puts the finished meeting back where it was planned.
 *
 * Two directions, as asked for: a recording that was matched to an event
 * updates that event's notes, and one that belonged to nothing gets an event
 * created for it at the time it actually happened. Returns the fields to
 * persist rather than saving itself, so the caller keeps the single save path.
 */
export async function syncReportToCalendar(
  report: ReportData,
  { create = true }: { create?: boolean } = {},
): Promise<Partial<ReportData>> {
  if (!hasCalendarGrant()) throw new Error("Der Kalender ist nicht freigegeben.");
  const block = summaryBlock({
    summary: report.summary,
    todos: (report.todos || []).map(formatTodoLine),
    link: driveLink(report.driveFolderId),
  });
  const syncedAt = new Date().toISOString();

  if (report.calendarEventId && report.calendarId) {
    // Read first. Patching a description means sending the whole field, so
    // without the current text this would delete whatever the organiser wrote.
    // Only a genuine deletion drops the link. A timeout, a throttle or an
    // expired token must propagate, or one bad minute permanently unlinks a
    // meeting from its event and says the event was deleted.
    let current: CalendarEvent | null;
    try {
      current = await getEvent(report.calendarId, report.calendarEventId);
    } catch (error) {
      if (!isEventGone(error)) throw error;
      current = null;
    }
    if (!current)
      // Returning the cleared link makes the message true: the caller persists
      // it, so the next attempt creates a fresh event instead of failing again.
      return {
        calendarEventId: undefined,
        calendarId: undefined,
        calendarLink: undefined,
        calendarSyncedAt: undefined,
        calendarError:
          "Der verknüpfte Kalendereintrag existiert nicht mehr. Die Verknüpfung wurde entfernt.",
      } as Partial<ReportData>;
    await updateEventDescription(
      {
        calendarId: report.calendarId,
        id: report.calendarEventId,
        description: current.description,
      },
      block,
    );
    return {
      calendarSyncedAt: syncedAt,
      calendarLink: current.htmlLink,
      calendarError: undefined,
    };
  }

  // Creating is the destructive-ish half: an unmatched recording would put a
  // new event on the calendar every time. The automatic path never does it.
  if (!create)
    return {
      calendarError:
        "Diesem Meeting ist kein Termin zugeordnet. Über „In den Kalender“ kannst du einen anlegen.",
    } as Partial<ReportData>;

  const startMs = Date.parse(report.date) || Date.now();
  const created = await createEvent({
    title: report.title || "Meeting",
    startMs,
    endMs: startMs + (report.durationMs || 0),
    block,
  });
  return {
    calendarEventId: created.id,
    calendarId: created.calendarId,
    calendarLink: created.htmlLink,
    calendarSyncedAt: syncedAt,
    calendarError: undefined,
  };
}
