import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { transcriptIsElsewhere } from "../lib/reportProjection";
import {
  archiveAudioId,
  archiveFolderLink,
  archiveSyncedAt,
  reportIndexCollection,
} from "../../shared/storage";
import { withCalendarFreshness } from "../../shared/calendarNotes";
import { processingSourceKey } from "../../shared/processing";
import { ensureMicrosoftToken } from "../lib/microsoft";
import { downloadOneDrive } from "../lib/onedrive";
import { restoreReportTranscript } from "../lib/restoreTranscript";
import { hasAnyCalendarGrant, subscribeCalendar } from "../lib/calendar";
import { ConsentRecordPanel } from "../components/ConsentRecordPanel";
import { useParams, useSearchParams, Link, useNavigate } from "react-router-dom";
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
  ShieldCheck,
} from "lucide-react";
import {
  Busy,
  Notice,
  Status,
  dateTimeLabel,
} from "../components/UI";
import Menu from "../components/Menu";
import DeleteMeeting from "../components/DeleteMeeting";
import AssignEvent from "../components/AssignEvent";
import { shareReport } from "../lib/share";
import { syncReportToCalendar } from "../lib/calendarSync";
import {
  dayKeyLabel,
  formatDuration,
  meetingDurationMs,
  meetingStatus,
  plural,
  speakerNamesOf,
  summarise,
} from "../lib/meetingMeta";
import {
  formatTodoEditLine,
  parseTodoLine,
  todoLineDone,
  type Todo,
} from "../../shared/analysis";
import type { ReportData } from "../types";
import { connectGoogle, ensureDriveToken, errorMessage } from "../lib/session";
import { getReport, saveReport, uid } from "../lib/reports";
import {
  backupDraft,
  syncReport,
  analyzeDraft,
  restoreDraft,
} from "../lib/workflow";
import {
  deleteDraft,
  getDraft,
  getLocal,
  putDraft,
  ReportConflictError,
  watchLocalReports,
} from "../lib/local";
import {
  clearJob,
  jobFor,
  subscribeJobs,
  handoffServerProcessing,
  startProcessing,
} from "../lib/pipeline";
import { processingAvailable } from "../lib/serverProcessing";
import { reportToMarkdown } from "../lib/markdown";
import TranscriptTimeline from "../components/TranscriptTimeline";
import MeetingAudioPlayer from "../components/MeetingAudioPlayer";
import RetranscriptionDialog from "../components/RetranscriptionDialog";
import SummaryContent from "../components/SummaryContent";
import SpeakerReview from "../components/SpeakerReview";
import SpeakerEditor from "../components/SpeakerEditor";
import {
  renderTranscript,
  needsSpeakerReview,
  renameSpeaker,
} from "../../shared/transcription";
import { prepareTranscript } from "../lib/prepareTranscript";
import { downloadDriveFile } from "../lib/drive";
import { withWebmDuration } from "../lib/webmDuration";
import "./report-workspace.css";
import {
  forgetReportEdit,
  hasReportEdits,
  pendingArchive,
  recoverReportEdit,
  rememberReportEdit,
} from "../lib/reportEdits";

type ReportPageProps = { report?: ReportData; dirty?: boolean };
async function confirmSavedReport(owner: string, expected: ReportData) {
  const checkOwner = () => {
    if (uid() !== owner) throw Error("Das angemeldete Konto hat sich geändert.");
  };
  checkOwner();
  const saved = await getLocal(owner, expected.id, { index: expected.home ? "meetings" : "reports" });
  checkOwner();
  if (!saved || Object.keys({ ...expected, ...saved.report }).some(key =>
    key !== "updatedAt" && key !== "transcriptRevision" &&
    JSON.stringify(expected[key as keyof ReportData]) !== JSON.stringify(saved.report[key as keyof ReportData])))
    throw new ReportConflictError();
  return saved;
}
export default function ReportPage(props: ReportPageProps) {
  const { id } = useParams();
  const [search] = useSearchParams();
  // Router reuses a route element when only :id changes. Isolate each draft,
  // audio request and subscription instead of carrying them to the next report.
  const identity = id || props.report?.id;
  const index = search.get("index") || (props.report ? reportIndexCollection(props.report) : "");
  return <ReportDetail key={index ? `${identity}:${index}` : identity} {...props} />;
}

export function ReportDetail({
  report: initialReport,
  dirty: initialDirty,
}: ReportPageProps) {
  const params = useParams();
  const [search] = useSearchParams();
  const requestedIndex = search.get("index");
  const index = requestedIndex === "reports" || requestedIndex === "meetings" ? requestedIndex : undefined;
  const [report, setReport] = useState<ReportData | undefined>(initialReport);
  const [dirty, setDirty] = useState(initialDirty || false);
  const [edited, setEdited] = useState<ReportData>();
  const [editFields, setEditFields] = useState(false);
  const [loading, setLoading] = useState(!initialReport);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob>();
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioPosition, setAudioPosition] = useState<number>();
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [retranscriptionSource, setRetranscriptionSource] = useState<ReportData>();
  const retranscriptionRequest = useRef(false);
  const [assigning, setAssigning] = useState(false);
  const [focusTurnId, setFocusTurnId] = useState<string>();
  const [inlineEditing, setInlineEditing] = useState(false);
  const deletionWarning = useRef("");
  const navigate = useNavigate();
  const [todosText, setTodosText] = useState("");
  const editBase = useRef<string | null>(initialReport?.updatedAt ?? null);
  const recovered = useRef("");
  const [conflict, setConflict] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const hasEdits = !!report && !!edited && hasReportEdits(report, edited);
  const recoveryReady = useRef(false);
  useEffect(() => {
    // The saved report owns browser history/tab labels, not the editor draft.
    if (report) document.title = `${report.title.trim() || "Unbenanntes Meeting"} · CheatMeet`;
  }, [report?.id, report?.title]);
  useEffect(() => {
    if (!report || recovered.current === report.id) return;
    recovered.current = report.id;
    const draft = recoverReportEdit(uid(), report);
    if (draft) {
      editBase.current = draft.baseUpdatedAt;
      setEdited(draft.report);
      setTodosText(draft.todosText);
      setEditFields(draft.editFields);
      setConflict(draft.baseUpdatedAt !== (report.updatedAt ?? null));
      setNotice(
        "Ungespeicherte Änderungen auf diesem Gerät wiederhergestellt. Bitte prüfen und speichern.",
      );
    }
    recoveryReady.current = true;
  }, [report]);
  useEffect(() => {
    if (!report || !recoveryReady.current || !edited) return;
    setRecoveryFailed(
      !rememberReportEdit(uid(), {
        report: edited,
        baseUpdatedAt: editBase.current,
        todosText,
        editFields,
      }),
    );
  }, [report?.id, edited, todosText, editFields]);
  useEffect(() => {
    if (!hasEdits && !inlineEditing) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [hasEdits, inlineEditing]);
  function cancelEdits() {
    if (!report || busy) return;
    forgetReportEdit(uid(), report.id, { index: reportIndexCollection(report) });
    setEdited(undefined);
    setEditFields(false);
    setConflict(false);
    setRecoveryFailed(false);
    setFocusTurnId(undefined);
  }
  function beginEdit() {
    if (!report || busy) return;
    editBase.current = report.updatedAt ?? null;
    setEdited(structuredClone(report));
    setTodosText(report.todos.map(formatTodoEditLine).join("\n"));
    setEditFields(true);
  }
  // The token is usually minted after this mounts; a bare read would leave the
  // calendar action missing for the whole visit.
  const calendarReady = useSyncExternalStore(
    subscribeCalendar,
    () =>
      hasAnyCalendarGrant(
        report?.calendarEventId
          ? report.calendarProvider || "google"
          : undefined,
        report?.calendarEventId ? report.calendarConnectionId : undefined,
      ),
    () => false,
  );
  const calendarPickerReady = useSyncExternalStore(subscribeCalendar, () => hasAnyCalendarGrant(), () => false);
  const audio = useRef<HTMLDivElement>(null);
  const seekTo = useRef(0);
  const audioRequest = useRef(0);
  useEffect(() => {
    audioRequest.current++;
    setAudioBlob(undefined);
    setAudioLoading(false);
    setAudioPosition(undefined);
    setAudioPlaying(false);
    return () => {
      audioRequest.current++;
    };
  }, [params.id, initialReport?.id, report && processingSourceKey(report), report && archiveAudioId(report), report?.audioDeletedAt]);

  useEffect(() => {
    if (initialReport) return;
    let active = true;
    const load = async () => {
      try {
        const id = params.id!;
        const owner = uid();
        if (requestedIndex !== null && !index) throw Error("Ungültiger Meeting-Speicher. Bitte den Bericht über die Übersicht öffnen.");
        // A finished report is a saved report, not a draft: the draft is deleted
        // once it has been analysed and exported.
        const selection = index ? { index } as const : undefined;
        const local = await getLocal(owner, id, selection);
        const draft = local ? undefined : await getDraft(index === "meetings" ? `${owner}:microsoft` : owner, id, !!index);
        const stored =
          local || (draft ? undefined : await getReport(owner, id, selection));
        if (!active || uid() !== owner) return;
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
    return () => {
      active = false;
    };
  }, [initialReport, params.id, requestedIndex]);

  const view = edited || report;
  const liveState = useRef({ report, edited, busy });
  liveState.current = { report, edited, busy };
  useEffect(() => {
    const id = params.id || initialReport?.id;
    if (!id) return;
    const owner = uid();
    let active = true;
    let request = 0;
    const refresh = async () => {
      const currentRequest = ++request;
      const expected = liveState.current.report;
      if (!expected) return;
      const stored = await getLocal(owner, id, { index: reportIndexCollection(expected) });
      if (!active || currentRequest !== request || uid() !== owner || !stored)
        return;
      const state = liveState.current;
      if (state.busy) return; // The writer reads back its exact committed revision.
      if (
        state.edited &&
        (stored.report.updatedAt ?? null) !== editBase.current
      )
        setConflict(true);
      setReport(stored.report);
      setDirty(stored.dirty);
    };
    const stop = watchLocalReports(owner, () => void refresh().catch(() => {}));
    void refresh().catch(() => {});
    return () => {
      active = false;
      stop();
    };
  }, [params.id, initialReport?.id, index]);
  const duration = view ? meetingDurationMs(view) : 0;
  const speakers = speakerNamesOf(view?.speech);
  const job = useSyncExternalStore(subscribeJobs, () =>
    report ? jobFor(report.id, report) : undefined,
  );
  const running =
    !!job &&
    job.stage !== "done" &&
    job.stage !== "error" &&
    job.stage !== "review";

  function correctTranscript(
    patch: Pick<ReportData, "transcription"> &
      Partial<Pick<ReportData, "speech">>,
  ) {
    if (!view || busy || running) return;
    if (!edited) {
      editBase.current = report?.updatedAt ?? null;
      setTodosText(view.todos.map(formatTodoEditLine).join("\n"));
    }
    setEdited({ ...view, ...patch, summaryNeedsRefresh: true, error: "" });
  }
  function editTurn(id: string) {
    if (busy || running) return;
    if (!edited) beginEdit();
    setFocusTurnId(id);
  }

  // The background pipeline writes each step locally; mirror it into the view
  // rather than leaving a stale report on screen.
  useEffect(() => {
    if (!job || !report) return;
    let active = true;
    const owner = uid();
    getLocal(owner, job.reportId, { index: reportIndexCollection(report) })
      .then((stored) => {
        if (!active || uid() !== owner || !stored) return;
        if (
          liveState.current.edited &&
          (stored.report.updatedAt ?? null) !== editBase.current
        )
          setConflict(true);
        setReport(stored.report);
        setDirty(stored.dirty);
        if (job.stage === "done") {
          setNotice(
            job.warning ||
              `In ${stored.report.home ? "OneDrive" : "Google Drive"} gespeichert.`,
          );
          clearJob(job.reportId, report);
        }
        if (job.stage === "error") {
          setError(job.error || "Der Vorgang ist fehlgeschlagen.");
          clearJob(job.reportId, report);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [job]);

  /** Task ticks patch the latest index/local copy. The notice keeps explicit
   * archive-save work separate; a tick must not overwrite unrelated edits. */
  async function toggleTodo(index: number, done: boolean) {
    // While an edit is open, Speichern/Abbrechen owns the document: a tick
    // would otherwise persist the whole pending draft behind the user's back.
    if (!view || busy || running || edited) return;
    const owner = uid();
    const selected = view.todos[index];
    if (!selected) return;
    setBusy("Aufgabe speichern …");
    setError("");
    try {
      const stored = await getLocal(owner, view.id, { index: reportIndexCollection(view) });
      if (uid() !== owner) return;
      const latest = stored?.report || view;
      const matches = latest.todos
        .map((todo, i) => ({ todo, i }))
        .filter(
          ({ todo }) =>
            todo.text === selected.text &&
            todo.owner === selected.owner &&
            todo.due === selected.due,
        );
      const target = latest.todos[index];
      const targetIndex =
        target &&
        target.text === selected.text &&
        target.owner === selected.owner &&
        target.due === selected.due
          ? index
          : matches.length === 1
            ? matches[0].i
            : -1;
      if (targetIndex < 0)
        throw Error(
          "Die Aufgabe wurde inzwischen geändert. Bitte die aktuelle Fassung prüfen.",
        );
      const next = withCalendarFreshness(latest, {
        ...latest,
        ...pendingArchive(latest),
        todos: latest.todos.map((todo, i) =>
          i === targetIndex ? { ...todo, done: done || undefined } : todo,
        ),
      });
      const warning = await saveReport(next, {
        expectedUpdatedAt: stored?.report.updatedAt ?? null,
      });
      if (uid() !== owner) return;
      const saved = await getLocal(owner, view.id, { index: reportIndexCollection(view) });
      if (uid() !== owner) return;
      setReport(saved?.report || next);
      setDirty(saved?.dirty ?? !!warning);
      setNotice(
        [
          "Aufgabe gespeichert.",
          next.archiveBaseSyncedAt &&
            "Die Archivkopie wird beim nächsten Speichern aktualisiert.",
          warning,
        ]
          .filter(Boolean)
          .join(" "),
      );
      if (warning) setError(warning);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  async function save(syncDrive: boolean) {
    if (!view || busy || running) return;
    const owner = uid();
    const checkOwner = () => {
      if (uid() !== owner)
        throw Error("Das angemeldete Konto hat sich geändert.");
    };
    setBusy("Bericht speichern …");
    setError("");
    setNotice("");
    try {
      const next = withCalendarFreshness(report || view, {
        ...view,
        ...(hasEdits ? pendingArchive(view) : {}),
      });
      const warning = await saveReport(next, {
        expectedUpdatedAt: edited
          ? editBase.current
          : (report?.updatedAt ?? null),
      });
      checkOwner();
      const stored = await confirmSavedReport(owner, next);
      checkOwner();
      const saved = stored.report;
      setReport(saved);
      setDirty(stored.dirty);
      forgetReportEdit(owner, next.id, { index: reportIndexCollection(next) });
      setEdited(undefined);
      setEditFields(false);
      setConflict(false);
      setNotice(warning || "Auf diesem Gerät gespeichert.");
      if (syncDrive) {
        const token = saved.home
          ? (await ensureMicrosoftToken(saved.home.connectionId)).accessToken
          : (await ensureDriveToken()) || (await connectGoogle());
        checkOwner();
        const latest = await getLocal(owner, saved.id, { index: reportIndexCollection(saved) });
        checkOwner();
        if (!latest || latest.report.updatedAt !== saved.updatedAt)
          throw Error(
            "Die gespeicherte Fassung wurde inzwischen geändert. Bitte vor dem Archiv-Upload erneut prüfen.",
          );
        const result = await syncReport(saved, token);
        checkOwner();
        setReport(result.report);
        setDirty(!!result.warning);
        setNotice(
          [
            `In ${saved.home ? "OneDrive" : "Google Drive"} gespeichert.`,
            warning,
            result.warning,
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
    } catch (e) {
      if (e instanceof Error && e.name === "ReportConflictError")
        setConflict(true);
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function retry(
    reviewDecision?: "reviewed" | "skipped",
    refreshSummary = false,
  ) {
    if (!view || busy || running || edited) return;
    const report = view;
    const owner = uid();
    const checkOwner = () => {
      if (uid() !== owner)
        throw new Error("Das angemeldete Konto wurde gewechselt.");
    };
    setBusy("Lade...");
    setError("");
    try {
      const t = report.home
        ? (await ensureMicrosoftToken(report.home.connectionId)).accessToken
        : (await ensureDriveToken()) || (await connectGoogle());
      checkOwner();
      const currentReport = await getLocal(owner, report.id, { index: report.home ? "meetings" : "reports" });
      checkOwner();
      if (
        currentReport &&
        currentReport.report.updatedAt !== report.updatedAt
      ) {
        setReport(currentReport.report);
        throw Error(
          "Eine neuere Fassung wurde gespeichert. Bitte die aktuelle Fassung prüfen und die Analyse erneut starten.",
        );
      }
      let expectedUpdatedAt = currentReport?.report.updatedAt ?? null;
      const local = await getDraft(report.home ? `${owner}:microsoft` : owner, report.id, true);
      checkOwner();
      const syncSource = async (source: ReportData) => {
        const result = await syncReport(source, t);
        checkOwner();
        if (result.warning) setError(result.warning);
        return result.report;
      };
      if (await processingAvailable()) {
        checkOwner();
        if (report.home && !report.home.reportId) {
          if (!local)
            throw new Error(
              "Der OneDrive-Upload ist noch nicht vollständig. Bitte den lokalen Entwurf unter Aufnahme öffnen.",
            );
          await startProcessing({
            owner,
            draft: { ...local, report },
            analyze: true,
          });
          checkOwner();
          return;
        }
        let source = report;
        if (
          refreshSummary &&
          (!source.transcription.trim() || source.transcriptStale)
        )
          throw Error(
            "Bitte zuerst das aktuelle Transkript aus dem Archiv laden. Es wird keine neue Transkription gestartet.",
          );
        if (refreshSummary && !archiveSyncedAt(source)) {
          source = await syncSource(source);
          checkOwner();
        }
        if (reviewDecision && needsSpeakerReview(source.speech)) {
          source = {
            ...source,
            speech: { ...source.speech!, speakerReview: reviewDecision },
            transcription: renderTranscript(source.speech!),
            error: "",
          };
          source = await syncSource(source);
          checkOwner();
        }
        await handoffServerProcessing(owner, source, {
          analyze: true,
          regenerate: refreshSummary && !!source.summary.trim(),
          ...(refreshSummary ? { retranscribe: false } : {}),
        });
        checkOwner();
        setNotice(
          "Vom Server übernommen. Du kannst diesen Tab schließen; der Auftrag läuft weiter.",
        );
        return;
      }
      if (report.home)
        throw new Error(
          "OneDrive-Verarbeitung ist auf diesem Server nicht verfügbar. Der Entwurf bleibt erhalten.",
        );
      if (
        refreshSummary &&
        (!report.transcription.trim() || report.transcriptStale)
      )
        throw Error(
          "Bitte zuerst das aktuelle Transkript aus dem Archiv laden. Es wird keine neue Transkription gestartet.",
        );
      const canUseSavedTranscript =
        refreshSummary ||
        report.speech?.phase === "final" ||
        (!report.speech && !!report.transcription.trim());
      const canUseDriveStream = !!report.speech && !!report.rawAudioUrl;
      const d =
        local?.report.id === report.id && local.audio
          ? { ...local, report }
          : canUseSavedTranscript || canUseDriveStream
            ? { report }
            : await restoreDraft(report, t);
      checkOwner();
      if (local?.speakerReference && !refreshSummary)
        d.speakerReference = local.speakerReference;
      if (local?.retranscribe && !refreshSummary) d.retranscribe = true;
      if (refreshSummary) {
        d.retranscribe = false;
        // analyzeDraft prepares its input too: a corrected saved text is final,
        // never a request to obtain another paid audio transcript.
        if (d.report.speech)
          d.report = {
            ...d.report,
            speech: { ...d.report.speech, phase: "final" },
          };
      }
      if (local?.report.id === report.id) {
        await backupDraft(d, t, setBusy, expectedUpdatedAt);
        expectedUpdatedAt = d.report.updatedAt ?? null;
      }
      checkOwner();
      setBusy("Transkript vorbereiten …");
      await prepareTranscript(d, t, { expectedUpdatedAt });
      expectedUpdatedAt = d.report.updatedAt ?? null;
      checkOwner();
      if (reviewDecision && needsSpeakerReview(d.report.speech)) {
        d.report = {
          ...d.report,
          speech: { ...d.report.speech!, speakerReview: reviewDecision },
          transcription: renderTranscript(d.report.speech!),
          error: "",
        };
        await putDraft(owner, d);
        checkOwner();
      }
      if (needsSpeakerReview(d.report.speech)) {
        d.report = { ...d.report, ...pendingArchive(d.report), status: "pending", error: "" };
        const warning = await saveReport(d.report, { expectedUpdatedAt });
        checkOwner();
        const saved = await confirmSavedReport(owner, d.report);
        d.report = saved.report;
        setReport(d.report);
        setDirty(saved.dirty);
        setEdited(undefined);
        setEditFields(false);
        const result = await syncReport(d.report, t);
        checkOwner();
        setReport(result.report);
        setDirty(!!result.warning);
        if (warning) setError(warning);
        setNotice(
          result.warning ||
            "Transkript bereit. Bitte Sprecher prüfen oder Prüfung überspringen.",
        );
        return;
      }
      setBusy("Analysiere...");
      const next = { ...(await analyzeDraft(d, { expectedUpdatedAt })), ...pendingArchive(d.report), summaryNeedsRefresh: false };
      expectedUpdatedAt = d.report.updatedAt ?? null;
      checkOwner();
      const warning = await saveReport(next, { expectedUpdatedAt });
      checkOwner();
      const saved = await confirmSavedReport(owner, next);
      d.report = saved.report;
      setReport(saved.report);
      setDirty(saved.dirty);
      setEdited(undefined);
      setEditFields(false);
      if (local?.report.id === report.id)
        await putDraft(owner, d);
      const result = await syncReport(saved.report, t);
      checkOwner();
      // The pipeline drops the draft on success for a reason: left behind, it
      // reappears as an unfinished recording and "Fortsetzen" can overwrite
      // the finished report with its own pre-analysis state.
      await deleteDraft(owner, result.report.id, { index: report.home ? "meetings" : "reports" }).catch(() => {});
      setReport(result.report);
      setDirty(!!result.warning);
      if (warning) setError(warning);
      setNotice(result.warning || "Analyse abgeschlossen.");
    } catch (e) {
      if (e instanceof Error && e.name === "ReportConflictError") setConflict(true);
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function retranscribe(source: ReportData) {
    if (busy || running || edited || retranscriptionRequest.current) return;
    const owner = uid();
    const stillOwner = () => { try { return uid() === owner; } catch { return false; } };
    const checkOwner = () => {
      if (!stillOwner()) throw Error("Das angemeldete Konto hat sich geändert.");
    };
    retranscriptionRequest.current = true;
    setBusy("Volltranskription wird vorbereitet …");
    setError("");
    setNotice("");
    try {
      const current = await getLocal(owner, source.id, { index: reportIndexCollection(source) });
      checkOwner();
      if (!current || current.report.updatedAt !== source.updatedAt ||
          processingSourceKey(current.report) !== processingSourceKey(source))
        throw new ReportConflictError();
      if (current.dirty || !archiveSyncedAt(current.report))
        throw Error("Bitte den aktuellen Bericht zuerst im Dateiarchiv speichern.");
      if (current.report.audioDeletedAt || !archiveAudioId(current.report))
        throw Error("Die Originalaufnahme ist für dieses Meeting nicht mehr verfügbar.");
      const available = await processingAvailable();
      checkOwner();
      if (!available) throw Error("Volltranskription ist auf diesem Server nicht eingerichtet. Deine bisherige Fassung bleibt erhalten.");
      await handoffServerProcessing(owner, current.report, {
        analyze: true,
        retranscribe: true,
        regenerate: true,
      });
      checkOwner();
    } catch (cause) {
      if (!stillOwner()) return;
      if (cause instanceof Error && cause.name === "ReportConflictError") setConflict(true);
      setError(errorMessage(cause));
    } finally {
      retranscriptionRequest.current = false;
      if (stillOwner()) setBusy("");
    }
  }

  async function playLoadedAudio() {
    const player = audio.current?.querySelector("audio");
    if (!player) return;
    const owner = uid();
    const request = audioRequest.current;
    const current = () => {
      try { return uid() === owner && request === audioRequest.current && audio.current?.querySelector("audio") === player; }
      catch { return false; }
    };
    try {
      player.currentTime = seekTo.current;
      await player.play();
    } catch (cause) {
      if (!current() || cause instanceof Error && cause.name === "AbortError") return;
      setError(
        "Wiedergabe konnte nicht gestartet werden. Bitte die Wiedergabetaste am Audioplayer verwenden.",
      );
    }
  }

  async function listen(atMs: number) {
    if (!view || view.audioDeletedAt) return;
    seekTo.current = Math.max(0, atMs) / 1000;
    if (audioBlob && audio.current) {
      await playLoadedAudio();
      return;
    }
    if (audioLoading) return;
    const owner = uid();
    const request = ++audioRequest.current;
    const current = () => {
      try {
        return uid() === owner && request === audioRequest.current;
      } catch {
        return false;
      }
    };
    setAudioLoading(true);
    try {
      const draft = await getDraft(view.home ? `${owner}:microsoft` : owner, view.id, true);
      if (!current()) return;
      let blob = draft?.audio;
      if (!blob && view.home?.audioId)
        blob = await downloadOneDrive(view.home, view.home.audioId);
      if (!blob && !view.home && view.rawAudioUrl) {
        const token = (await ensureDriveToken()) || (await connectGoogle());
        if (!current()) return;
        blob = await downloadDriveFile(view.rawAudioUrl, token);
      }
      if (!current()) return;
      if (!blob) throw Error("Die Originalaufnahme ist hier nicht verfügbar.");
      blob = await withWebmDuration(blob, view.durationMs || 0);
      if (current()) setAudioBlob(blob);
    } catch (e) {
      if (current()) setError(errorMessage(e));
    } finally {
      if (current()) setAudioLoading(false);
    }
  }

  async function restoreTranscript() {
    if (!view || busy || running || edited) return;
    const owner = uid();
    setBusy("Transkript aus Archiv laden …");
    setError("");
    try {
      const restored = await restoreReportTranscript(owner, view);
      if (uid() !== owner) return;
      const stored = await getLocal(owner, view.id, { index: reportIndexCollection(view) });
      if (uid() !== owner) return;
      setReport(stored?.report || restored);
      setDirty(stored?.dirty || false);
      setNotice(
        "Vorhandenes Transkript aus dem angehefteten Archiv geladen. Keine neue Transkription gestartet.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  /** Two-way: updates the matched event, or creates one for a meeting that
   *  belonged to none. */
  async function toCalendar() {
    if (!view || busy || running || edited) return;
    const owner = uid();
    setBusy("Kalender wird aktualisiert …");
    setError("");
    setNotice("");
    try {
      const stored = await getLocal(owner, view.id, { index: reportIndexCollection(view) });
      if (uid() !== owner) return;
      const source = stored?.report || view;
      const patch = await syncReportToCalendar(source);
      if (uid() !== owner) return;
      // Calendar/index persistence is not a canonical-file update. Keep that
      // pending across reload and offer the existing explicit archive save.
      const next = {
        ...source,
        ...patch,
        ...pendingArchive(source),
      };
      const warning = await saveReport(next, {
        expectedUpdatedAt: source.updatedAt ?? null,
      });
      if (uid() !== owner) return;
      const saved = await getLocal(owner, view.id, { index: reportIndexCollection(view) });
      if (uid() !== owner) return;
      setReport(saved?.report || next);
      setDirty(saved?.dirty ?? !!warning);
      // syncReportToCalendar reports a refusal in the patch rather than
      // throwing, so the cleared link is persisted along with the reason.
      if (patch.calendarError) setError(patch.calendarError);
      setNotice(
        [
          !patch.calendarError &&
            (patch.calendarEventId && !source.calendarEventId
              ? "Termin im Kalender angelegt."
              : "Kalendereintrag aktualisiert."),
          warning
            ? "Kalenderdaten auf diesem Gerät gespeichert. Cloud-Index noch nicht bestätigt."
            : "Kalenderdaten auf diesem Gerät gespeichert und im Cloud-Index gesichert.",
          warning,
          `Dateiarchiv noch nicht aktualisiert. Bitte ausdrücklich „In ${source.home ? "OneDrive" : "Drive"} speichern“ wählen, bevor du den Bericht aus dem Archiv wiederherstellst.`,
        ]
          .filter(Boolean)
          .join(" "),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  async function share() {
    if (!view || edited || view.transcriptStale) return;
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
    if (!view || edited || view.transcriptStale) return;
    const url = URL.createObjectURL(
      new Blob([reportToMarkdown(view)], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-${view.date.slice(0, 10)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (loading) return <Busy text="Bericht laden …" />;
  if (!view)
    return (
      <>
        {error && <Notice>{error}</Notice>}
        <div className="empty panel">
          <FolderOpen size={36} />
          <h1>Bericht nicht verfügbar</h1>
          <Link className="btn" to="/dashboard">
            Zur Übersicht
          </Link>
        </div>
      </>
    );

  const editControls = edited && (
    <div
      className="speaker-review-actions no-print"
      role="group"
      aria-label="Berichtänderungen"
    >
      <button
        className="btn btn-primary"
        onClick={() => save(true)}
        disabled={!!busy || running}
      >
        <Save size={16} /> Speichern
      </button>
      <button
        className="btn"
        onClick={cancelEdits}
        disabled={!!busy || running}
      >
        Abbrechen
      </button>
    </div>
  );
  const retranscriptionReason = edited
    ? "Änderungen zuerst speichern oder verwerfen."
    : running || busy
      ? "Die laufende Verarbeitung zuerst abschließen lassen."
      : view.audioDeletedAt
        ? "Die Aufbewahrungsfrist der Originalaufnahme ist abgelaufen."
        : !archiveAudioId(view)
          ? "Die Originalaufnahme muss zuerst im Dateiarchiv gesichert werden."
          : dirty || !archiveSyncedAt(view)
            ? "Den aktuellen Bericht zuerst im Dateiarchiv speichern."
            : "";
  return (
    <div className="meeting-workspace">
      <fieldset
        disabled={!!busy || running}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <header className="report-head">
          <div className="report-head-main">
            <Link className="report-back no-print" to="/dashboard">
              <ArrowLeft size={14} /> Zur Übersicht
            </Link>
            {edited && editFields ? (
              <input
                className="title-input"
                aria-label="Titel des Meetings"
                placeholder="Unbenanntes Meeting"
                value={view.title}
                onChange={(e) => setEdited({ ...view, title: e.target.value })}
              />
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
              {view.calendarEventId && (
                <a
                  className="report-calendar"
                  href={
                    view.calendarLink ||
                    (view.calendarProvider === "microsoft"
                      ? "https://outlook.office.com/calendar/"
                      : "https://calendar.google.com/")
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  <CalendarDays size={13} /> Im Kalender
                </a>
              )}
              <Status
                status={meetingStatus(view)}
                syncedAt={archiveSyncedAt(view)}
                local={dirty}
                running={running}
              />
            </p>
          </div>
          <div className="report-head-actions no-print">
            {edited ? (
              editControls
            ) : !archiveSyncedAt(view) ? (
              <button className="btn btn-primary" onClick={() => save(true)}>
                <CloudUpload size={16} /> In {view.home ? "OneDrive" : "Drive"}{" "}
                speichern
              </button>
            ) : (
              <button className="btn" onClick={beginEdit}>
                <Edit3 size={16} /> Bearbeiten
              </button>
            )}
            <Menu title="Weitere Aktionen" icon={<MoreHorizontal size={18} />}>
              {!edited && !archiveSyncedAt(view) && (
                <button onClick={beginEdit}>
                  <Edit3 size={16} /> Bearbeiten
                </button>
              )}
              <button
                onClick={() => void share()}
                disabled={!!edited || !!view.transcriptStale}
              >
                <Share2 size={16} /> Teilen
              </button>
              {calendarPickerReady && (
                <button onClick={() => setAssigning(true)} disabled={!!edited}>
                  <CalendarDays size={16} /> Termin zuordnen
                </button>
              )}
              {calendarReady && (
                <button onClick={toCalendar} disabled={!!edited}>
                  <CalendarDays size={16} />
                  {view.calendarEventId
                    ? "Kalender aktualisieren"
                    : "Neuen Termin anlegen"}
                </button>
              )}
              <button
                onClick={() => window.print()}
                disabled={!!edited || !!view.transcriptStale}
              >
                <Printer size={16} /> Bericht als PDF drucken
              </button>
              <button
                onClick={download}
                disabled={!!edited || !!view.transcriptStale}
              >
                <Download size={16} /> Markdown laden
              </button>

              {archiveFolderLink(view) && (
                <a
                  href={archiveFolderLink(view)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FolderOpen size={16} /> Ordner in{" "}
                  {view.home ? "OneDrive" : "Drive"}
                </a>
              )}
              <DeleteMeeting
                id={view.id}
                title={view.title}
                driveFolderId={view.driveFolderId}
                home={view.home}
                onWarning={(message) => {
                  deletionWarning.current = message;
                  setError(message);
                }}
                onDeleted={(outcome) =>
                  navigate("/dashboard", {
                    replace: true,
                    state: {
                      deleteOutcome: outcome || {
                        removed: true,
                        warnings: deletionWarning.current
                          ? [deletionWarning.current]
                          : [],
                      },
                    },
                  })
                }
              />
            </Menu>
          </div>
        </header>

        {error && <Notice>{error}</Notice>}
        {notice && <Notice kind="info">{notice}</Notice>}
        {hasEdits && (
          <p className="muted no-print" role="status">
            Ungespeicherte Änderungen · beim Zurückkehren in diesem Tab
            wiederherstellbar.
          </p>
        )}
        {recoveryFailed && (
          <Notice>
            Die Entwurfskopie konnte nicht gespeichert werden. Bitte vor dem
            Verlassen speichern.
          </Notice>
        )}
        {conflict && (
          <Notice>
            Eine neuere gespeicherte Fassung liegt vor. Dein Entwurf bleibt
            erhalten. Zum Vergleichen kannst du ihn kopieren; mit Abbrechen
            lädst du die gespeicherte Fassung. Der alte Entwurf überschreibt sie
            nicht.
          </Notice>
        )}
        {view.speech?.liveWarning && <Notice>{view.speech.liveWarning}</Notice>}
        {busy && <Busy text={busy} />}

        {running ? (
          <div
            className="analysis-progress report-processing no-print"
            role="status"
            aria-live="polite"
          >
            <RefreshCw size={18} className="spin" />
            <div>
              <h2>{job!.message}</h2>
              <p className="muted">
                {job!.serverOwned
                  ? "Vom Server übernommen. Du kannst diesen Tab schließen; die Verarbeitung läuft weiter."
                  : "Du kannst weiterlesen und navigieren. Bitte diesen Tab bis zur Server-Übernahme geöffnet lassen."}
              </p>
            </div>
          </div>
        ) : (
          (view.status !== "completed" || view.summaryNeedsRefresh) &&
          !edited &&
          !needsSpeakerReview(view.speech) && (
            <div className="analysis-recovery panel no-print">
              <div>
                <h2>
                  {view.summaryNeedsRefresh
                    ? "Zusammenfassung nicht mehr aktuell"
                    : "Analyse erneut starten"}
                </h2>
                <p className="muted">
                  {view.summaryNeedsRefresh
                    ? "Sprecher oder Text wurden korrigiert. Aktualisiert nur die Zusammenfassung aus dem gespeicherten Text, ohne neue Audiotranskription."
                    : view.error || "Starte die KI-Analyse."}
                </p>
              </div>
              <button
                className="btn btn-primary"
                onClick={() => retry(undefined, !!view.summaryNeedsRefresh)}
                disabled={!!busy || !!edited}
              >
                <WandSparkles size={18} />{" "}
                {view.summaryNeedsRefresh
                  ? "Zusammenfassung aktualisieren"
                  : "Bericht erstellen"}
              </button>
            </div>
          )
        )}

        {!running && needsSpeakerReview(view.speech) && (
          <section className="panel speaker-review no-print">
            <h2>Nur offene Zuordnungen</h2>
            <p>
              Passende Live-Namen und Audioquellen sind übernommen. Hier bleiben
              nur unklare Beiträge. Du kannst sie zuordnen oder direkt
              fortfahren.
            </p>

            <SpeakerReview
              speech={view.speech!}
              onListen={listen}
              onChange={(speech) =>
                correctTranscript({
                  speech,
                  transcription: renderTranscript(speech),
                })
              }
            />
            <details className="speaker-advanced">
              <summary>Weitere Korrekturen</summary>
              <SpeakerEditor
                speech={view.speech!}
                disabled={!!busy || running}
                onListen={listen}
                onChange={(speech) =>
                  correctTranscript({
                    speech,
                    transcription: renderTranscript(speech),
                  })
                }
              />
            </details>
            <div className="speaker-review-actions">
              <button
                className="btn btn-primary"
                onClick={() => retry("reviewed", !!view.summaryNeedsRefresh)}
                disabled={!!edited}
              >
                Weiter zur Zusammenfassung
              </button>
              <button
                className="btn"
                disabled={!!edited}
                onClick={() => retry("skipped", !!view.summaryNeedsRefresh)}
              >
                Prüfung überspringen
              </button>
            </div>
            {edited && (
              <p className="muted">
                Sprecherkorrekturen zuerst speichern, dann mit der
                Zusammenfassung fortfahren.
              </p>
            )}
            {editControls}
          </section>
        )}

      </fieldset>
      <div className="report-columns">
      <fieldset
        className="report-overview"
        disabled={!!busy || running}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <div className="report-intel">
          {running && !view.summary && !view.todos.length && !view.takeaways.length ? (
            <section className="report-preparing" aria-label="Bericht wird erstellt">
              <h2><WandSparkles size={15} /> Dein Bericht entsteht</h2>
              <p className="muted">Das Transkript ist bereits lesbar. Zusammenfassung und nächste Schritte erscheinen hier, sobald sie bereit sind.</p>
              <div className="report-skeleton" aria-hidden="true"><i /><i /><i /><i /></div>
            </section>
          ) : <>
          <section className="is-summary">
            <h2>
              <FileText size={15} /> Zusammenfassung
            </h2>
            {edited && editFields ? (
              <textarea
                className="field"
                aria-label="Zusammenfassung bearbeiten"
                value={view.summary}
                onChange={(e) =>
                  setEdited({ ...view, summary: e.target.value })
                }
              />
            ) : (
              <SummaryContent text={view.summary || "Noch keine Zusammenfassung erstellt."} />
            )}
          </section>
          <section>
            <h2>
              <CheckSquare size={15} /> Aufgaben
            </h2>
            {edited && editFields ? (
              <>
                <p className="muted small" id="todo-syntax">
                  Eine Aufgabe pro Zeile. „@Name“ für die verantwortliche
                  Person, „bis 2026-09-30“ für ein Datum, „- [x]“ für erledigt.
                </p>
                <textarea
                  className="field"
                  aria-label="Aufgaben bearbeiten"
                  aria-describedby="todo-syntax"
                  value={todosText}
                  onChange={(e) => {
                    setTodosText(e.target.value);
                    setEdited({
                      ...view,
                      todos: e.target.value
                        .split("\n")
                        .map((line) => parseTodoLine(line, todoLineDone(line)))
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
                        onChange={(e) => toggleTodo(i, e.target.checked)}
                      />
                      <span>
                        {todo.text}
                        {(todo.owner || todo.due) && (
                          <small>
                            {todo.owner}
                            {todo.owner && todo.due ? " · " : ""}
                            {todo.due
                              ? `bis ${dayKeyLabel(todo.due, { day: "numeric", month: "short" })}`
                              : ""}
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
            <h2>
              <Lightbulb size={15} /> Erkenntnisse
            </h2>
            {edited && editFields ? (
              <textarea
                className="field"
                aria-label="Erkenntnisse bearbeiten"
                value={view.takeaways.join("\n")}
                onChange={(e) =>
                  setEdited({ ...view, takeaways: e.target.value.split("\n") })
                }
              />
            ) : view.takeaways?.length ? (
              <ul>
                {view.takeaways.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Keine Erkenntnisse erkannt.</p>
            )}
          </section>
          </>}
        </div>
      </fieldset>

      {/* Outside the guard: a running analysis must not grey out the transcript
          the page invites you to keep reading. */}
      <section className="report-transcript">
        <div className="report-section-head">
          <h2><FileText size={16} /> Transkript <span className="transcript-kind">{view.speech?.phase === "live" ? "Live" : "Gespeichert"}</span></h2>
          <button
            type="button"
            className="btn btn-ghost no-print"
            disabled={!!retranscriptionReason}
            aria-describedby={retranscriptionReason ? "retranscription-reason" : undefined}
            onClick={() => setRetranscriptionSource(structuredClone(view))}
          >
            <RefreshCw size={14} /> Gesamte Aufnahme neu transkribieren
          </button>
        </div>
        {retranscriptionReason && <p className="retranscription-reason no-print" id="retranscription-reason">{retranscriptionReason}</p>}
        {view.audioDeletedAt ? (
          <p className="muted audio-expired no-print">Die Originalaufnahme wurde nach der zugesagten Aufbewahrungsfrist gelöscht. Der gespeicherte Text bleibt erhalten.</p>
        ) : (
          <div ref={audio} className="report-audio no-print">
            <MeetingAudioPlayer
              blob={audioBlob}
              loading={audioLoading}
              durationMs={duration}
              onRequestPlay={listen}
              onReady={() => playLoadedAudio()}
              onTimeChange={setAudioPosition}
              onPlaybackChange={setAudioPlaying}
            />
          </div>
        )}
        {editControls}
        {(transcriptIsElsewhere(view) || view.transcriptStale) && (
          <div className="panel no-print">
            <p>
              {view.transcriptStale
                ? "Die lokale Transkriptkopie ist nicht mehr aktuell und wird nicht angezeigt oder exportiert."
                : `Das vollständige Transkript liegt im ${view.home ? "OneDrive" : "Google-Drive"}-Archiv.`}
            </p>
            <button
              className="btn"
              onClick={restoreTranscript}
              disabled={!!busy || running || !!edited}
            >
              <Download size={16} /> Transkript aus Archiv laden
            </button>
            <p className="muted small">
              Lädt vorhandenen Text. Keine neue KI-Analyse oder kostenpflichtige
              Audiotranskription.
            </p>
          </div>
        )}

        {!view.transcriptStale && view.speech ? (
          <>
            <TranscriptTimeline
              transcript={view.transcription}
              speech={view.speech}
              startedAt={view.date}
              positionMs={audioPosition}
              playing={audioPlaying}
              onListen={!view.audioDeletedAt ? listen : undefined}
              onEditTurn={editTurn}
              editingDisabled={!!busy || running}
              onEditing={setInlineEditing}
              onRename={(id, name) => {
                const speech = renameSpeaker(view.speech!, id, name);
                correctTranscript({
                  speech,
                  transcription: renderTranscript(speech),
                });
              }}
            />
            {edited && !needsSpeakerReview(view.speech) && (
              <details
                className="speaker-advanced"
                open={focusTurnId ? true : undefined}
              >
                <summary>Weitere Transkriptkorrekturen</summary>
                <SpeakerEditor
                  speech={view.speech}
                  disabled={!!busy || running}
                  onListen={!view.audioDeletedAt ? listen : undefined}
                  focusTurnId={focusTurnId}
                  actions={editControls}
                  onChange={(speech) =>
                    correctTranscript({
                      speech,
                      transcription: renderTranscript(speech),
                    })
                  }
                />
              </details>
            )}
          </>
        ) : edited && !view.transcriptStale && !transcriptIsElsewhere(view) ? (
          <textarea
            className="field"
            aria-label="Transkript bearbeiten"
            disabled={!!busy || running}
            value={view.transcription}
            onChange={(e) =>
              correctTranscript({ transcription: e.target.value })
            }
          />
        ) : (
          <TranscriptTimeline
            transcript={view.transcriptStale ? "" : view.transcription}
            startedAt={view.date}
            positionMs={audioPosition}
            playing={audioPlaying}
            onListen={!view.audioDeletedAt ? listen : undefined}
            empty={
              transcriptIsElsewhere(view)
                ? "Das vollständige Transkript ist auf diesem Gerät noch nicht geladen."
                : view.transcriptStale
                  ? "Transkriptversion nicht aktuell. Bitte aus dem Archiv laden."
                  : "Für dieses Meeting wurde kein Transkript gespeichert."
            }
          />
        )}
      </section>
      </div>
      <details className="report-consent">
        <summary><ShieldCheck size={15} /> Einwilligung und Aufbewahrung <span>{view.consent ? "Dokumentation ansehen" : "Kein Nachweis hinterlegt"}</span></summary>
        <ConsentRecordPanel report={view} />
      </details>
      {editControls}
      {retranscriptionSource && (
        <RetranscriptionDialog
          title={retranscriptionSource.title}
          report={retranscriptionSource}
          onClose={() => setRetranscriptionSource(undefined)}
          onConfirm={async () => {
            setRetranscriptionSource(undefined);
            await retranscribe(retranscriptionSource);
          }}
        />
      )}
      {assigning && !edited && (
        <AssignEvent
          report={summarise(view)}
          onClose={() => setAssigning(false)}
          onWarning={setError}
        />
      )}
    </div>
  );
}
