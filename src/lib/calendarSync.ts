import {
  createEvent,
  hasAnyCalendarGrant,
  getEvent,
  isEventGone,
  updateEventDescription,
  type CalendarEvent,
} from "./calendar";
import { calendarReportBlock } from "../../shared/calendarNotes";
import { loadProviderSettings } from "./providerSettings";
import type { ReportData } from "../types";
import { auth } from "./firebase";

export { calendarReportBlock } from "../../shared/calendarNotes";

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
  // The automatic path must not resolve defaults or create an unrequested event.
  if (!linked && !create)
    return {
      calendarError:
        "Diesem Meeting ist kein Termin zugeordnet. Über „In den Kalender“ kannst du einen anlegen.",
    };
  const defaults = linked ? null : await loadProviderSettings();
  checkOwner();
  const provider = linked
    ? report.calendarProvider || "google"
    : defaults!.calendarProvider;
  const connectionId = linked
    ? report.calendarConnectionId
    : defaults?.calendarConnectionId;
  if (!hasAnyCalendarGrant(provider, connectionId))
    throw new Error(
      "Der Kalender ist nicht freigegeben. Bitte die gewählte Verbindung in den Einstellungen prüfen.",
    );
  if (linked && provider === "microsoft" && !report.calendarConnectionId)
    throw new Error(
      "Die Microsoft-Kalender-Verbindung fehlt. Bitte den Termin erneut zuordnen.",
    );
  const block = calendarReportBlock(report);
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

  const startMs = Date.parse(report.date) || Date.now();
  const created = await createEvent({
    provider,
    connectionId,
    calendarId: defaults?.calendarId || "primary",
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
