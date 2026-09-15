import { doc, getDoc } from "firebase/firestore";
import { getRootFolder } from "./driveSettings";
import { auth, db } from "./firebase";
import { saveReport, uid } from "./reports";
import { putDraft, putLocal } from "./local";
import {
  createSubFolder,
  uploadFileToFolder,
  downloadDriveFile,
} from "./drive";
import { audioExtension, validateAnalysis } from "../../shared/analysis";
import { toArchive } from "./archive";
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

export async function analyzeDraft(draft: Draft): Promise<ReportData> {
  const { owner, run } = ownedOperation();
  await run(() => prepareTranscript(draft));
  if (needsSpeakerReview(draft.report.speech))
    throw new Error("Bitte zuerst die Sprecher prüfen oder die Prüfung überspringen.");
  const transcription = draft.report.transcription?.trim() || "";
  // Empty/failed live capture must never fall back to sending audio for ASR.
  if (draft.report.speech?.phase === "final" && !transcription) {
    if (draft.report.transcriptionOrigin === "live")
      throw new Error("Kein Live-Transkript vorhanden. Die Aufnahme bleibt gesichert; es wird keine erneute Transkription gestartet.");
    return { ...draft.report, summary: "Keine Sprache erkannt.", todos: [], takeaways: [], status: "completed", error: "" };
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
  return {
    ...draft.report,
    ...analysed,
    ...(transcription ? { transcription } : {}),
    ...(chosen ? { title: chosen } : {}),
    ...(chosen && analysed.title && analysed.title !== chosen
      ? { suggestedTitle: analysed.title }
      : {}),
    status: "completed",
    error: "",
  };
}
export async function backupDraft(
  draft: Draft,
  token: string,
  progress: (s: string) => void,
) {
  const { owner, run, assertOwner } = ownedOperation();
  const report = draft.report;
  // Upload checkpoints are local and immediate. syncReport writes the final cloud index once.
  const checkpoint = async () => {
    assertOwner();
    localRevision(report);
    await run(() => putDraft(owner, draft));
    await run(() => putLocal(owner, report));
  };
  if (!report.driveFolderId) {
    const parent = await run(() => getRootFolder(token));
    report.driveFolderId = await run(() =>
      createSubFolder(
        `Meeting ${report.date.slice(0, 10)} – ${report.id}`,
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
  const next = { ...report };
  // Keep completed upload IDs locally and on the caller's report if a later step fails.
  const checkpoint = async () => {
    assertOwner();
    localRevision(next);
    Object.assign(report, next);
    await run(() => putLocal(owner, next));
  };
  if (!next.driveFolderId) {
    const parent = await run(() => getRootFolder(token));
    next.driveFolderId = await run(() =>
      createSubFolder(
        `Meeting ${report.date.slice(0, 10)} – ${report.id}`,
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
  const syncedAt = new Date().toISOString();
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
    ),
  );
  next.driveSyncedAt = syncedAt;
  await checkpoint();
  const warning = await run(() => saveReport(next));
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
  if (!report.rawAudioUrl)
    throw new Error(
      report.audioDeletedAt
        ? "Die Originalaufnahme wurde nach der zugesagten Aufbewahrungsfrist gelöscht. Transkript und Zusammenfassung bleiben erhalten."
        : "Keine Audioaufnahme in Drive vorhanden. Bitte den lokalen Entwurf öffnen.",
    );
  const audio = await run(() => downloadDriveFile(report.rawAudioUrl!, token));
  return { report, audio };
}
