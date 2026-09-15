import { doc, setDoc, collection, onSnapshot } from "firebase/firestore";
import { auth, db } from "./firebase";
import {
  putLocal,
  listLocal,
  getLocal,
  acceptRemoteReport,
  watchLocalReports,
} from "./local";
import type { ReportData } from "../types";
import { summarise, type ReportSummary } from "./meetingMeta";
import { projectReport } from "./reportProjection";
import { rememberPeople } from "./people";
import { errorMessage } from "./session";
export function uid() {
  if (!auth.currentUser) throw new Error("Bitte zuerst anmelden.");
  return auth.currentUser.uid;
}
let lastRevision = 0;
export async function saveReport(report: ReportData): Promise<string | null> {
  const user = uid();
  lastRevision = Math.max(
    Date.now(),
    lastRevision + 1,
    (Date.parse(report.updatedAt || "") || 0) + 1,
  );
  const next: ReportData = JSON.parse(
    JSON.stringify({
      ...report,
      updatedAt: new Date(lastRevision).toISOString(),
    }),
  );
  await putLocal(user, next);
  // Names the user typed, kept for the next meeting's suggestions. Never allowed
  // to fail a save.
  void rememberPeople(
    user,
    Object.values(next.speech?.speakerAliases || {}),
  ).catch(() => {});
  try {
    let timer: ReturnType<typeof setTimeout>;
    // Firestore is the cross-device index, not the archive: the transcript
    // lives in Drive and in IndexedDB. A long meeting would otherwise grow
    // past the document limit and silently stop syncing for good.
    const write = setDoc(
      doc(db, "users", user, "reports", report.id),
      JSON.parse(JSON.stringify(projectReport(next))),
    );
    // A late acknowledgement can still clear this revision, but never a newer edit.
    const acknowledged = write.then(() => acceptRemoteReport(user, next));
    await Promise.race([
      acknowledged,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Firebase antwortet nicht. Der Bericht ist lokal gespeichert; Cloud-Speichern erneut versuchen.",
              ),
            ),
          10000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}
/**
 * The list of meetings, as summaries. The full report — transcript turns and
 * all — is loaded per meeting by `getLocal` when a screen actually needs it.
 */
/** Legacy documents already trimmed this session. */
const trimmed = new Set<string>();

export function watchReports(
  onData: (r: ReportSummary[], dirty: string[]) => void,
  onError: (e: unknown) => void,
) {
  const user = uid();
  let active = true;
  let requested = 0;
  const publish = async () => {
    const request = ++requested;
    const local = await listLocal(user);
    if (active && request === requested)
      onData(
        local
          .map((v) => summarise(v.report))
          .sort((a, b) => b.date.localeCompare(a.date)),
        local.filter((v) => v.dirty).map((v) => v.report.id),
      );
  };
  const reportError = (error: unknown) => {
    if (active) onError(error);
  };
  const stopLocal = watchLocalReports(user, () => {
    void publish().catch(reportError);
  });
  void publish().catch(reportError);
  const unsub = onSnapshot(
    collection(db, "users", user, "reports"),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (!snapshot.metadata.hasPendingWrites && !snapshot.metadata.fromCache) {
        void Promise.all(
          snapshot.docs.map(async (d) => {
            const remote = { ...d.data(), id: d.id } as ReportData;
            await acceptRemoteReport(user, remote);
            // Documents written before the index carried full transcripts.
            // Trim one once its content is safely local AND in Drive; a report
            // with no Drive copy keeps it as its last cross-device copy.
            if (
              !trimmed.has(d.id) &&
              (remote.transcription?.trim() || remote.speech) &&
              remote.driveSyncedAt &&
              remote.driveReportId
            ) {
              trimmed.add(d.id);
              await setDoc(
                doc(db, "users", user, "reports", d.id),
                JSON.parse(JSON.stringify(projectReport(remote))),
              ).catch(() => trimmed.delete(d.id));
            }
          }),
        )
          .then(publish)
          .catch(reportError);
      }
    },
    reportError,
  );
  return () => {
    active = false;
    stopLocal();
    unsub();
  };
}
export { getLocal };
