import { backupMicrosoftDraft, syncMicrosoftReport } from "./microsoftWorkflow";
import { downloadOneDrive } from "./onedrive";
import { doc, getDoc } from "firebase/firestore";
import { getRootFolder } from "./driveSettings";
import { auth, db } from "./firebase";
import { saveReport, uid } from "./reports";
import { putDraft, putLocal, getLocal, ReportConflictError } from "./local";
import {
  createSubFolder,
  uploadFileToFolder,
  downloadDriveFile,
  readDriveArchiveRevision,
} from "./drive";
import { audioExtension, validateAnalysis } from "../../shared/analysis";
import { reportFolderName, toArchive } from "./archive";
import { transcriptIsElsewhere } from "./reportProjection";
import {
  consentToMarkdown,
  reportToMarkdown,
  transcriptToMarkdown,
} from "./markdown";
import { refreshArchiveIndex } from "./archiveDrive";
import { withWebmDuration } from "./webmDuration";
import type { Draft, ReportData } from "../types";
import { prepareTranscript } from "./prepareTranscript";
import { needsSpeakerReview } from "../../shared/transcription";
import { withCalendarFreshness } from "../../shared/calendarNotes";

// An operation belongs to the account that started it, including across tab sign-outs.
export function ownedOperation() {
  const owner = uid();
  const assertOwner = () => {
    if (auth.currentUser?.uid !== owner)
      throw new Error(
        "Das angemeldete Konto hat sich geändert. Bitte den Vorgang im ursprünglichen Konto erneut starten.",
      );
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertOwner();
    try {
      const result = await operation();
      assertOwner();
      return result;
    } catch (error) {
      assertOwner();
      throw error;
    }
  };
  return { owner, assertOwner, run };
}
function localRevision(report: ReportData) {
  report.updatedAt = new Date(
    Math.max(Date.now(), (Date.parse(report.updatedAt || "") || 0) + 1),
  ).toISOString();
}

/**
 * Writes the permission next to the recording it covers, once.
 *
 * No existingId is passed: there is never a second version to replace, and
 * omitting it turns an accidental second call into a visible duplicate rather
 * than a silent overwrite of evidence.
 */
async function uploadConsent(
  report: ReportData,
  token: string,
  run: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  if (!report.consent || report.driveConsentId) return false;
  const id = await run(() =>
    uploadFileToFolder(
      new Blob([consentToMarkdown(report.consent!)], {
        type: "text/markdown;charset=utf-8",
      }),
      "einwilligung.md",
      "text/markdown",
      report.driveFolderId!,
      token,
    ),
  );
  report.driveConsentId = id;
  return true;
}

/** The summary prompt is optional; a missing or unreadable setting is not an error. */
async function summaryPreferences(owner: string): Promise<string> {
  try {
    const snapshot = await getDoc(
      doc(db, "users", owner, "settings", "preferences"),
    );
    return snapshot.exists() ? snapshot.data().summaryPrompt || "" : "";
  } catch (error) {
    console.warn("Could not load summary preferences", error);
    return "";
  }
}

export async function analyzeDraft(draft: Draft, options: { expectedUpdatedAt?: string | null } = {}): Promise<ReportData> {
  const { owner, run } = ownedOperation();
  await run(() => prepareTranscript(draft, undefined, options));
  if (needsSpeakerReview(draft.report.speech))
    throw new Error("Bitte zuerst die Sprecher prüfen oder die Prüfung überspringen.");
  const transcription = draft.report.transcription?.trim() || "";
  // Empty/failed live capture must never fall back to sending audio for ASR.
  if (draft.report.speech?.phase === "final" && !transcription) {
    if (draft.report.transcriptionOrigin === "live")
      throw new Error("Kein Live-Transkript vorhanden. Die Aufnahme bleibt gesichert; es wird keine erneute Transkription gestartet.");
    return withCalendarFreshness(draft.report, { ...draft.report, summary: "Keine Sprache erkannt.", todos: [], takeaways: [], status: "completed", error: "" });
  }
  if (!transcription && !draft.audio)
    throw new Error("Weder Transkript noch Audio vorhanden.");

  const token = await run(() => auth.currentUser!.getIdToken());
  const preferences = await run(() => summaryPreferences(owner));

  const formData = new FormData();
  // The recording already produced a transcript; re-uploading the audio would
  // pay for transcribing the whole meeting a second time.
  if (transcription) formData.append("transcription", transcription);
  else
    formData.append(
      "audio",
      draft.audio!,
      `recording.${audioExtension(draft.audio!.type)}`,
    );
  if (preferences) formData.append("preferences", preferences);

  const response = await run(() =>
    fetch("/api/analyze", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      signal: AbortSignal.timeout(300_000),
    }),
  );

  const data = await run(() =>
    response.json().catch(() => ({
      error: "Der Server hat keine gültige Antwort geliefert.",
    })),
  );
  
  if (!response.ok)
    throw new Error(
      data.error || `Analyse fehlgeschlagen (${response.status}).`,
    );
    
  const analysed = validateAnalysis(data);
  // A name the user typed is explicit intent and wins, but the model's title is
  // kept so the report can offer it.
  const chosen = draft.report.projectName?.trim();
  return withCalendarFreshness(draft.report, {
    ...draft.report,
    ...analysed,
    ...(transcription ? { transcription } : {}),
    ...(chosen ? { title: chosen } : {}),
    ...(chosen && analysed.title && analysed.title !== chosen
      ? { suggestedTitle: analysed.title }
      : {}),
    status: "completed",
    error: "",
  });
}
export async function backupDraft(
  draft: Draft,
  token: string,
  progress: (s: string) => void,
  expectedUpdatedAt?: string | null,
) {
  const { owner, run, assertOwner } = ownedOperation();
  const report = draft.report;
  if (report.home) return backupMicrosoftDraft(draft, progress, expectedUpdatedAt);
  const stored = await run(() => getLocal(owner, report.id, { index: report.home ? "meetings" : "reports" }));
  let expected = expectedUpdatedAt === undefined ? stored?.report.updatedAt ?? null : expectedUpdatedAt;
  if (stored && ((stored.report.updatedAt ?? null) !== expected || (report.updatedAt ?? null) !== expected)) throw new ReportConflictError();
  // Upload checkpoints are local and immediate. Advance only after CAS commits.
  const checkpoint = async () => {
    assertOwner();
    const next = { ...report };
    localRevision(next);
    await run(() => putLocal(owner, next, true, expected));
    expected = next.updatedAt ?? null;
    Object.assign(report, next);
    await run(() => putDraft(owner, draft));
  };
  if (!report.driveFolderId) {
    const parent = await run(() => getRootFolder(token));
    report.driveFolderId = await run(() =>
      createSubFolder(
        reportFolderName(report),
        parent,
        token,
      ),
    );
    await checkpoint();
  }
  // Before the audio, not after: the transcription and summary between here
  // and syncReport take minutes, and Drive must never hold a recording with
  // nothing authorising it.
  if (await uploadConsent(report, token, run)) await checkpoint();
  if (!report.rawAudioUrl && draft.audio) {
    progress("Audio in Google Drive sichern …");
    // MediaRecorder omits the container duration, so the stored file would not
    // be seekable in Drive or any player.
    const audio = await run(() =>
      withWebmDuration(draft.audio!, report.durationMs || 0),
    );
    report.rawAudioUrl = await run(() =>
      uploadFileToFolder(
        audio,
        `aufnahme.${audioExtension(draft.audio!.type)}`,
        draft.audio!.type,
        report.driveFolderId!,
        token,
      ),
    );
    await checkpoint();
  }
  assertOwner();
  return report;
}
export async function syncReport(report: ReportData, token: string) {
  const { owner, run, assertOwner } = ownedOperation();
  if (report.home) {
    const result = await run(() => syncMicrosoftReport(report));
    const saved = await run(() => getLocal(owner, report.id, { index: "meetings" }));
    if (!saved || Object.keys({ ...result.report, ...saved.report }).some(key =>
      key !== "updatedAt" && key !== "transcriptRevision" && JSON.stringify(result.report[key as keyof ReportData]) !== JSON.stringify(saved.report[key as keyof ReportData])))
      throw new ReportConflictError();
    Object.assign(report, saved.report);
    return { ...result, report: saved.report };
  }
  const stored = await run(() => getLocal(owner, report.id, { index: report.home ? "meetings" : "reports" }));
  // Saving a stub would overwrite the user's own Drive copy with it, which is
  // worse than anything the cloud index can do: the archive is the last copy.
  if (transcriptIsElsewhere(report) || stored?.report.transcriptStale)
    throw new Error(
      "Dieses Meeting liegt auf diesem Gerät nur als Kurzfassung vor. Bitte es zuerst aus Google Drive wiederherstellen.",
    );
  if (stored && (stored.report.updatedAt ?? null) !== (report.updatedAt ?? null))
    throw new ReportConflictError();
  const next: ReportData & { archiveBaseSyncedAt?: string } = { ...report };
  let expectedUpdatedAt = stored?.report.updatedAt ?? null;
  const archiveEtag = next.driveReportId
    ? await run(() => readDriveArchiveRevision(next, token))
    : undefined;
  // Keep completed upload IDs locally and on the caller's report if a later step fails.
  const checkpoint = async () => {
    assertOwner();
    localRevision(next);
    await run(() => putLocal(owner, next, true, expectedUpdatedAt));
    expectedUpdatedAt = next.updatedAt ?? null;
    Object.assign(report, next);
  };
  if (!next.driveFolderId) {
    const parent = await run(() => getRootFolder(token));
    next.driveFolderId = await run(() =>
      createSubFolder(
        reportFolderName(report),
        parent,
        token,
      ),
    );
    await checkpoint();
  }
  if (await uploadConsent(next, token, run)) await checkpoint();
  next.driveMarkdownId = await run(() =>
    uploadFileToFolder(
      new Blob([reportToMarkdown(next)], {
        type: "text/markdown;charset=utf-8",
      }),
      "zusammenfassung.md",
      "text/markdown",
      next.driveFolderId!,
      token,
      next.driveMarkdownId,
    ),
  );
  await checkpoint();
  
  if (next.transcription) {
    next.driveTranscriptId = await run(() =>
      uploadFileToFolder(
        new Blob([transcriptToMarkdown(next)], {
          type: "text/markdown;charset=utf-8",
        }),
        "transkript.md",
        "text/markdown",
        next.driveFolderId!,
        token,
        next.driveTranscriptId,
      ),
    );
    await checkpoint();
  }
  
  // Export the Markdown ID with the structured report so another device can update it.
  const latest = await run(() => getLocal(owner, next.id, { index: next.home ? "meetings" : "reports" }));
  if ((latest?.report.updatedAt ?? null) !== expectedUpdatedAt)
    throw new ReportConflictError();
  const syncedAt = new Date().toISOString();
  // This local pending-save baseline must not become part of the archive.
  next.archiveBaseSyncedAt = undefined;
  next.driveReportId = await run(() =>
    uploadFileToFolder(
      new Blob(
        [
          JSON.stringify(
            toArchive({ ...next, driveSyncedAt: syncedAt }, syncedAt),
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      "bericht_daten.json",
      "application/json",
      next.driveFolderId!,
      token,
      next.driveReportId,
      archiveEtag,
    ),
  );
  next.driveSyncedAt = syncedAt;
  await checkpoint();
  const warning = await run(() => saveReport(next, { expectedUpdatedAt }));
  const saved = await run(() => getLocal(owner, next.id, { index: next.home ? "meetings" : "reports" }));
  // The final index save owns a newer local revision than the upload
  // checkpoint. Confirm its content, not merely whichever revision is newest.
  if (!saved || Object.keys({ ...next, ...saved.report }).some(key =>
    key !== "updatedAt" && key !== "transcriptRevision" && JSON.stringify(next[key as keyof ReportData]) !== JSON.stringify(saved.report[key as keyof ReportData])))
    throw new ReportConflictError();
  Object.assign(next, saved.report);
  Object.assign(report, saved.report);
  // Best effort: the overview is a convenience for whoever reads the folder
  // later, and a saved meeting must never fail because it could not refresh.
  try {
    await run(() => refreshArchiveIndex(owner, token, syncedAt));
  } catch {
    // The per-meeting files are the source of truth and are already written.
  }
  return { report: next, warning };
}
export async function restoreDraft(
  report: ReportData,
  token: string,
): Promise<Draft> {
  const { run } = ownedOperation();
  if (report.home) {
    if (!report.home.audioId) throw new Error("Keine Originalaufnahme in OneDrive vorhanden.");
    const audio = await run(() => downloadOneDrive(report.home!,report.home!.audioId!));
    return {report,audio};
  }
  if (!report.rawAudioUrl)
    throw new Error(
      report.audioDeletedAt
        ? "Die Originalaufnahme wurde nach der zugesagten Aufbewahrungsfrist gelöscht. Transkript und Zusammenfassung bleiben erhalten."
        : "Keine Audioaufnahme in Drive vorhanden. Bitte den lokalen Entwurf öffnen.",
    );
  const audio = await run(() => downloadDriveFile(report.rawAudioUrl!, token));
  return { report, audio };
}
