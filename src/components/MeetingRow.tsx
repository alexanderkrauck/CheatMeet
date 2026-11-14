import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {archiveFolderLink,archiveSyncedAt,reportIndexCollection} from "../../shared/storage";
import {hasAnyCalendarGrant,subscribeCalendar} from "../lib/calendar";
import { CalendarPlus, CloudUpload, ExternalLink, MoreHorizontal } from "lucide-react";
import Menu from "./Menu";
import AssignEvent from "./AssignEvent";
import { MIME } from "./EventRow";
import DeleteMeeting from "./DeleteMeeting";
import { CalendarStatus, Status, dateTimeLabel } from "./UI";
import {
  formatDuration,
  plural,
  searchSnippet,
  type ReportSummary,
} from "../lib/meetingMeta";
import { getLocal } from "../lib/local";
import { jobFor } from "../lib/pipeline";
import { reportHref, saveReport, uid } from "../lib/reports";
import {
  errorMessage,
  hasCalendarGrant,
  subscribeDriveSession,
} from "../lib/session";

/** A durable recording without a generated summary is not an unsaved draft. */
export const isArchivedWithoutReport = (report: ReportSummary) =>
  report.status === "pending" && !!archiveSyncedAt(report) && !report.summary?.trim() && !report.needsReview && !report.error;

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
  draggable,
  onWarning,
}: {
  report: ReportSummary;
  dirty?: boolean;
  running?: boolean;
  query?: string;
  /** Only where something can receive it — the calendar's own day list. */
  draggable?: boolean;
  /** A partial delete removes this row, so its warning has to outlive it. */
  onWarning?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [assigning, setAssigning] = useState(false);
  const calendarReady = useSyncExternalStore(
    subscribeCalendar,
    hasAnyCalendarGrant,
    () => false,
  );

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
  const job = jobFor(report.id, report);

  async function retry() {
    const owner = uid();
    setBusy(true);
    setMessage("");
    // saveReport returns a warning instead of throwing: a local write must
    // never be reported as a cloud save.
    try {
      // The list holds a projection; re-saving it would write the transcript
      // turns out of existence. Always send the stored report.
      const stored = await getLocal(owner, report.id, { index: reportIndexCollection(report) });
      if (uid() !== owner) return;
      if (!stored) throw new Error("Der Bericht ist lokal nicht mehr vorhanden.");
      const warning = await saveReport(stored.report, {
        expectedUpdatedAt: stored.report.updatedAt ?? null,
      });
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
    <div
      className="meeting-row"
      draggable={draggable}
      onDragStart={
        draggable
          ? (drag) => {
              drag.dataTransfer.setData(MIME, reportHref(report));
              drag.dataTransfer.effectAllowed = "link";
            }
          : undefined
      }
    >
      {/* The row's own link would otherwise start a URL drag of its own. */}
      <Link className="meeting-row-main" draggable={false} to={reportHref(report)}>
        <span className="row-head">
          <h3>{report.title || "Unbenanntes Meeting"}</h3>
          {running || isArchivedWithoutReport(report) ? (
            <span className="status-group">
              <span className={`badge ${running ? "blue" : "green"}`}>
                <span className="status-dot" />
                {running ? job?.message || "Verarbeitung läuft" : "Archiviert · ohne Bericht"}
              </span>
              {dirty && <span className="badge amber">Cloud-Speichern ausstehend</span>}
            </span>
          ) : (
            <Status status={report.status} syncedAt={archiveSyncedAt(report)} local={dirty} />
          )}
          <CalendarStatus report={report} />
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
          {/* The reachable half of drag-and-drop: the same assignment, by
              keyboard and on a phone. Without a grant there is nothing to pick
              from, so the dialog would open with an empty list and a confirm
              button that can never enable. */}
          {calendarReady && (
            <button onClick={() => setAssigning(true)}>
              <CalendarPlus size={16} /> Termin zuordnen
            </button>
          )}
          {dirty && (
            <button onClick={() => void retry()} disabled={busy}>
              <CloudUpload size={16} />
              {busy ? "Speichern …" : "In der Cloud speichern"}
            </button>
          )}
          {archiveFolderLink(report) && (
            <a
              href={archiveFolderLink(report)}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} /> In {report.home?"OneDrive":"Drive"} öffnen
            </a>
          )}
          <DeleteMeeting
            id={report.id}
            title={report.title}
            driveFolderId={report.driveFolderId}
            home={report.home}
            onWarning={onWarning}
            onDeleted={() => requestAnimationFrame(() => {
              const heading = document.querySelector<HTMLElement>("main h1, h1");
              if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
            })}
          />
        </>
      </Menu>
      {assigning && (
        <AssignEvent
          report={report}
          onClose={() => setAssigning(false)}
          onWarning={onWarning}
        />
      )}
      {message && (
        <p className="row-warning" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
