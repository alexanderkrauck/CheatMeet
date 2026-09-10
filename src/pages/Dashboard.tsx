import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  ArrowRight,
  FileText,
  LogOut,
  Plus,
  Search,
  Settings2,
  Mic,
  RefreshCw,
} from "lucide-react";
import { auth } from "../lib/firebase";
import { errorMessage } from "../lib/session";
import { watchReports, saveReport, uid } from "../lib/reports";
import { listDrafts } from "../lib/local";
import { Shell, Notice, Busy, Status, dateLabel } from "../components/UI";
import type { Draft, ReportData } from "../types";
import DriveSettings from "../components/DriveSettings";
import Preferences from "../components/Preferences";
export default function Dashboard() {
  const [reports, setReports] = useState<ReportData[]>([]);
  const [dirty, setDirty] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [settings, setSettings] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    listDrafts(uid(), { includeAudio: false })
      .then(setDrafts)
      .catch((e) => setError(errorMessage(e)));
    return watchReports(
      (data, unsynced) => {
        setReports(data);
        setDirty(unsynced);
        setLoading(false);
      },
      (e) => {
        setError(errorMessage(e));
        setLoading(false);
      },
    );
  }, []);
  async function sync() {
    const owner = uid();
    setSyncing(true);
    setError("");
    try {
      for (const r of reports.filter((r) => dirty.includes(r.id))) {
        if (uid() !== owner)
          throw new Error(
            "Das Google-Konto wurde gewechselt. Bitte erneut anmelden.",
          );
        const warning = await saveReport(r);
        if (warning) throw new Error(warning);
      }
      setDirty([]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }
  const visible = reports.filter(
    (r) =>
      (filter === "all" ||
        (filter === "completed"
          ? r.status === "completed"
          : r.status !== "completed")) &&
      `${r.title} ${r.summary}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Shell
      actions={
        <>
          <button
            className="btn btn-ghost"
            onClick={() => setSettings(!settings)}
            aria-expanded={settings}
          >
            <Settings2 size={18} />
            <span className="hide-mobile">Speicherort</span>
          </button>
          <button
            className="btn btn-ghost"
            disabled={syncing}
            onClick={() =>
              signOut(auth).catch((e) => setError(errorMessage(e)))
            }
            aria-label="Abmelden"
          >
            <LogOut size={18} />
          </button>
        </>
      }
    >
      {settings && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <DriveSettings />
          <Preferences />
        </div>
      )}
      <div className="page-heading">
        <div>
          <span className="eyebrow">DEINE MEETINGS</span>
          <h1>
            CheatMeet<span className="accent">.</span>
          </h1>
          <p className="muted">Jedes Gespräch. Jedes Detail. An einem Ort.</p>
        </div>
        <Link to="/record?new=1" className="btn btn-primary">
          <Plus size={20} />
          Neues Meeting
        </Link>
      </div>
      {error && <Notice>{error}</Notice>}
      {dirty.length > 0 && (
        <Notice kind="info">
          <div className="split">
            <span>
              {dirty.length} Bericht(e) warten auf Firebase. Lokale Kopien sind
              verfügbar.
            </span>
            <button className="btn" onClick={sync} disabled={syncing}>
              <RefreshCw size={16} />
              {syncing ? "Speichern …" : "Cloud erneut speichern"}
            </button>
          </div>
        </Notice>
      )}
      {drafts.map((draft) => (
        <Link
          key={draft.report.id}
          to={`/record?draft=${draft.report.id}`}
          className="draft-banner"
          style={{ marginBottom: 10 }}
        >
          <span className="draft-icon">
            <Mic />
          </span>
          <div>
            <strong>{draft.report.title || "Deine Aufnahme wartet"}</strong>
            <p>Lokaler Entwurf · noch sichern &amp; analysieren</p>
          </div>
          <ArrowRight />
        </Link>
      ))}
      <div className="stats">
        <div>
          <span>MEETINGS</span>
          <strong>{reports.length.toString().padStart(2, "0")}</strong>
        </div>
        <div>
          <span>BERICHTE ERSTELLT</span>
          <strong>
            {reports
              .filter((r) => r.status === "completed")
              .length.toString()
              .padStart(2, "0")}
          </strong>
        </div>
        <div>
          <span>IN BEARBEITUNG</span>
          <strong>
            {reports
              .filter((r) => r.status !== "completed")
              .length.toString()
              .padStart(2, "0")}
          </strong>
        </div>
      </div>
      <div className="list-toolbar">
        <div className="tabs" aria-label="Berichte filtern">
          {[
            ["all", "Alle"],
            ["completed", "Erstellt"],
            ["draft", "In Bearbeitung"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={filter === id ? "active" : ""}
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={17} />
          <input
            aria-label="Berichte durchsuchen"
            placeholder="Meeting suchen …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {loading ? (
        <Busy text="Meetings laden …" />
      ) : visible.length ? (
        <div className="report-list">
          {visible.map((r, i) => (
            <Link key={r.id} to={`/report/${r.id}`} className="report-card">
              <div className="report-number">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="report-card-body">
                <div className="report-card-meta">
                  <span>{dateLabel(r.date)}</span>
                  <Status report={r} local={dirty.includes(r.id)} />
                </div>
                <h2>{r.title || "Unbenanntes Meeting"}</h2>
                <p>
                  {r.summary || "Aufnahme prüfen und einen Bericht erstellen."}
                </p>
                <span className="small muted">
                  {r.todos?.length || 0} To-Dos · {r.takeaways?.length || 0}{" "}
                  Erkenntnisse
                </span>
              </div>
              <ArrowRight className="report-arrow" />
            </Link>
          ))}
        </div>
      ) : (
        <div className="empty panel">
          <div className="empty-icon">
            <FileText size={32} />
          </div>
          <span className="eyebrow">HIER BEGINNT DEINE DOKUMENTATION</span>
          <h2>
            {search || filter !== "all"
              ? "Keine passenden Meetings"
              : "Das nächste Meeting? Gut vorbereitet."}
          </h2>
          <p className="muted">
            {search || filter !== "all"
              ? "Versuche einen anderen Suchbegriff oder Filter."
              : "Starte eine Aufnahme. CheatMeet transkribiert live und erstellt im Anschluss eine smarte Zusammenfassung."}
          </p>
          {!search && filter === "all" && (
            <Link className="btn btn-primary" to="/record?new=1">
              <Mic size={18} />
              Erstes Meeting aufzeichnen
            </Link>
          )}
        </div>
      )}
    </Shell>
  );
}
