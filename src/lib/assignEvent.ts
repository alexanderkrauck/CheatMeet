import { getLocal } from "./local";
import { saveReport, uid } from "./reports";
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

  const link = {
    calendarEventId: event.id,
    calendarId: event.calendarId,
    calendarLink: event.htmlLink,
    calendarError: undefined,
    calendarSyncedAt: undefined,
  } as Partial<ReportData>;
  let patch: Partial<ReportData> = link;

  if (writeBack) {
    if (!hasCalendarGrant())
      warnings.push(
        "Die Notizen konnten nicht geschrieben werden: Der Kalender ist nicht freigegeben.",
      );
    else
      try {
        // create:false — this assigns to an event that exists. Creating one
        // here would put a duplicate on the calendar next to the target.
        const result = await syncReportToCalendar({ ...stored.report, ...link }, {
          create: false,
        });
        // A vanished event comes back as a patch that CLEARS the link rather
        // than as a throw. Persisting that would save an error about a link
        // that never existed, and report success for an assignment that did
        // not happen.
        if (!result.calendarEventId && "calendarEventId" in result)
          return {
            assigned: false,
            warnings: [
              "Dieser Termin existiert nicht mehr im Google Kalender. Bitte die Ansicht neu laden.",
            ],
          };
        patch = { ...link, ...result };
        if (patch.calendarError) warnings.push(patch.calendarError);
      } catch (cause) {
        warnings.push(
          `Der Termin konnte nicht aktualisiert werden: ${errorMessage(cause)}`,
        );
      }
  }

  // Re-read after the network round trip. The calendar call can take 30s, and
  // writing the snapshot taken before it would silently undo anything saved in
  // the meantime — a speaker rename, a ticked to-do.
  const fresh = await getLocal(owner, reportId);
  // A sign-out mid-flight must not write this account's report into the next
  // one: saveReport resolves the account itself.
  if (uid() !== owner)
    return {
      assigned: false,
      warnings: ["Das Google-Konto wurde gewechselt. Es wurde nichts gespeichert."],
    };

  // saveReport returns a warning rather than throwing: a local write must never
  // be reported as a cloud save.
  const warning = await saveReport({ ...(fresh?.report ?? stored.report), ...patch });
  if (warning) warnings.push(warning);
  return { assigned: true, warnings };
}
