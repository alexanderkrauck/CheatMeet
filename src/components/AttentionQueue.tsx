import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CloudUpload,
  Mic,
  RefreshCw,
  UserRoundCheck,
} from "lucide-react";
import { captureSnapshot, subscribeCapture } from "../lib/capture";
import { auth } from "../lib/firebase";
import { plural } from "../lib/meetingMeta";
import { getLocal } from "../lib/local";
import { saveReport } from "../lib/reports";
import { errorMessage } from "../lib/session";
import type { Workspace } from "../lib/useReports";

/** Enough to act on now; the rest are visible on their own rows. */
const LIMIT = 5;

const liveDraftId = () => {
  const snap = captureSnapshot();
  return snap.state === "recording" || snap.state === "paused"
    ? snap.draft.report.id
    : "";
};

/**
 * Everything that is waiting on the user, in one place. The overview used to
 * spread this across a load error, a sync banner, a draft banner per draft and
 * two states the running-job pill deliberately drops — a failed analysis and a
 * pending speaker review, both of which then existed nowhere in the UI.
 */
export default function AttentionQueue({
  workspace,
}: {
  workspace: Workspace;
}) {
  const { reports, dirty, drafts, error, draftsError, reload } = workspace;
  const recording = useSyncExternalStore(subscribeCapture, liveDraftId, () => "");
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState("");

  // The live meeting already has its own bar; listing it again as an
  // unfinished draft says the opposite of what the bar says.
  const open = drafts.filter((draft) => draft.report.id !== recording);
  const failed = reports.filter((r) => r.status === "error");
  // A failed report can also be awaiting speaker review; it is one problem to
  // the user, and the failure is the one worth acting on.
  const review = reports.filter(
    (r) => r.needsReview && r.status !== "error",
  );
  const unsynced = reports.filter((r) => dirty.includes(r.id));

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
          failures.push("Das Google-Konto wurde gewechselt.");
          break;
        }
        try {
          // Summaries are a projection; the stored report is what gets saved.
          const stored = await getLocal(owner, report.id);
          if (!stored) continue;
          const problem = await saveReport(stored.report);
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
            title: "Meetings konnten nicht geladen werden",
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
      key: `draft-${draft.report.id}`,
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
      key: `error-${report.id}`,
      tone: "red",
      icon: <AlertTriangle size={17} />,
      title: report.title || "Unbenanntes Meeting",
      detail: report.error || "Die Analyse ist fehlgeschlagen.",
      action: (
        <Link className="btn" to={`/report/${report.id}`}>
          Öffnen
        </Link>
      ),
    })),
    ...review.map((report) => ({
      key: `review-${report.id}`,
      tone: "amber",
      icon: <UserRoundCheck size={17} />,
      title: report.title || "Unbenanntes Meeting",
      detail: "Sprecher bestätigen",
      action: (
        <Link className="btn" to={`/report/${report.id}`}>
          Prüfen
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
  // A queue longer than the screen stops being a queue; the rest stay in the
  // list below with the same badges.
  const shown = rows.slice(0, LIMIT);
  return (
    <section className="attention" aria-label="Offene Punkte">
      {shown.map((row) => (
        <div key={row.key} className={`attention-row is-${row.tone}`}>
          <span className="attention-icon">{row.icon}</span>
          <div>
            <strong>{row.title}</strong>
            {row.detail && <p role="status">{row.detail}</p>}
          </div>
          {row.action}
        </div>
      ))}
      {rows.length > LIMIT && (
        <p className="attention-more">
          {plural(rows.length - LIMIT, "weiterer Punkt", "weitere Punkte")} in
          der Liste unten.
        </p>
      )}
    </section>
  );
}
