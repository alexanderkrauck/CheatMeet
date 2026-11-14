import { auth } from "./firebase";
import { putDraft, putLocal, listLocal, getLocal, ReportConflictError } from "./local";
import { saveReport } from "./reports";
import {
  createOneDriveFolder,
  uploadOneDrive,
  writeOneDriveText,
  listOneDriveItems,
  downloadOneDrive,
  readOneDriveArchiveRevision,
} from "./onedrive";
import { reportFolderName, toArchive, fromArchive } from "./archive";
import { ARCHIVE_SCHEMA_DOC, buildArchiveIndex } from "./archiveIndex";
import {
  consentToMarkdown,
  reportToMarkdown,
  transcriptToMarkdown,
} from "./markdown";
import { withWebmDuration } from "./webmDuration";
import { audioExtension } from "../../shared/analysis";
import { safeMicrosoftLink, type MicrosoftHome } from "../../shared/storage";
import { transcriptIsElsewhere, mergeRestoredReport } from "./reportProjection";
import type { Draft, ReportData } from "../types";
function operation() {
  const owner = auth.currentUser?.uid;
  if (!owner) throw Error("Bitte zuerst anmelden.");
  const check = () => {
    if (auth.currentUser?.uid !== owner)
      throw Error("Das angemeldete Konto hat sich geändert.");
  };
  const run = async <T>(fn: () => Promise<T>) => {
    check();
    const value = await fn();
    check();
    return value;
  };
  return { owner, check, run };
}
export async function backupMicrosoftDraft(
  draft: Draft,
  progress: (s: string) => void,
  expectedUpdatedAt?: string | null,
) {
  const { owner, run } = operation();
  const report = draft.report;
  if (!report.home) throw Error("OneDrive-Speicherort fehlt.");
  const stored = await run(() => getLocal(owner, report.id, { index: "meetings" }));
  let expected = expectedUpdatedAt === undefined ? stored?.report.updatedAt ?? null : expectedUpdatedAt;
  if ((stored?.report.updatedAt ?? null) !== expected ||
      (stored && (report.updatedAt ?? null) !== expected))
    throw new ReportConflictError();
  // A late provider result cannot advance the caller or replace its recovery draft.
  const checkpoint = async (upload: Pick<Draft, "microsoftUploadHandle"> = {}) => {
    const next = { ...report, updatedAt: new Date(Math.max(Date.now(), (Date.parse(report.updatedAt || "") || 0) + 1)).toISOString() };
    await run(() => putLocal(owner, next, true, expected));
    expected = next.updatedAt;
    Object.assign(report, next);
    if ("microsoftUploadHandle" in upload) {
      if (upload.microsoftUploadHandle) draft.microsoftUploadHandle = upload.microsoftUploadHandle;
      else delete draft.microsoftUploadHandle;
    }
    await run(() => putDraft(owner, draft));
  };
  if (!report.home.folderId) {
    const folder = await run(() =>
      createOneDriveFolder(report.home!, reportFolderName(report)),
    );
    report.home = {
      ...report.home,
      folderId: folder.id,
      ...(folder.webUrl && safeMicrosoftLink(folder.webUrl)
        ? { webUrl: folder.webUrl }
        : {}),
    };
    await checkpoint();
  }
  if (report.consent && !report.home.consentId) {
    const item = await run(() =>
      writeOneDriveText(
        report.home!,
        "einwilligung.md",
        consentToMarkdown(report.consent!),
      ),
    );
    report.home.consentId = item.id;
    await checkpoint();
  }
  if (!report.home.audioId && draft.audio) {
    progress("Audio in OneDrive sichern …");
    const audio = await run(() =>
      withWebmDuration(draft.audio!, report.durationMs || 0),
    );
    const item = await run(() =>
      uploadOneDrive(
        report.home!,
        audio,
        `aufnahme.${audioExtension(draft.audio!.type)}`,
        {
          reportId: report.id,
          handle: draft.microsoftUploadHandle,
          checkpoint: async (handle) => {
            await checkpoint({ microsoftUploadHandle: handle });
          },
        },
      ),
    ).catch(async (error) => {
      if ((error as { status?: number }).status === 410) {
        await checkpoint({ microsoftUploadHandle: undefined });
      }
      throw error;
    });
    report.home.audioId = item.id;
    await checkpoint({ microsoftUploadHandle: undefined });
  }
  return report;
}
export async function syncMicrosoftReport(report: ReportData) {
  const { owner, run } = operation();
  if (!report.home) throw Error("OneDrive-Speicherort fehlt.");
  const stored = await run(() => getLocal(owner, report.id, { index: "meetings" }));
  if (transcriptIsElsewhere(report) || stored?.report.transcriptStale)
    throw Error(
      "Bitte das vollständige Meeting zuerst aus OneDrive wiederherstellen.",
    );
  if (stored && (stored.report.updatedAt ?? null) !== (report.updatedAt ?? null))
    throw new ReportConflictError();
  const next: ReportData & { home: MicrosoftHome; archiveBaseSyncedAt?: string } = { ...report, home: { ...report.home } };
  let expectedUpdatedAt = stored?.report.updatedAt ?? null;
  const archiveEtag = next.home.reportId
    ? await run(() => readOneDriveArchiveRevision(next))
    : undefined;
  const checkpoint = async () => {
    next.updatedAt = new Date(Math.max(Date.now(), (Date.parse(next.updatedAt || "") || 0) + 1)).toISOString();
    await run(() => putLocal(owner, next, true, expectedUpdatedAt));
    expectedUpdatedAt = next.updatedAt;
    Object.assign(report, next);
  };
  if (!next.home.folderId) {
    const folder = await run(() =>
      createOneDriveFolder(next.home, reportFolderName(next)),
    );
    next.home.folderId = folder.id;
    if (folder.webUrl && safeMicrosoftLink(folder.webUrl))
      next.home.webUrl = folder.webUrl;
    await checkpoint();
  }
  if (next.consent && !next.home.consentId) {
    next.home.consentId = (
      await run(() =>
        writeOneDriveText(
          next.home,
          "einwilligung.md",
          consentToMarkdown(next.consent!),
        ),
      )
    ).id;
    await checkpoint();
  }
  next.home.markdownId = (
    await run(() =>
      writeOneDriveText(
        next.home,
        "zusammenfassung.md",
        reportToMarkdown(next),
        next.home.markdownId,
      ),
    )
  ).id;
  await checkpoint();
  if (next.transcription) {
    next.home.transcriptId = (
      await run(() =>
        writeOneDriveText(
          next.home,
          "transkript.md",
          transcriptToMarkdown(next),
          next.home.transcriptId,
        ),
      )
    ).id;
    await checkpoint();
  }
  const latest = await run(() => getLocal(owner, next.id, { index: "meetings" }));
  if ((latest?.report.updatedAt ?? null) !== expectedUpdatedAt)
    throw new ReportConflictError();
  const syncedAt = new Date().toISOString();
  next.archiveBaseSyncedAt = undefined;
  next.home.reportId = (
    await run(() =>
      writeOneDriveText(
        next.home,
        "bericht_daten.json",
        JSON.stringify(
          toArchive({ ...next, home: { ...next.home, syncedAt } }, syncedAt),
          null,
          2,
        ),
        next.home.reportId,
        archiveEtag,
      ),
    )
  ).id;
  next.home.syncedAt = syncedAt;
  await checkpoint();
  const warning = await run(() => saveReport(next, { expectedUpdatedAt }));
  try {
    await run(() => refreshMicrosoftArchiveIndex(next.home, syncedAt));
  } catch {
    /* derived overview is best effort */
  }
  return { report: next, warning };
}
export async function refreshMicrosoftArchiveIndex(
  home: MicrosoftHome,
  generatedAt = new Date().toISOString(),
) {
  const { owner, run } = operation();
  const reports = (await run(() => listLocal(owner)))
    .map((v) => v.report)
    .filter(
      (r) =>
        r.home?.connectionId === home.connectionId &&
        r.home.driveId === home.driveId &&
        r.home.rootId === home.rootId,
    );
  const root = { ...home, folderId: home.rootId };
  const items = await run(() => listOneDriveItems(home, home.rootId));
  await run(() =>
    writeOneDriveText(
      root,
      "index.json",
      JSON.stringify(buildArchiveIndex(reports, generatedAt), null, 2),
      items.find((i) => i.name === "index.json")?.id,
    ),
  );
  if (!items.some((i) => i.name === "SCHEMA.md"))
    await run(() =>
      writeOneDriveText(
        root,
        "SCHEMA.md",
        ARCHIVE_SCHEMA_DOC +
          "\nMicrosoft-Archive verwenden Version 2 und explizite drive/item-Referenzen. Verbindungen werden beim Wiederherstellen vom angemeldeten Benutzer gewählt.\n",
      ),
    );
}
export async function restoreMicrosoftReport(
  home: MicrosoftHome,
  reportId: string,
  folderId: string,
) {
  const { run } = operation();
  const blob = await run(() => downloadOneDrive(home, reportId));
  const raw = JSON.parse(await run(() => blob.text()));
  return fromArchive(raw, { home: { ...home, folderId, reportId } });
}
export async function restoreMicrosoftArchive(
  home: MicrosoftHome,
  progress: (message: string) => void = () => {},
) {
  const { owner, run } = operation();
  const folders = (
    await run(() => listOneDriveItems(home, home.rootId))
  ).filter((f) => f.folder);
  let count = 0;
  const errors: string[] = [];
  for (const folder of folders) {
    try {
      progress(folder.name || "Meeting wiederherstellen …");
      const items = await run(() => listOneDriveItems(home, folder.id));
      const file = items.find((i) => i.name === "bericht_daten.json");
      if (!file) continue;
      const report = await run(() =>
        restoreMicrosoftReport(
          {
            ...home,
            ...(folder.webUrl && safeMicrosoftLink(folder.webUrl)
              ? { webUrl: folder.webUrl }
              : {}),
          },
          file.id,
          folder.id,
        ),
      );
      const local = await run(() => getLocal(owner, report.id, { index: "meetings" }));
      const merged = mergeRestoredReport(local, report);
      if (merged) {
        // Archive recovery is not an acknowledgement from the independent index.
        await run(() => putLocal(owner, merged, local?.dirty ?? true, local?.report.updatedAt ?? null));
        count++;
      }
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : "Meeting konnte nicht gelesen werden.",
      );
    }
  }
  return { count, errors };
}
