import type { ReportData } from "../types";
import { microsoftHome, reportIndexCollection } from "../../shared/storage";
import { auth } from "./firebase";
import { fromArchive } from "./archive";
import { getLocal, putLocal, ReportConflictError } from "./local";
import { downloadDriveFile, findFileInFolder } from "./drive";
import { downloadOneDrive, listOneDriveItems } from "./onedrive";
import { ensureDriveToken } from "./session";
import {
  mergeRestoredReport,
  sameReportHome,
  transcriptIsElsewhere,
} from "./reportProjection";

/** Read existing archive content into this device, never analyze or publish it.
 * Metadata is re-read after download: a saved task/calendar/title/retention edit
 * is not less authoritative just because the archive was written earlier. */
export async function restoreReportTranscript(
  owner: string,
  report: ReportData,
): Promise<ReportData> {
  const check = () => {
    if (!owner || auth.currentUser?.uid !== owner)
      throw new Error(
        "Das angemeldete Konto hat sich geändert. Bitte im ursprünglichen Konto erneut versuchen.",
      );
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    check();
    try {
      const value = await fn();
      check();
      return value;
    } catch (error) {
      check();
      throw error;
    }
  };
  const index = { index: reportIndexCollection(report) } as const;
  const initial = await run(() => getLocal(owner, report.id, index));
  if (initial && !sameReportHome(initial.report, report))
    throw new ReportConflictError();
  if (initial?.dirty)
    throw new Error(
      "Nicht synchronisierte Änderungen bleiben erhalten. Bitte zuerst speichern und dann das Transkript laden.",
    );
  const base = initial?.report ?? report;
  let restored: ReportData;
  if (base.home) {
    const home = microsoftHome(base.home);
    if (!home.folderId)
      throw new Error("Der angeheftete OneDrive-Meetingordner fehlt.");
    const reportId =
      home.reportId ||
      (await run(() => listOneDriveItems(home, home.folderId!))).find(
        (item) => item.name === "bericht_daten.json",
      )?.id;
    if (!reportId)
      throw new Error(
        "Keine Berichtsdaten im angehefteten OneDrive-Archiv gefunden.",
      );
    const blob = await run(() => downloadOneDrive(home, reportId));
    const raw = JSON.parse(await run(() => blob.text()));
    if (raw?.id !== report.id)
      throw new Error("Die Archivdatei gehört zu einem anderen Meeting.");
    restored = fromArchive(raw, { home: { ...home, reportId } });
  } else {
    if (!base.driveFolderId)
      throw new Error("Der angeheftete Google-Drive-Meetingordner fehlt.");
    const token = await run(() => ensureDriveToken());
    if (!token)
      throw new Error(
        "Bitte Google Drive erneut verbinden. Der Speicherort dieses Meetings bleibt unverändert.",
      );
    const reportId =
      base.driveReportId ||
      (await run(() =>
        findFileInFolder("bericht_daten.json", base.driveFolderId!, token),
      ));
    if (!reportId)
      throw new Error(
        "Keine Berichtsdaten im angehefteten Google-Drive-Archiv gefunden.",
      );
    const blob = await run(() => downloadDriveFile(reportId, token));
    const raw = JSON.parse(await run(() => blob.text()));
    if (
      raw?.id !== report.id ||
      (raw.driveFolderId && raw.driveFolderId !== base.driveFolderId) ||
      (raw.driveReportId && raw.driveReportId !== reportId)
    )
      throw new Error(
        "Die Archivdatei gehört zu einem anderen Meeting oder Speicherort.",
      );
    restored = fromArchive(raw, {
      driveFolderId: base.driveFolderId,
      driveReportId: reportId,
    });
  }
  if (!sameReportHome(base, restored)) throw new ReportConflictError();
  const latest = await run(() => getLocal(owner, report.id, index));
  if ((initial && !latest) || (latest && !sameReportHome(base, latest.report)))
    throw new ReportConflictError();
  if (latest?.dirty) throw new ReportConflictError();
  const current = latest ?? { report: base, dirty: false };
  // Reading a full report is still useful on OneDrive: downloadOneDrive learns
  // its actual ETag. Never replace newer, already-saved local transcript edits.
  if (
    !transcriptIsElsewhere(current.report) &&
    (current.report.speech || current.report.transcription?.trim())
  )
    return current.report;
  const hydrated = mergeRestoredReport(current, restored);
  if (!hydrated)
    throw new Error(
      "Das Archiv enthält nicht die erwartete Transkriptversion oder lokale Änderungen müssen zuerst gesichert werden. Es wurde nichts überschrieben.",
    );
  if (hydrated.home && restored.home)
    hydrated.home = {
      ...hydrated.home,
      folderId: restored.home.folderId,
      reportId: restored.home.reportId,
    };
  else {
    hydrated.driveFolderId = restored.driveFolderId;
    hydrated.driveReportId = restored.driveReportId;
  }
  hydrated.updatedAt = new Date(
    Math.max(Date.now(), (Date.parse(current.report.updatedAt || "") || 0) + 1),
  ).toISOString();
  await run(() =>
    putLocal(owner, hydrated, false, latest?.report.updatedAt ?? null),
  );
  return hydrated;
}
