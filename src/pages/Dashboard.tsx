import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  ArrowRight,
  FileText,
  LogOut,
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
  // Past meetings are only useful if you can find what was said in them, so
  // the transcript and extracted items are searchable too.
  const needle = search.trim().toLowerCase();
  const haystack = (r: ReportData) =>
    [r.title, r.summary, r.transcription, ...(r.todos || []), ...(r.takeaways || [])]
      .join(" ")
      .toLowerCase();
  const visible = reports.filter(
    (r) =>
      (filter === "all" ||
        (filter === "completed"
          ? r.status === "completed"
          : r.status !== "completed")) &&
      (!needle || haystack(r).includes(needle)),
  );
  /** The snippet around the match, so a transcript hit is legible in the list. */
  const excerpt = (r: ReportData) => {
    if (!needle) return r.summary || "Aufnahme prüfen und einen Bericht erstellen.";
    const text = r.transcription || r.summary || "";
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) return r.summary || "Treffer in Titel oder Aufgaben.";
    const from = Math.max(0, at - 60);
    return `${from > 0 ? "… " : ""}${text.slice(from, at + needle.length + 90).trim()} …`;
  };
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
      <div className="home-hero">
        <div>
          <span className="eyebrow">CHEATMEET</span>
          <h1>Bereit, wenn das Meeting startet.</h1>
          <p className="muted">
            Live mitlesen, jederzeit nachfragen, danach den fertigen Bericht in
            Google Drive.
          </p>
        </div>
        <Link to="/record?new=1" className="home-start">
          <span className="home-start-icon">
            <Mic size={26} />
          </span>
          <span>
            <strong>Meeting aufnehmen</strong>
            <small>Startet sofort · ein Tipp</small>
          </span>
          <ArrowRight size={20} />
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
            <p>Nicht abgeschlossen · fortsetzen, sichern &amp; analysieren</p>
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
            aria-label="Meetings und Transkripte durchsuchen"
            placeholder="In allen Transkripten suchen …"
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
                <p>{excerpt(r)}</p>
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
          <span className="eyebrow">DEIN MEETING-GEDÄCHTNIS</span>
          <h2>
            {search || filter !== "all"
              ? "Keine passenden Meetings"
              : "Das nächste Meeting? Gut vorbereitet."}
          </h2>
          <p className="muted">
            {search || filter !== "all"
              ? "Kein Meeting enthält diesen Begriff. Durchsucht werden Titel, Zusammenfassung, Transkript und Aufgaben."
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
