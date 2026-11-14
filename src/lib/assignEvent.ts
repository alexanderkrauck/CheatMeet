import { getLocal } from "./local";
import { saveReport, uid } from "./reports";
import { calendarReportBlock, syncReportToCalendar } from "./calendarSync";
import { errorMessage } from "./session";
import type { CalendarEvent } from "./calendar";
import { hasAnyCalendarGrant } from "./calendar";
import type { ReportData } from "../types";
import { pendingArchive } from "./reportEdits";
import { reportIndexCollection } from "../../shared/storage";

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
  event: Pick<CalendarEvent, "id" | "calendarId" | "htmlLink"> &
    Partial<Pick<CalendarEvent, "provider" | "connectionId">>,
  { writeBack = true, index }: { writeBack?: boolean; index?: "reports" | "meetings" } = {},
): Promise<AssignOutcome> {
  const warnings: string[] = [];
  const changedAccount = (): AssignOutcome => ({
    assigned: false,
    warnings: ["Das angemeldete Konto wurde gewechselt. Es wurde nichts gespeichert."],
  });
  if (uid() !== owner) return changedAccount();
  // The list row is a projection; saving it would write the transcript turns
  // out of existence. Only the stored report may be written back.
  const stored = await getLocal(owner, reportId, index ? { index } : undefined);
  if (uid() !== owner) return changedAccount();
  if (!stored)
    return {
      assigned: false,
      warnings: ["Der Bericht ist auf diesem Gerät nicht mehr vorhanden."],
    };

  const link = {
    calendarEventId: event.id,
    calendarId: event.calendarId,
    calendarProvider: event.provider || "google",
    calendarConnectionId: event.connectionId,
    calendarLink: event.htmlLink,
    calendarError: undefined,
    calendarSyncedAt: undefined,
  } as Partial<ReportData>;
  let patch: Partial<ReportData> = link;

  if (writeBack) {
    if (!hasAnyCalendarGrant(event.provider || "google", event.connectionId))
      warnings.push(
        "Die Notizen konnten nicht geschrieben werden: Der Kalender ist nicht freigegeben.",
      );
    else
      try {
        // create:false — this assigns to an event that exists. Creating one
        // here would put a duplicate on the calendar next to the target.
        const result = await syncReportToCalendar(
          { ...stored.report, ...link },
          {
            create: false,
          },
        );
        // A vanished event comes back as a patch that CLEARS the link rather
        // than as a throw. Persisting that would save an error about a link
        // that never existed, and report success for an assignment that did
        // not happen.
        if (!result.calendarEventId && "calendarEventId" in result)
          return {
            assigned: false,
            warnings: [
              "Dieser Termin existiert nicht mehr im Kalender. Bitte die Ansicht neu laden.",
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
  const fresh = await getLocal(owner, reportId, { index: reportIndexCollection(stored.report) });
  // A sign-out mid-flight must not write this account's report into the next
  // one: saveReport resolves the account itself.
  if (uid() !== owner) return changedAccount();

  // saveReport returns a warning rather than throwing: a local write must never
  // be reported as a cloud save.
  const latest = fresh?.report ?? stored.report;
  if (patch.calendarSyncedAt && calendarReportBlock(latest) !== calendarReportBlock(stored.report)) {
    patch = { ...patch, calendarSyncedAt: undefined };
    warnings.push("Der Bericht wurde während der Zuordnung geändert. Bitte „Kalender aktualisieren“ ausführen, damit die aktuellen Notizen übernommen werden.");
  }
  const warning = await saveReport(
    { ...latest, ...patch, ...pendingArchive(latest) },
    { expectedUpdatedAt: latest.updatedAt ?? null },
  );
  if (warning) warnings.push(warning);
  if (
    latest.driveReportId ||
    (latest.home?.provider === "microsoft" && latest.home.reportId)
  )
    warnings.push(
      "Die Terminzuordnung ist auf diesem Gerät gespeichert, aber im Dateiarchiv noch nicht aktualisiert. Bitte den Bericht öffnen und die Änderungen im gewählten Speicher sichern, bevor du ihn aus dem Archiv wiederherstellst.",
    );
  return { assigned: true, warnings };
}
