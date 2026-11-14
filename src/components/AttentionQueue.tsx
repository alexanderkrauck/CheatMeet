import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CloudUpload,
  Mic,
  RefreshCw,

} from "lucide-react";
import { captureSnapshot, subscribeCapture } from "../lib/capture";
import { reportIndexCollection } from "../../shared/storage";
import { auth } from "../lib/firebase";
import { plural } from "../lib/meetingMeta";
import { getLocal } from "../lib/local";
import { reportHref, saveReport } from "../lib/reports";
import { jobFor } from "../lib/pipeline";
import { errorMessage } from "../lib/session";
import type { Workspace } from "../lib/useReports";

/** Compact preview; every remaining action is available in the disclosure. */
const LIMIT = 5;

const liveDraftId = () => {
  const snap = captureSnapshot();
  return snap.state === "recording" || snap.state === "paused"
    ? reportHref(snap.draft.report)
    : "";
};

/**
 * Everything that is waiting on the user, in one place. The overview used to
 * spread this across a load error, a sync banner, a draft banner per draft and
 * failed analyses the running-job pill deliberately drops. Optional speaker
 * naming is not an unfinished task.
 */
export default function AttentionQueue({
  workspace,
}: {
  workspace: Workspace;
}) {
  const { reports, dirty, drafts, error, draftsError, reload, running } = workspace;
  const recording = useSyncExternalStore(subscribeCapture, liveDraftId, () => "");
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState("");

  // The live meeting already has its own bar; listing it again as an
  // unfinished draft says the opposite of what the bar says.
  const open = drafts.filter((draft) => {
    const job = jobFor(draft.report.id, draft.report);
    const processing = !!job && job.owner === auth.currentUser?.uid && ["saving", "uploading", "analyzing", "exporting"].includes(job.stage);
    return reportHref(draft.report) !== recording && !processing;
  });
  const failed = reports.filter((r) => (r.status === "error" || jobFor(r.id, r)?.stage === "error") && !running.has(reportHref(r)));

  const unsynced = reports.filter((r) => dirty.includes(reportHref(r)));

  async function syncAll() {
    // Read the uid without throwing: a signed-out user must get a message, not
    // an exception that leaves the button stuck on "Speichern …".
    const owner = auth.currentUser?.uid;
    setBusy(true);
    setWarning("");
    const failures: string[] = [];
    try {
      // Every report is attempted: aborting the batch on the first failure left
      // the rest unsaved and never named the one that failed.
      for (const report of unsynced) {
        if (!owner || auth.currentUser?.uid !== owner) {
          failures.push("Das angemeldete Konto hat sich geändert.");
          break;
        }
        try {
          // Summaries are a projection; the stored report is what gets saved.
          const stored = await getLocal(owner, report.id, { index: reportIndexCollection(report) });
          if (auth.currentUser?.uid !== owner) {
            failures.push("Das angemeldete Konto hat sich geändert.");
            break;
          }
          if (!stored) continue;
          const problem = await saveReport(stored.report, { expectedUpdatedAt: stored.report.updatedAt ?? null });
          if (problem) failures.push(`${report.title || "Unbenannt"}: ${problem}`);
        } catch (cause) {
          failures.push(`${report.title || "Unbenannt"}: ${errorMessage(cause)}`);
        }
      }
    } finally {
      setWarning(failures.join(" "));
      setBusy(false);
    }
  }

  const rows = [
    ...(error
      ? [
          {
            key: "load",
            tone: "red",
            icon: <AlertTriangle size={17} />,
            title: reports.length ? "Cloud-Abgleich unterbrochen · lokale Meetings bleiben verfügbar" : "Meetings konnten nicht geladen werden",
            detail: error,
            action: (
              <button className="btn" onClick={reload}>
                <RefreshCw size={15} /> Erneut laden
              </button>
            ),
          },
        ]
      : []),
    ...(draftsError
      ? [
          {
            key: "drafts",
            tone: "amber",
            icon: <AlertTriangle size={17} />,
            title: "Entwürfe konnten nicht gelesen werden",
            detail: draftsError,
            action: (
              <button className="btn" onClick={reload}>
                <RefreshCw size={15} /> Erneut versuchen
              </button>
            ),
          },
        ]
      : []),
    ...open.map((draft) => ({
      key: `draft-${reportHref(draft.report)}`,
      tone: "amber",
      icon: <Mic size={17} />,
      title: draft.report.title || "Aufnahme ohne Titel",
      detail: "Aufnahme nicht abgeschlossen",
      action: (
        <Link className="btn" to={`/record?draft=${draft.report.id}`}>
          Fortsetzen
        </Link>
      ),
    })),
    ...failed.map((report) => ({
      key: `error-${reportHref(report)}`,
      tone: "red",
      icon: <AlertTriangle size={17} />,
      title: report.title || "Unbenanntes Meeting",
      detail: jobFor(report.id, report)?.error || report.error || "Die Analyse ist fehlgeschlagen.",
      action: (
        <Link className="btn" to={reportHref(report)}>
          Öffnen
        </Link>
      ),
    })),

    ...(unsynced.length
      ? [
          {
            key: "sync",
            tone: "amber",
            icon: <CloudUpload size={17} />,
            title: `${plural(unsynced.length, "Bericht", "Berichte")} nur lokal gespeichert`,
            detail:
              warning ||
              "Auf diesem Gerät verfügbar, aber noch nicht in der Cloud.",
            action: (
              <button className="btn" onClick={() => void syncAll()} disabled={busy}>
                <CloudUpload size={15} />
                {busy ? "Speichern …" : "In der Cloud speichern"}
              </button>
            ),
          },
        ]
      : []),
  ];

  if (!rows.length) return null;
  const row = (item: (typeof rows)[number]) => (
    <div key={item.key} className={`attention-row is-${item.tone}`}>
      <span className="attention-icon">{item.icon}</span>
      <div>
        <strong>{item.title}</strong>
        {item.detail && <p role="status">{item.detail}</p>}
      </div>
      {item.action}
    </div>
  );
  return (
    <section className="attention" aria-label="Offene Punkte">
      {rows.slice(0, LIMIT).map(row)}
      {rows.length > LIMIT && (
        <details className="attention-more">
          <summary>{plural(rows.length - LIMIT, "weiteren Punkt", "weitere Punkte")} anzeigen</summary>
          {rows.slice(LIMIT).map(row)}
        </details>
      )}
    </section>
  );
}
