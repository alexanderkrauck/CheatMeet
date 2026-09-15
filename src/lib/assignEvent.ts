import { getLocal } from "./local";
import { saveReport } from "./reports";
import { syncReportToCalendar } from "./calendarSync";
import { errorMessage, hasCalendarGrant } from "./session";
import type { CalendarEvent } from "./calendar";
import type { ReportData } from "../types";

export interface AssignOutcome {
  /** Whether the link was persisted. False leaves the dialog open to retry. */
  assigned: boolean;
  warnings: string[];
}

/**
 * Attaches a finished recording to the meeting it was actually held for.
 *
 * Matching used to be possible only while recording, so a report that was
 * started without picking an event could never be connected to one afterwards
 * — and the calendar write-back, which needs that link, stayed unavailable to
 * it forever.
 *
 * The write-back is attempted before the save so the whole result lands in one
 * write, the way the pipeline does it. A calendar that refuses is a warning,
 * not a failure: the link itself is still worth keeping, and the report page's
 * "In den Kalender" can push the notes later.
 */
export async function assignReportToEvent(
  owner: string,
  reportId: string,
  event: Pick<CalendarEvent, "id" | "calendarId" | "htmlLink">,
  { writeBack = true }: { writeBack?: boolean } = {},
): Promise<AssignOutcome> {
  const warnings: string[] = [];
  // The list row is a projection; saving it would write the transcript turns
  // out of existence. Only the stored report may be written back.
  const stored = await getLocal(owner, reportId);
  if (!stored)
    return {
      assigned: false,
      warnings: ["Der Bericht ist auf diesem Gerät nicht mehr vorhanden."],
    };

  let report: ReportData = {
    ...stored.report,
    calendarEventId: event.id,
    calendarId: event.calendarId,
    calendarLink: event.htmlLink,
    calendarError: undefined,
    calendarSyncedAt: undefined,
  };

  if (writeBack && hasCalendarGrant()) {
    try {
      // create:false — this is an assignment to an event that exists. Creating
      // one here would put a duplicate on the calendar next to the target.
      report = { ...report, ...(await syncReportToCalendar(report, { create: false })) };
      if (report.calendarError) warnings.push(report.calendarError);
    } catch (cause) {
      warnings.push(
        `Der Termin konnte nicht aktualisiert werden: ${errorMessage(cause)}`,
      );
    }
  }

  // saveReport returns a warning rather than throwing: a local write must never
  // be reported as a cloud save.
  const warning = await saveReport(report);
  if (warning) warnings.push(warning);
  return { assigned: true, warnings };
}
