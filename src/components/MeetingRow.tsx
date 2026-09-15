import { useState } from "react";
import { Link } from "react-router-dom";
import { CloudUpload, ExternalLink, MoreHorizontal } from "lucide-react";
import Menu from "./Menu";
import DeleteMeeting from "./DeleteMeeting";
import { Status, dateTimeLabel } from "./UI";
import {
  formatDuration,
  plural,
  searchSnippet,
  type ReportSummary,
} from "../lib/meetingMeta";
import { getLocal } from "../lib/local";
import { saveReport, uid } from "../lib/reports";
import { errorMessage } from "../lib/session";

/**
 * One meeting, rendered the same way wherever meetings are listed. The row is
 * a link plus a sibling menu rather than one big link, because a list of
 * things you can only open is a list you cannot act on.
 */
export default function MeetingRow({
  report,
  dirty,
  running,
  query,
  onWarning,
}: {
  report: ReportSummary;
  dirty?: boolean;
  running?: boolean;
  query?: string;
  /** A partial delete removes this row, so its warning has to outlive it. */
  onWarning?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const meta = [
    dateTimeLabel(report.date),
    report.durationMs ? formatDuration(report.durationMs) : "",
    report.speakers.length
      ? plural(report.speakers.length, "Sprecher", "Sprecher")
      : "",
    report.todoCount
      ? report.openTodoCount && report.openTodoCount < report.todoCount
        ? `${plural(report.todoCount, "To-Do", "To-Dos")} · ${report.openTodoCount} offen`
        : plural(report.todoCount, "To-Do", "To-Dos")
      : "",
    report.takeawayCount
      ? plural(report.takeawayCount, "Erkenntnis", "Erkenntnisse")
      : "",
  ].filter(Boolean);

  const snippet = query ? searchSnippet(report, query) : null;
  const failed = report.status === "error" && report.error;

  async function retry() {
    const owner = uid();
    setBusy(true);
    setMessage("");
    // saveReport returns a warning instead of throwing: a local write must
    // never be reported as a cloud save.
    try {
      // The list holds a projection; re-saving it would write the transcript
      // turns out of existence. Always send the stored report.
      const stored = await getLocal(owner, report.id);
      if (!stored) throw new Error("Der Bericht ist lokal nicht mehr vorhanden.");
      const warning = await saveReport(stored.report);
      // A sign-out mid-write must not leave the next account looking at this
      // one's result.
      if (uid() !== owner) return;
      setMessage(warning || "");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="meeting-row">
      <Link className="meeting-row-main" to={`/report/${report.id}`}>
        <span className="row-head">
          <h3>{report.title || "Unbenanntes Meeting"}</h3>
          <Status
            status={report.status}
            syncedAt={report.driveSyncedAt}
            local={dirty}
            running={running}
          />
        </span>
        <span className="row-meta">{meta.join(" · ")}</span>
        {snippet ? (
          <span className="row-text">
            {snippet.before}
            <mark>{snippet.match}</mark>
            {snippet.after}
          </span>
        ) : failed ? (
          <span className="row-text is-error">{report.error}</span>
        ) : report.summary ? (
          <span className="row-text">{report.summary}</span>
        ) : query ? (
          <span className="row-text muted">Treffer im Titel oder in den Aufgaben.</span>
        ) : null}
      </Link>
      <Menu title="Weitere Aktionen" icon={<MoreHorizontal size={18} />}>
        <>
          {dirty && (
            <button onClick={() => void retry()} disabled={busy}>
              <CloudUpload size={16} />
              {busy ? "Speichern …" : "In der Cloud speichern"}
            </button>
          )}
          {report.driveFolderId && (
            <a
              href={`https://drive.google.com/drive/folders/${encodeURIComponent(report.driveFolderId)}`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} /> In Drive öffnen
            </a>
          )}
          <DeleteMeeting
            id={report.id}
            title={report.title}
            driveFolderId={report.driveFolderId}
            onWarning={onWarning}
          />
        </>
      </Menu>
      {message && (
        <p className="row-warning" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
