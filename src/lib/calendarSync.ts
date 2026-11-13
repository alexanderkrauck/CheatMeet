import {
  createEvent,
  hasAnyCalendarGrant,
  getEvent,
  isEventGone,
  summaryBlock,
  updateEventDescription,
  type CalendarEvent,
} from "./calendar";
import { formatTodoLine } from "../../shared/analysis";
import { savedCalendarProvider } from "./providerSettings";
import type { ReportData } from "../types";
import { auth } from "./firebase";

const driveLink = (id?: string) =>
  id
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`
    : undefined;

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
  const owner = auth.currentUser?.uid;
  if (!owner) throw new Error("Bitte zuerst anmelden.");
  const checkOwner = () => {
    if (auth.currentUser?.uid !== owner)
      throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  const linked = !!(report.calendarEventId && report.calendarId);
  const provider = linked
    ? report.calendarProvider || "google"
    : savedCalendarProvider();
  if (!hasAnyCalendarGrant(provider))
    throw new Error("Der Kalender ist nicht freigegeben.");
  if (linked && provider === "microsoft" && !report.calendarConnectionId)
    throw new Error(
      "Die Microsoft-Kalender-Verbindung fehlt. Bitte den Termin erneut zuordnen.",
    );
  const block = summaryBlock({
    summary: report.summary,
    todos: (report.todos || []).map(formatTodoLine),
    link:
      report.home?.provider === "microsoft"
        ? report.home.webUrl
        : driveLink(report.driveFolderId),
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
      current = await getEvent(
        report.calendarId,
        report.calendarEventId,
        provider,
        report.calendarConnectionId,
      );
    } catch (error) {
      if (!isEventGone(error)) throw error;
      current = null;
    }
    checkOwner();
    if (!current)
      // Returning the cleared link makes the message true: the caller persists
      // it, so the next attempt creates a fresh event instead of failing again.
      return {
        calendarEventId: undefined,
        calendarId: undefined,
        calendarProvider: undefined,
        calendarConnectionId: undefined,
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
        provider,
        connectionId: report.calendarConnectionId || current.connectionId,
        bodyType: current.bodyType,
        etag: current.etag,
      },
      block,
    );
    checkOwner();
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
    provider,
    title: report.title || "Meeting",
    startMs,
    endMs: startMs + (report.durationMs || 0),
    block,
  });
  checkOwner();
  return {
    calendarProvider: created.calendarProvider,
    calendarConnectionId: created.calendarConnectionId,
    calendarEventId: created.id,
    calendarId: created.calendarId,
    calendarLink: created.htmlLink,
    calendarSyncedAt: syncedAt,
    calendarError: undefined,
  };
}
