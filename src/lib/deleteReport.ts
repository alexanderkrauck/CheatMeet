import { deleteDoc, doc } from "firebase/firestore";
import { db } from "./firebase";
import { trashDriveFile } from "./drive";
import { deleteDraft, dropLocal } from "./local";
import { ensureDriveToken } from "./session";
import type { ReportData } from "../types";

export interface DeleteOutcome {
  /** False only when nothing was removed and the delete is still retryable. */
  removed: boolean;
  /** What could not be removed, named. Empty means everything is gone. */
  warnings: string[];
}

/**
 * Removes a meeting from all three stores that can hold it.
 *
 * They fail independently, so this reports what survived rather than
 * pretending: a delete that silently leaves the audio and the report in Drive
 * would be a lie, and the user is the one who has to know.
 *
 * Order matters. Drive goes first because it is the only copy of the audio and
 * the only step that can genuinely fail; the local copy goes last so a partial
 * failure still leaves something to retry from.
 */
export async function deleteReport(
  uid: string,
  report: ReportData,
  { fromDrive }: { fromDrive: boolean },
): Promise<DeleteOutcome> {
  const warnings: string[] = [];

  if (fromDrive) {
    if (!report.driveFolderId)
      warnings.push(
        "Für dieses Meeting ist kein Drive-Ordner bekannt; in Drive wurde nichts gelöscht.",
      );
    else
      try {
        const token = await ensureDriveToken();
        if (!token)
          warnings.push(
            "Google Drive ist nicht verbunden. Die Dateien liegen weiterhin dort.",
          );
        else await trashDriveFile(report.driveFolderId, token);
      } catch (cause) {
        warnings.push(
          cause instanceof Error
            ? cause.message
            : "Der Drive-Ordner konnte nicht gelöscht werden.",
        );
      }
    // Keeping the local copy is what makes a retry possible: without it the
    // folder id is gone and the Drive files can never be reached again.
    if (warnings.length) return { removed: false, warnings };
  }

  // Firestore's write promise does not settle while offline — it waits for the
  // backend to acknowledge. Unbounded, that hangs the confirmation dialog for
  // good. The mutation is persisted either way and flushes on reconnect, so a
  // timeout is reported as "later", not as a failure.
  let timer: ReturnType<typeof setTimeout>;
  const pending = deleteDoc(doc(db, "users", uid, "reports", report.id));
  pending.catch(() => {});
  try {
    await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 10_000);
      }),
    ]);
  } catch (cause) {
    warnings.push(
      (cause as Error)?.message === "timeout"
        ? "Der Cloud-Eintrag wird entfernt, sobald wieder eine Verbindung besteht."
        : "Der Eintrag in der Cloud konnte nicht entfernt werden und kann auf einem anderen Gerät wieder auftauchen.",
    );
  } finally {
    clearTimeout(timer!);
  }

  await deleteDraft(uid, report.id).catch(() => {});
  await dropLocal(uid, report.id);
  return { removed: true, warnings };
}
