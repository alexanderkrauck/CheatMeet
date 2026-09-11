import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  CloudUpload,
  Download,
  Edit3,
  Printer,
  RefreshCw,
  Save,
  WandSparkles,
  FolderOpen,
  FileText,
  MoreHorizontal,
  CheckSquare,
  Lightbulb,
} from "lucide-react";
import { Busy, Notice, Shell, Status, dateLabel } from "../components/UI";
import type { ReportData } from "../types";
import { connectGoogle, ensureDriveToken, errorMessage } from "../lib/session";
import { saveReport, uid } from "../lib/reports";
import { backupDraft, syncReport, analyzeDraft, restoreDraft } from "../lib/workflow";
import { getDraft, getLocal, putDraft } from "../lib/local";
import { clearJob, jobFor, subscribeJobs } from "../lib/pipeline";
import { reportToMarkdown } from "../lib/markdown";
import TranscriptTimeline from "../components/TranscriptTimeline";

export default function ReportPage({
  report: initialReport,
  dirty: initialDirty,
}: {
  report?: ReportData;
  dirty?: boolean;
}) {
  const params = useParams();
  const [report, setReport] = useState<ReportData | undefined>(initialReport);
  const [dirty, setDirty] = useState(initialDirty || false);
  const [edited, setEdited] = useState<ReportData>();
  const [loading, setLoading] = useState(!initialReport);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (initialReport) return;
    let active = true;
    const load = async () => {
      try {
        const id = params.id!;
        const owner = uid();
        // A finished report is a saved report, not a draft: the draft is deleted
        // once it has been analysed and exported.
        const stored = await getLocal(owner, id);
        const draft = stored ? undefined : await getDraft(owner, id);
        if (!active) return;
        if (stored) {
          setReport(stored.report);
          setDirty(stored.dirty);
        } else if (draft) {
          setReport(draft.report);
          setDirty(true);
        } else {
          setError("Bericht auf diesem Gerät nicht gefunden.");
        }
      } catch (e) {
        if (active) setError(errorMessage(e));
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [initialReport, params.id]);

  const view = edited || report;
  const minutes = (ms: number) => `${Math.round(ms / 60000)} Min.`;
  const menu = useRef<HTMLDetailsElement>(null);
  // A menu that only closes by re-clicking its own trigger is not a menu.
  useEffect(() => {
    const close = (event: Event) => {
      const node = menu.current;
      if (!node?.open) return;
      if (event.type === "keydown") {
        if ((event as KeyboardEvent).key !== "Escape") return;
        node.open = false;
        node.querySelector("summary")?.focus();
        return;
      }
      if (!node.contains(event.target as Node)) node.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  const job = useSyncExternalStore(subscribeJobs, () =>
    params.id ? jobFor(params.id) : undefined,
  );
  const running = !!job && job.stage !== "done" && job.stage !== "error";

  // The background pipeline writes each step locally; mirror it into the view
  // rather than leaving a stale report on screen.
  useEffect(() => {
    if (!job) return;
    let active = true;
    getLocal(uid(), job.reportId)
      .then((stored) => {
        if (!active || !stored) return;
        setReport(stored.report);
        setDirty(stored.dirty);
      })
      .catch(() => {});
    if (job.stage === "done") {
      setNotice(job.warning || "In Google Drive gespeichert.");
      clearJob(job.reportId);
    }
    if (job.stage === "error") {
      setError(job.error || "Der Vorgang ist fehlgeschlagen.");
      clearJob(job.reportId);
    }
    return () => {
      active = false;
    };
  }, [job]);

  async function save(syncDrive: boolean) {
    if (!view || busy) return;
    const owner = uid();
    setBusy("Bericht speichern …");
    setError("");
    setNotice("");
    try {
      const connection = (syncDrive ? ensureDriveToken().then((t) => t || connectGoogle()) : Promise.resolve(null))
        .then((t) => ({ token: t, error: null as unknown }))
        .catch((error) => ({ token: null, error }));
      const next = { ...view, updatedAt: new Date().toISOString(), ...(edited ? { driveSyncedAt: "" } : {}) };
      const warning = await saveReport(next);
      setReport(next);
      setDirty(!!warning);
      setEdited(undefined);
      const connected = await connection;
      if (uid() !== owner) throw new Error("Das Google-Konto wurde gewechselt.");
      if (connected.error) {
        setNotice(warning || "Lokal gespeichert. Drive kann später erneut verbunden werden.");
        throw connected.error;
      }
      const t = connected.token;
      if (t) {
        const result = await syncReport(next, t);
        setReport(result.report);
        setDirty(!!result.warning);
        setNotice(result.warning || "In Drive gespeichert.");
      } else {
        setNotice(warning || "Lokal gespeichert.");
      }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(""); }
  }

  async function retry() {
    if (!report || busy) return;
    const owner = uid();
    setBusy("Lade...");
    try {
      const t = (await ensureDriveToken()) || (await connectGoogle());
      const local = await getDraft(owner, report.id);
      const d = local?.report.id === report.id && local.audio ? { ...local, report } : await restoreDraft(report, t);
      if (local?.report.id === report.id) await backupDraft(d, t, setBusy);
      setBusy("Analysiere...");
      const next = await analyzeDraft(d);
      await saveReport(next);
      setReport(next);
      if (local?.report.id === report.id) await putDraft(owner, { ...d, report: next });
      const result = await syncReport(next, t);
      setReport(result.report);
      setDirty(!!result.warning);
      setNotice(result.warning || "Analyse abgeschlossen.");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(""); }
  }

  function download() {
    if (!view) return;
    const url = URL.createObjectURL(new Blob([reportToMarkdown(view)], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-${view.date.slice(0, 10)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (loading) return <Shell><Busy text="Bericht laden …" /></Shell>;
  if (!view) return (
    <Shell>
      {error && <Notice>{error}</Notice>}
      <div className="empty panel">
        <FolderOpen size={36} />
        <h1>Bericht nicht verfügbar</h1>
        <Link className="btn" to="/dashboard">Zur Übersicht</Link>
      </div>
    </Shell>
  );

  return (
    <Shell>
      <fieldset disabled={!!busy || running} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <header className="report-head">
          <div className="report-head-main">
            <Link className="report-back no-print" to="/dashboard">
              <ArrowLeft size={14} /> Zur Übersicht
            </Link>
            {edited ? (
              <input className="title-input" value={view.title} onChange={e => setEdited({ ...view, title: e.target.value })} />
            ) : (
              <h1>{view.title}</h1>
            )}
            <p className="report-meta">
              <span>{dateLabel(view.date)}</span>
              {Number.isFinite(view.durationMs) && (
                <span>{minutes(view.durationMs!)}</span>
              )}
              <Status report={view} local={dirty} />
            </p>
          </div>
          <div className="report-head-actions no-print">
            {edited ? (
              <>
                <button className="btn btn-primary" onClick={() => save(true)}><Save size={16} /> Speichern</button>
                <button className="btn" onClick={() => setEdited(undefined)}>Abbrechen</button>
              </>
            ) : !view.driveSyncedAt ? (
              <button className="btn btn-primary" onClick={() => save(true)}><CloudUpload size={16} /> In Drive speichern</button>
            ) : (
              <button className="btn" onClick={() => setEdited(structuredClone(view))}><Edit3 size={16} /> Bearbeiten</button>
            )}
            <details className="report-menu" ref={menu}>
              <summary aria-label="Weitere Aktionen"><MoreHorizontal size={18} /></summary>
              <div>
                {!edited && !view.driveSyncedAt && (
                  <button onClick={() => setEdited(structuredClone(view))}><Edit3 size={16} /> Bearbeiten</button>
                )}
                <button onClick={() => window.print()} disabled={!!edited}><Printer size={16} /> Als PDF drucken</button>
                <button onClick={download}><Download size={16} /> Markdown laden</button>
                {view.driveFolderId && (
                  <a href={`https://drive.google.com/drive/folders/${encodeURIComponent(view.driveFolderId)}`} target="_blank" rel="noreferrer">
                    <FolderOpen size={16} /> Ordner in Drive
                  </a>
                )}
              </div>
            </details>
          </div>
        </header>

        {error && <Notice>{error}</Notice>}
        {notice && <Notice kind="info">{notice}</Notice>}
        {busy && <Busy text={busy} />}

        {running ? (
          <div className="analysis-progress panel no-print" role="status" aria-live="polite">
            <RefreshCw size={18} className="spin" />
            <div>
              <h2>{job!.message}</h2>
              <p className="muted">Du kannst weiterlesen und navigieren. Der Vorgang läuft in diesem Tab weiter.</p>
            </div>
          </div>
        ) : (
          view.status !== "completed" && (
            <div className="analysis-recovery panel no-print">
              <div>
                <h2>Analyse erneut starten</h2>
                <p className="muted">{view.error || "Starte die KI-Analyse."}</p>
              </div>
              <button className="btn btn-primary" onClick={retry} disabled={!!busy || !!edited}><WandSparkles size={18} /> Bericht erstellen</button>
            </div>
          )
        )}

        <div className="report-intel">
          <section className="is-summary">
            <h2><FileText size={15} /> Zusammenfassung</h2>
            {edited ? (
              <textarea className="field" value={view.summary} onChange={e => setEdited({ ...view, summary: e.target.value })} />
            ) : (
              <p>{view.summary || "Noch keine Zusammenfassung erstellt."}</p>
            )}
          </section>
          <section>
              <h2><CheckSquare size={15} /> Aufgaben</h2>
              {edited ? (
                <textarea className="field" value={view.todos.join("\n")} onChange={e => setEdited({ ...view, todos: e.target.value.split("\n") })} />
              ) : view.todos?.length ? (
                <ul>{view.todos.map((t, i) => <li key={i}>{t}</li>)}</ul>
              ) : (
                <p className="muted">Keine Aufgaben erkannt.</p>
              )}
            </section>
            <section>
              <h2><Lightbulb size={15} /> Erkenntnisse</h2>
              {edited ? (
                <textarea className="field" value={view.takeaways.join("\n")} onChange={e => setEdited({ ...view, takeaways: e.target.value.split("\n") })} />
              ) : view.takeaways?.length ? (
                <ul>{view.takeaways.map((t, i) => <li key={i}>{t}</li>)}</ul>
              ) : (
                <p className="muted">Keine Erkenntnisse erkannt.</p>
              )}
          </section>
        </div>

        <section className="report-transcript">
          <h2>Transkript</h2>
          {edited ? (
            <textarea className="field" value={view.transcription} onChange={e => setEdited({ ...view, transcription: e.target.value })} />
          ) : (
            <TranscriptTimeline
              transcript={view.transcription}
              startedAt={view.date}
              empty="Für dieses Meeting wurde kein Transkript gespeichert."
            />
          )}
        </section>
      </fieldset>
    </Shell>
  );
}
