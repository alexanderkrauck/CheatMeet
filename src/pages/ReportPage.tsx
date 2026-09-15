import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CloudUpload,
  Download,
  Edit3,
  Printer,
  Share2,
  CalendarDays,
  RefreshCw,
  Save,
  WandSparkles,
  FolderOpen,
  FileText,
  MoreHorizontal,
  CheckSquare,
  Lightbulb,
} from "lucide-react";
import { Busy, Notice, Status, dateTimeLabel } from "../components/UI";
import Menu from "../components/Menu";
import DeleteMeeting from "../components/DeleteMeeting";
import { shareReport } from "../lib/share";
import { syncReportToCalendar } from "../lib/calendarSync";
import {
  dayKeyLabel,
  formatDuration,
  meetingDurationMs,
  meetingStatus,
  plural,
  speakerNamesOf,
} from "../lib/meetingMeta";
import {
  formatTodoEditLine,
  parseTodoLine,
  todoLineDone,
  type Todo,
} from "../../shared/analysis";
import type { ReportData } from "../types";
import {
  connectGoogle,
  ensureDriveToken,
  errorMessage,
  hasCalendarGrant,
  subscribeDriveSession,
} from "../lib/session";
import { saveReport, uid } from "../lib/reports";
import { backupDraft, syncReport, analyzeDraft, restoreDraft } from "../lib/workflow";
import { deleteDraft, getDraft, getLocal, putDraft } from "../lib/local";
import { clearJob, jobFor, subscribeJobs } from "../lib/pipeline";
import { reportToMarkdown } from "../lib/markdown";
import TranscriptTimeline from "../components/TranscriptTimeline";
import SpeakerReview from "../components/SpeakerReview";
import SpeakerEditor from "../components/SpeakerEditor";
import { renderTranscript, needsSpeakerReview, renameSpeaker } from "../../shared/transcription";
import { prepareTranscript } from "../lib/prepareTranscript";
import { downloadDriveFile } from "../lib/drive";
import { withWebmDuration } from "../lib/webmDuration";

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
  const [editFields, setEditFields] = useState(false);
  const [loading, setLoading] = useState(!initialReport);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [audioLoading, setAudioLoading] = useState(false);
  const navigate = useNavigate();
  const [todosText, setTodosText] = useState("");
  // The token is usually minted after this mounts; a bare read would leave the
  // calendar action missing for the whole visit.
  const calendarReady = useSyncExternalStore(
    subscribeDriveSession,
    hasCalendarGrant,
    () => false,
  );
  const audio = useRef<HTMLAudioElement>(null);
  const seekTo = useRef(0);
  const audioRequest = useRef(0);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => {
    audioRequest.current++;
    setAudioUrl("");
    return () => { audioRequest.current++; };
  }, [params.id, initialReport?.id]);

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
  const duration = view ? meetingDurationMs(view) : 0;
  const speakers = speakerNamesOf(view?.speech);
  const job = useSyncExternalStore(subscribeJobs, () =>
    params.id ? jobFor(params.id) : undefined,
  );
  const running = !!job && job.stage !== "done" && job.stage !== "error" && job.stage !== "review";

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
        if (job.stage === "done") {
          setNotice(job.warning || "In Google Drive gespeichert.");
          clearJob(job.reportId);
        }
        if (job.stage === "error") {
          setError(job.error || "Der Vorgang ist fehlgeschlagen.");
          clearJob(job.reportId);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [job]);

  /**
   * Ticking a box is a real edit, so it goes through the same save path as any
   * other — including the Drive copy, which is where the report actually lives.
   */
  async function toggleTodo(index: number, done: boolean) {
    // While an edit is open, Speichern/Abbrechen owns the document: a tick
    // would otherwise persist the whole pending draft behind the user's back.
    if (!view || busy || edited) return;
    const todos = view.todos.map((todo, i) =>
      i === index ? { ...todo, ...(done ? { done: true } : { done: undefined }) } : todo,
    );
    const next = { ...view, todos, updatedAt: new Date().toISOString() };
    setReport(next);
    let warning: string | null;
    try {
      warning = await saveReport(next);
    } catch (cause) {
      // The box is ticked on screen but nothing was stored; say so rather than
      // letting the optimistic update stand in for a save.
      setReport(view);
      setError(errorMessage(cause));
      return;
    }
    setDirty(!!warning);
    // The Drive copy is only refreshed by an explicit save; say so rather than
    // letting the tick look like a full save.
    setNotice(
      warning ||
        (next.driveSyncedAt
          ? "Gespeichert. Die Drive-Kopie wird beim nächsten Speichern aktualisiert."
          : "Gespeichert."),
    );
    if (warning) setError(warning);
  }

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
      setEditFields(false);
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

  async function retry(reviewDecision?: "reviewed" | "skipped") {
    if (!view || busy) return;
    const report = view;
    const owner = uid();
    const checkOwner = () => { if (uid() !== owner) throw new Error("Das Google-Konto wurde gewechselt."); };
    setBusy("Lade...");
    setError("");
    try {
      const t = (await ensureDriveToken()) || (await connectGoogle());
      checkOwner();
      const local = await getDraft(owner, report.id);
      checkOwner();
      const canUseSavedTranscript = report.speech?.phase === "final" || (!report.speech && !!report.transcription.trim());
      const canUseDriveStream = !!report.speech && !!report.rawAudioUrl;
      const d = local?.report.id === report.id && local.audio ? { ...local, report }
        : canUseSavedTranscript || canUseDriveStream ? { report } : await restoreDraft(report, t);
      checkOwner();
      if (local?.speakerReference) d.speakerReference = local.speakerReference;
      if (local?.report.id === report.id) await backupDraft(d, t, setBusy);
      checkOwner();
      setBusy("Transkript vorbereiten …");
      await prepareTranscript(d, t);
      checkOwner();
      if (reviewDecision && needsSpeakerReview(d.report.speech)) {
        d.report = { ...d.report, speech: { ...d.report.speech!, speakerReview: reviewDecision },
          transcription: renderTranscript(d.report.speech!), error: "" };
        await putDraft(owner, d);
        checkOwner();
      }
      if (needsSpeakerReview(d.report.speech)) {
        d.report = { ...d.report, status: "pending", error: "" };
        await saveReport(d.report);
        checkOwner();
        setReport(d.report);
        setEdited(undefined);
        setEditFields(false);
        const result = await syncReport(d.report, t);
        checkOwner();
        setReport(result.report);
        setNotice(result.warning || "Transkript bereit. Bitte Sprecher prüfen oder Prüfung überspringen.");
        return;
      }
      setBusy("Analysiere...");
      const next = await analyzeDraft(d);
      checkOwner();
      await saveReport(next);
      checkOwner();
      setReport(next);
      setEdited(undefined);
      setEditFields(false);
      if (local?.report.id === report.id) await putDraft(owner, { ...d, report: next });
      const result = await syncReport(next, t);
      checkOwner();
      // The pipeline drops the draft on success for a reason: left behind, it
      // reappears as an unfinished recording and "Fortsetzen" can overwrite
      // the finished report with its own pre-analysis state.
      await deleteDraft(owner, result.report.id).catch(() => {});
      setReport(result.report);
      setDirty(!!result.warning);
      setNotice(result.warning || "Analyse abgeschlossen.");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(""); }
  }

  async function listen(atMs: number) {
    if (!view || audioLoading) return;
    seekTo.current = atMs / 1000;
    if (audioUrl && audio.current) {
      audio.current.currentTime = seekTo.current;
      void audio.current.play().catch(() => {});
      return;
    }
    const owner = uid();
    const request = ++audioRequest.current;
    setAudioLoading(true);
    try {
      const draft = await getDraft(owner, view.id);
      if (uid() !== owner || request !== audioRequest.current) return;
      let blob = draft?.audio;
      if (!blob && view.rawAudioUrl) {
        const token = (await ensureDriveToken()) || (await connectGoogle());
        if (uid() !== owner || request !== audioRequest.current) return;
        blob = await downloadDriveFile(view.rawAudioUrl, token);
      }
      if (uid() !== owner || request !== audioRequest.current) return;
      if (!blob) throw new Error("Die Originalaufnahme ist hier nicht verfügbar.");
      blob = await withWebmDuration(blob, view.durationMs || 0);
      if (uid() !== owner || request !== audioRequest.current) return;
      setAudioUrl(URL.createObjectURL(blob));
    } catch (e) { setError(errorMessage(e)); }
    finally { setAudioLoading(false); }
  }

  /** Two-way: updates the matched event, or creates one for a meeting that
   *  belonged to none. */
  async function toCalendar() {
    if (!view || busy) return;
    const owner = uid();
    setBusy("Kalender wird aktualisiert …");
    setError("");
    try {
      const patch = await syncReportToCalendar(view);
      if (uid() !== owner) return;
      const next = { ...view, ...patch, updatedAt: new Date().toISOString() };
      setReport(next);
      if (edited) setEdited(next);
      setDirty(!!(await saveReport(next)));
      // syncReportToCalendar reports a refusal in the patch rather than
      // throwing, so the cleared link is persisted along with the reason.
      if (patch.calendarError) setError(patch.calendarError);
      else
        setNotice(
          patch.calendarEventId
            ? "Termin im Kalender angelegt."
            : "Kalendereintrag aktualisiert.",
        );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  async function share() {
    if (!view) return;
    setError("");
    setNotice("");
    try {
      const outcome = await shareReport(view);
      if (outcome === "copied") setNotice("In die Zwischenablage kopiert.");
      if (outcome === "mail") setNotice("E-Mail-Entwurf geöffnet.");
      if (outcome === "failed")
        setError(
          "Teilen hat nicht geklappt. „Markdown laden“ speichert den Bericht als Datei.",
        );
    } catch (cause) {
      setError(errorMessage(cause));
    }
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

  if (loading) return <Busy text="Bericht laden …" />;
  if (!view) return (
    <>
      {error && <Notice>{error}</Notice>}
      <div className="empty panel">
        <FolderOpen size={36} />
        <h1>Bericht nicht verfügbar</h1>
        <Link className="btn" to="/dashboard">Zur Übersicht</Link>
      </div>
    </>
  );

  return (
    <>
      <fieldset disabled={!!busy || running} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <header className="report-head">
          <div className="report-head-main">
            <Link className="report-back no-print" to="/dashboard">
              <ArrowLeft size={14} /> Zur Übersicht
            </Link>
            {edited && editFields ? (
              <input className="title-input" aria-label="Titel des Meetings" placeholder="Unbenanntes Meeting" value={view.title} onChange={e => setEdited({ ...view, title: e.target.value })} />
            ) : (
              <h1>{view.title || "Unbenanntes Meeting"}</h1>
            )}
            <p className="report-meta">
              <span>{dateTimeLabel(view.date)}</span>
              {!!duration && <span>{formatDuration(duration)}</span>}
              {!!speakers.length && (
                <span title={speakers.join(", ")}>
                  {plural(speakers.length, "Sprecher", "Sprecher")}
                </span>
              )}
              {view.calendarSyncedAt && (
                <a
                  className="report-calendar"
                  href={view.calendarLink || "https://calendar.google.com/"}
                  target="_blank"
                  rel="noreferrer"
                >
                  <CalendarDays size={13} /> Im Kalender
                </a>
              )}
              <Status status={meetingStatus(view)} syncedAt={view.driveSyncedAt} local={dirty} running={running} />
            </p>
          </div>
          <div className="report-head-actions no-print">
            {edited ? (
              <>
                <button className="btn btn-primary" onClick={() => save(true)}><Save size={16} /> Speichern</button>
                <button className="btn" onClick={() => { setEdited(undefined); setEditFields(false); }}>Abbrechen</button>
              </>
            ) : !view.driveSyncedAt ? (
              <button className="btn btn-primary" onClick={() => save(true)}><CloudUpload size={16} /> In Drive speichern</button>
            ) : (
              <button className="btn" onClick={() => { setEdited(structuredClone(view)); setTodosText(view.todos.map(formatTodoEditLine).join("\n")); setEditFields(true); }}><Edit3 size={16} /> Bearbeiten</button>
            )}
            <Menu title="Weitere Aktionen" icon={<MoreHorizontal size={18} />}>
              {!edited && !view.driveSyncedAt && (
                <button onClick={() => { setEdited(structuredClone(view)); setTodosText(view.todos.map(formatTodoEditLine).join("\n")); setEditFields(true); }}><Edit3 size={16} /> Bearbeiten</button>
              )}
              <button onClick={() => void share()}><Share2 size={16} /> Teilen</button>
              {calendarReady && (
                <button onClick={() => void toCalendar()}>
                  <CalendarDays size={16} />
                  {view.calendarSyncedAt ? "Kalender aktualisieren" : "In den Kalender"}
                </button>
              )}
              <button onClick={() => window.print()} disabled={!!edited}><Printer size={16} /> Als PDF drucken</button>
              <button onClick={download}><Download size={16} /> Markdown laden</button>
              {view.driveFolderId && (
                <a href={`https://drive.google.com/drive/folders/${encodeURIComponent(view.driveFolderId)}`} target="_blank" rel="noreferrer">
                  <FolderOpen size={16} /> Ordner in Drive
                </a>
              )}
              <DeleteMeeting
                id={view.id}
                title={view.title}
                driveFolderId={view.driveFolderId}
                onDeleted={() => navigate("/dashboard", { replace: true })}
              />
            </Menu>
          </div>
        </header>

        {error && <Notice>{error}</Notice>}
        {notice && <Notice kind="info">{notice}</Notice>}
        {view.speech?.liveWarning && <Notice>{view.speech.liveWarning}</Notice>}
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
          view.status !== "completed" && !edited && !needsSpeakerReview(view.speech) && (
            <div className="analysis-recovery panel no-print">
              <div>
                <h2>Analyse erneut starten</h2>
                <p className="muted">{view.error || "Starte die KI-Analyse."}</p>
              </div>
              <button className="btn btn-primary" onClick={() => retry()} disabled={!!busy || !!edited}><WandSparkles size={18} /> Bericht erstellen</button>
            </div>
          )
        )}

        {!running && needsSpeakerReview(view.speech) && (
          <section className="panel speaker-review no-print">
            <h2>Nur offene Zuordnungen</h2>
            <p>Passende Live-Namen und Audioquellen sind übernommen. Hier bleiben nur unklare Beiträge. Du kannst sie zuordnen oder direkt fortfahren.</p>
            {audioLoading && <p role="status">Originalaufnahme laden …</p>}
            {audioUrl && <audio ref={audio} src={audioUrl} controls style={{ width: "100%" }}
              onLoadedMetadata={() => { if (audio.current) { audio.current.currentTime = seekTo.current; void audio.current.play().catch(() => {}); } }} />}
            <SpeakerReview speech={view.speech!} onListen={listen} onChange={speech => setEdited({ ...view, speech, transcription: renderTranscript(speech), status: "pending", error: "" })} />
            <details className="speaker-advanced"><summary>Weitere Korrekturen</summary>
              <SpeakerEditor speech={view.speech!} onListen={listen} onChange={speech => setEdited({ ...view, speech, transcription: renderTranscript(speech), status: "pending", error: "" })} />
            </details>
            <div className="speaker-review-actions">
              <button className="btn btn-primary" onClick={() => retry("reviewed")}>Weiter zur Zusammenfassung</button>
              <button className="btn" onClick={() => retry("skipped")}>Prüfung überspringen</button>
            </div>
          </section>
        )}

        <div className="report-intel">
          <section className="is-summary">
            <h2><FileText size={15} /> Zusammenfassung</h2>
            {edited && editFields ? (
              <textarea className="field" value={view.summary} onChange={e => setEdited({ ...view, summary: e.target.value })} />
            ) : (
              <p>{view.summary || "Noch keine Zusammenfassung erstellt."}</p>
            )}
          </section>
          <section>
              <h2><CheckSquare size={15} /> Aufgaben</h2>
              {edited && editFields ? (
                <>
                  <p className="muted small" id="todo-syntax">
                    Eine Aufgabe pro Zeile. „@Name“ für die verantwortliche
                    Person, „bis 2026-09-30“ für ein Datum, „- [x]“ für
                    erledigt.
                  </p>
                  <textarea
                    className="field"
                    aria-describedby="todo-syntax"
                    value={todosText}
                    onChange={e => {
                      setTodosText(e.target.value);
                      setEdited({
                        ...view,
                        todos: e.target.value
                          .split("\n")
                          .map(line => parseTodoLine(line, todoLineDone(line)))
                          .filter((t): t is Todo => t !== null),
                      });
                    }}
                  />
                </>
              ) : view.todos?.length ? (
                <ul className="todo-list">
                  {view.todos.map((todo, i) => (
                    <li key={i} className={todo.done ? "is-done" : ""}>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!todo.done}
                          disabled={!!edited}
                          onChange={e => toggleTodo(i, e.target.checked)}
                        />
                        <span>
                          {todo.text}
                          {(todo.owner || todo.due) && (
                            <small>
                              {todo.owner}
                              {todo.owner && todo.due ? " · " : ""}
                              {todo.due ? `bis ${dayKeyLabel(todo.due, { day: "numeric", month: "short" })}` : ""}
                            </small>
                          )}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Keine Aufgaben erkannt.</p>
              )}

            </section>
            <section>
              <h2><Lightbulb size={15} /> Erkenntnisse</h2>
              {edited && editFields ? (
                <textarea className="field" value={view.takeaways.join("\n")} onChange={e => setEdited({ ...view, takeaways: e.target.value.split("\n") })} />
              ) : view.takeaways?.length ? (
                <ul>{view.takeaways.map((t, i) => <li key={i}>{t}</li>)}</ul>
              ) : (
                <p className="muted">Keine Erkenntnisse erkannt.</p>
              )}
          </section>
        </div>
      </fieldset>

      {/* Outside the guard: a running analysis must not grey out the transcript
          the page invites you to keep reading. */}
      <section className="report-transcript">
          <h2>Transkript</h2>
          {view.speech && view.speech.phase !== "final" && <p className="muted" role="status">Live-Transkript. Es wird direkt für die Zusammenfassung verwendet.</p>}
          {view.speech ? (
            <>
              <TranscriptTimeline transcript={view.transcription} speech={view.speech} startedAt={view.date}
                onRename={busy || running ? undefined : (id, name) => {
                  const speech = renameSpeaker(view.speech!, id, name);
                  setEdited({ ...view, speech, transcription: renderTranscript(speech),
                    status: "pending", error: "Sprechernamen geändert. Zusammenfassung aus dem gespeicherten Transkript aktualisieren." });
                }} />
              {edited && !needsSpeakerReview(view.speech) && <details className="speaker-advanced"><summary>Weitere Transkriptkorrekturen</summary>
                <SpeakerEditor speech={view.speech} onChange={speech => setEdited({ ...view, speech, transcription: renderTranscript(speech), status: "pending", error: "Transkript korrigiert. Bericht aus dem gespeicherten Text erneut erstellen." })} />
              </details>}
            </>
          ) : edited ? (
            <textarea className="field" value={view.transcription} onChange={e => setEdited({ ...view, transcription: e.target.value })} />
          ) : (
            <TranscriptTimeline transcript={view.transcription} startedAt={view.date}
              empty="Für dieses Meeting wurde kein Transkript gespeichert." />
          )}
      </section>
    </>
  );
}
