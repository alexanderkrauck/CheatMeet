import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FileText, Mic, SearchX, X } from "lucide-react";
import AttentionQueue from "../components/AttentionQueue";
import MeetingRow from "../components/MeetingRow";
import NextMeeting from "../components/NextMeeting";
import { Busy, Notice, dateLabel } from "../components/UI";
import {
  groupByMonth,
  isValidDate,
  knownSpeakers,
  matchesQuery,
  plural,
} from "../lib/meetingMeta";
import { rememberPeople } from "../lib/people";
import { uid } from "../lib/reports";
import { useReports } from "../lib/useReports";

const FILTERS = [
  { id: "all", label: "Alle" },
  { id: "open", label: "Offen" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

const inFilter = (status: string, filter: Filter) =>
  filter === "all" || status !== "completed";

export default function Dashboard() {
  const workspace = useReports();
  const { reports, dirty, running, loading, error } = workspace;
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") || "").trim().toLowerCase();
  const [filter, setFilter] = useState<Filter>("all");
  const [removalWarning, setRemovalWarning] = useState("");

  // The archive is the address book: every name already typed becomes a
  // suggestion the next time a speaker needs naming.
  useEffect(() => {
    if (reports.length) void rememberPeople(uid(), knownSpeakers(reports)).catch(() => {});
  }, [reports]);

  // Matching runs once per query change rather than on every keystroke-driven
  // re-render. A report synced from another device carries no transcript here,
  // so its words are not searchable until it is restored from Drive.
  // How much of the archive this device cannot search.
  const elsewhere = useMemo(
    () => reports.filter((report) => !report.transcriptLocal).length,
    [reports],
  );
  const found = useMemo(
    () => reports.filter((report) => matchesQuery(report, query)),
    [reports, query],
  );
  const counts = useMemo(
    () => ({
      all: found.length,
      open: found.filter((r) => r.status !== "completed").length,
    }),
    [found],
  );
  const groups = useMemo(
    () =>
      groupByMonth(
        found.filter((report) => inFilter(report.status, filter)),
        new Date(),
      ),
    [found, filter],
  );
  const shown = groups.reduce((sum, group) => sum + group.reports.length, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Übersicht</h1>
          {reports.length > 0 && (
            <p className="muted">
              {plural(reports.length, "Meeting", "Meetings")}
              {isValidDate(reports[0].date)
                ? ` · zuletzt am ${dateLabel(reports[0].date)}`
                : ""}
            </p>
          )}
        </div>
      </div>

      <NextMeeting reports={reports} />

      <AttentionQueue workspace={workspace} />

      {removalWarning && (
        <Notice>{removalWarning}</Notice>
      )}

      {query && (
        <>
          <p className="search-summary">
            <strong>{found.length}</strong> Treffer für „{params.get("q")}“
            <button className="text-button" onClick={() => setParams({})}>
              <X size={14} /> Suche aufheben
            </button>
          </p>
          {elsewhere > 0 && (
            <p className="muted small">
              {elsewhere} Meeting(s) liegen hier nur als Kurzfassung vor; ihre
              Transkripte werden nicht durchsucht. In den Einstellungen lassen
              sie sich aus Drive wiederherstellen.
            </p>
          )}
        </>
      )}

      {/* Only worth offering once there is something to narrow. */}
      {counts.open > 0 && counts.open < counts.all && (
        <div className="filters" role="group" aria-label="Meetings filtern">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              aria-pressed={filter === id}
              className={filter === id ? "active" : ""}
              onClick={() => setFilter(id)}
            >
              {label} <span>{counts[id]}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <Busy text="Meetings laden …" />
      ) : error ? null : shown ? (
        <div className="meeting-list">
          {groups.map((group) => (
            <section key={group.key || "undated"}>
              <h2 className="group-heading">{group.label}</h2>
              {group.reports.map((report) => (
                <MeetingRow
                  key={report.id}
                  report={report}
                  dirty={dirty.includes(report.id)}
                  running={running.has(report.id)}
                  query={query}
                  onWarning={setRemovalWarning}
                />
              ))}
            </section>
          ))}
        </div>
      ) : (
        /* Three different reasons for an empty list, three different answers.
           None of them is shown while loading failed: the attention queue is
           already explaining that. */
        <div className="empty panel">
          <div className="empty-icon">
            {reports.length ? <SearchX size={30} /> : <FileText size={30} />}
          </div>
          {found.length ? (
            <>
              <h2>Nichts in dieser Ansicht</h2>
              <p className="muted">
                {plural(found.length, "Meeting passt", "Meetings passen")} zur
                Suche, aber keines zu diesem Filter.
              </p>
              <button className="btn" onClick={() => setFilter("all")}>
                Alle anzeigen
              </button>
            </>
          ) : reports.length ? (
            <>
              <h2>Keine passenden Meetings</h2>
              <p className="muted">
                Durchsucht werden Titel, Zusammenfassung, Aufgaben
                {elsewhere < reports.length ? " und Transkript" : ""}.
              </p>
            </>
          ) : (
            <>
              <h2>Noch keine Meetings</h2>
              <p className="muted">
                Starte eine Aufnahme. CheatMeet transkribiert live und erstellt
                danach die Zusammenfassung.
              </p>
              <Link className="btn btn-primary" to="/record?new=1">
                <Mic size={17} /> Erstes Meeting aufzeichnen
              </Link>
            </>
          )}
        </div>
      )}
    </>
  );
}
