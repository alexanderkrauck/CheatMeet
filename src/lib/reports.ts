import { doc, setDoc, collection, onSnapshot, getDocFromServer } from "firebase/firestore";
import { reportIndexCollection } from "../../shared/storage";
import { auth, db } from "./firebase";
import {
  putLocal,
  listLocal,
  getLocal,
  acceptRemoteReport,
  dropLocal,
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

/** The known namespace travels with links and the calendar's drag payload. */
export const reportHref = (report: Pick<ReportData, "id" | "home">) =>
  `/report/${encodeURIComponent(report.id)}?index=${reportIndexCollection(report)}`;

export function reportForDrop<T extends Pick<ReportData, "id" | "home">>(reports: T[], payload: string): T | undefined {
  const qualified = /^\/report\/([a-zA-Z0-9_-]{1,200})\?index=(reports|meetings)$/.exec(payload);
  const id = qualified?.[1] || (/^[a-zA-Z0-9_-]{1,200}$/.test(payload) ? payload : undefined);
  if (!id) return;
  const matches = reports.filter(report => report.id === id && (!qualified || reportIndexCollection(report) === qualified[2]));
  if (matches.length > 1) throw Error("Diese Meeting-ID ist mehrdeutig. Bitte den gewünschten Bericht über seine Zeile zuordnen.");
  return matches[0];
}
let lastRevision = 0;
export async function saveReport(
  report: ReportData,
  options?: { expectedUpdatedAt?: string | null },
): Promise<string | null> {
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
  await putLocal(user, next, true, options?.expectedUpdatedAt);
  if (auth.currentUser?.uid !== user) throw new Error("Das angemeldete Konto hat sich geändert.");
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
      doc(db, "users", user, reportIndexCollection(report), report.id),
      JSON.parse(JSON.stringify(projectReport(next))),
    );
    // A late acknowledgement may clear only an existing identical revision.
    // CAS also protects the gap between this read and a concurrent deletion.
    const acknowledged = write.then(async () => {
      if (auth.currentUser?.uid !== user) return;
      const current = await getLocal(user, next.id, { index: reportIndexCollection(next) });
      if (auth.currentUser?.uid !== user || current?.report.updatedAt !== next.updatedAt) return;
      try {
        await putLocal(user, current.report, false, next.updatedAt);
      } catch (error) {
        if (!(error instanceof Error && error.name === "ReportConflictError")) throw error;
      }
    });
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
  let reconciliation = Promise.resolve();
  const ready = new Set<string>();
  const publish = async () => {
    const request = ++requested;
    const local = await listLocal(user);
    if (active && auth.currentUser?.uid === user && request === requested && (local.length > 0 || ready.size === 2))
      onData(
        local
          .map((v) => summarise(v.report))
          .sort((a, b) => b.date.localeCompare(a.date)),
        local.filter((v) => v.dirty).map((v) => reportHref(v.report)),
      );
  };
  const reportError = (error: unknown) => {
    if (active) onError(error);
  };
  const stopLocal = watchLocalReports(user, () => {
    void publish().catch(reportError);
  });
  void publish().catch(reportError);
  const observe = (index: "reports" | "meetings") => onSnapshot(
    collection(db, "users", user, index),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (!snapshot.metadata.hasPendingWrites && !snapshot.metadata.fromCache) {
        // Full server snapshots are authoritative only for their own index.
        // Serialize them so a slow earlier snapshot cannot undo a later one.
        reconciliation = reconciliation.then(async () => {
          if (!active || auth.currentUser?.uid !== user) return;
          const present = new Set(snapshot.docs.map(d => d.id));
          const cached = await listLocal(user);
          if (!active || auth.currentUser?.uid !== user) return;
          for (const value of cached) {
            if (!active || auth.currentUser?.uid !== user) return;
            if (!value.dirty && reportIndexCollection(value.report) === index && !present.has(value.report.id))
              await dropLocal(user, value.report.id, { onlyIfClean: true, index, expectedUpdatedAt: value.report.updatedAt ?? null });
          }
          await Promise.all(snapshot.docs.map(async (d) => {
            const remote = { ...d.data(), id: d.id } as ReportData;
            if (auth.currentUser?.uid !== user || (index === "meetings" ? !remote.home : !!remote.home)) return;
            await acceptRemoteReport(user, remote);
            if (!active || auth.currentUser?.uid !== user) return;
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
                doc(db, "users", user, index, d.id),
                JSON.parse(JSON.stringify(projectReport(remote))),
              ).catch(() => trimmed.delete(d.id));
            }
          }));
          ready.add(index);
          await publish();
        }).catch(reportError);
      }
    },
    reportError,
  );
  const unsub = observe("reports");
  const unsubMicrosoft = observe("meetings");
  return () => {
    active = false;
    stopLocal();
    unsub();
    unsubMicrosoft();
  };
}
/** Cold deep links need at most two document reads, never a collection scan.
 * Local dirty work takes precedence; the result has getLocal's existing shape. */
export async function getReport(owner: string, id: string, options?: { index: "reports" | "meetings" }) {
  const check = () => {
    if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  check();
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error("Ungültige Meeting-ID.");
  const local = await getLocal(owner, id, options);
  check();
  if (local) return local;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const documents = await Promise.race([
    Promise.all((options ? [options.index] : ["reports", "meetings"] as const).map(async index => {
      const snapshot = await getDocFromServer(doc(db, "users", owner, index, id));
      check();
      if (!snapshot.exists()) return undefined;
      const report = { ...snapshot.data(), id } as ReportData;
      return (index === "meetings" ? !!report.home : !report.home) ? report : undefined;
    })),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Cloud-Meeting konnte nicht geladen werden. Bitte erneut versuchen.")), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  check();
  const matches = documents.filter((report): report is ReportData => !!report);
  if (matches.length > 1) throw new Error("Diese Meeting-ID ist mehrdeutig. Bitte den gewünschten Bericht über die Übersicht öffnen.");
  const remote = matches[0];
  if (remote) {
    await acceptRemoteReport(owner, remote);
    check();
  }
  const latest = await getLocal(owner, id, options);
  check();
  return latest;
}

export { getLocal };
