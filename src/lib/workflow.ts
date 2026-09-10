import { prepareAnalysisPhotos } from "./analysisMedia";
import { getRootFolder } from "./driveSettings";
import { auth } from "./firebase";
import { saveReport, uid } from "./reports";
import { putDraft, putLocal } from "./local";
import {
  createSubFolder,
  uploadFileToFolder,
  downloadDriveFile,
} from "./drive";
import { audioExtension, validateAnalysis } from "../../shared/analysis";
import { reportToMarkdown } from "./markdown";
import type { Draft, ReportData } from "../types";

// An operation belongs to the account that started it, including across tab sign-outs.
function ownedOperation() {
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

export async function analyzeDraft(draft: Draft): Promise<ReportData> {
  const { run } = ownedOperation();
  if (!draft.report.transcription && !draft.audio) throw new Error("Weder Transkript noch Audio vorhanden.");
  
  const token = await run(() => auth.currentUser!.getIdToken());
  const uid = auth.currentUser!.uid;
  
  // Try to get preferences from Firestore, or use default empty string
  let preferences = "";
  try {
    const db = await import("firebase/firestore").then(m => m.getFirestore());
    const docRef = await import("firebase/firestore").then(m => m.doc(db, "users", uid, "settings", "preferences"));
    const docSnap = await import("firebase/firestore").then(m => m.getDoc(docRef));
    if (docSnap.exists()) {
      preferences = docSnap.data().summaryPrompt || "";
    }
  } catch (e) {
    console.warn("Could not load preferences", e);
  }

  const formData = new FormData();
  if (draft.report.transcription) {
    formData.append("transcription", draft.report.transcription);
  }
  if (draft.audio && !draft.report.transcription) {
    formData.append("audio", draft.audio, "recording" + audioExtension(draft.audio.type));
  }
  if (preferences) {
    formData.append("preferences", preferences);
  }

  const response = await run(() =>
    fetch("/api/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData,
      signal: AbortSignal.timeout(300000), // 5 minutes since audio transcription can take time
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
    
  return {
    ...draft.report,
    ...validateAnalysis(data),
    ...(draft.report.projectName?.trim()
      ? { title: draft.report.projectName.trim() }
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
  if (!report.rawAudioUrl && draft.audio) {
    progress("Audio in Google Drive sichern …");
    report.rawAudioUrl = await run(() =>
      uploadFileToFolder(
        draft.audio!,
        `aufnahme.${audioExtension(draft.audio!.type)}`,
        draft.audio!.type,
        report.driveFolderId!,
        token,
      ),
    );
    await checkpoint();
  }
  report.photos ||= draft.photos.map((p) => ({
    id: p.id,
    relativeTimeMs: p.relativeTimeMs,
  }));
  for (let i = 0; i < draft.photos.length; i++) {
    const photo = draft.photos[i];
    let meta = report.photos.find((p) => p.id === photo.id);
    if (!meta) {
      meta = { id: photo.id, relativeTimeMs: photo.relativeTimeMs };
      report.photos.push(meta);
    }
    if (!meta.driveId) {
      progress(`Foto ${i + 1} von ${draft.photos.length} sichern …`);
      meta.driveId = await run(() =>
        uploadFileToFolder(
          photo.blob,
          `${photo.id}.${photo.blob.type.includes("png") ? "png" : photo.blob.type.includes("webp") ? "webp" : "jpg"}`,
          photo.blob.type,
          report.driveFolderId!,
          token,
        ),
      );
      await checkpoint();
    }
  }
  assertOwner();
  report.rawPhotoUrls = report.photos.map((p) => p.driveId || "");
  await checkpoint();
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
        new Blob([next.transcription], {
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
        [JSON.stringify({ ...next, driveSyncedAt: syncedAt }, null, 2)],
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
  return { report: next, warning: await run(() => saveReport(next)) };
}
export async function restoreDraft(
  report: ReportData,
  token: string,
): Promise<Draft> {
  const { run } = ownedOperation();
  if (!report.rawAudioUrl)
    throw new Error(
      "Keine Audioaufnahme in Drive vorhanden. Bitte den lokalen Entwurf öffnen.",
    );
  const photos =
    report.photos ||
    (report.rawPhotoUrls || []).map((driveId, i) => ({
      id: `photo_${i}`,
      relativeTimeMs: null,
      driveId,
    }));
  const audio = await run(() => downloadDriveFile(report.rawAudioUrl!, token));
  const restoredPhotos = await run(() =>
    Promise.all(
      photos.map(async (p) => {
        if (!p.driveId)
          throw new Error(
            "Ein Foto ist noch nicht in Drive gesichert. Bitte den lokalen Entwurf öffnen.",
          );
        return {
          id: p.id,
          relativeTimeMs: p.relativeTimeMs,
          blob: await run(() => downloadDriveFile(p.driveId!, token)),
        };
      }),
    ),
  );
  return { report, audio, photos: restoredPhotos };
}
