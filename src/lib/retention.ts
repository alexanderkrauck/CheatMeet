import type { RetentionPolicy } from "../../shared/consent";
import type { ReportData } from "../types";

/** After this many failed attempts a file is left alone rather than retried forever. */
export const MAX_ATTEMPTS = 3;
const DAY_MS = 86_400_000;

/**
 * When this meeting's audio may be deleted, or null for never.
 *
 * The deadline is read out of the consent record, not out of a setting: the
 * number of days the participants were told is the number of days enforced, so
 * the promise and the deletion cannot drift apart. A meeting recorded before
 * consent existed has no record and is therefore never swept — no migration,
 * and no deletion nobody agreed to.
 */
export function audioExpiresAt(report: ReportData): number | null {
  const days = report.consent?.facts?.retention?.audioDays;
  if (typeof days !== "number") return null;
  const start = Date.parse(report.date);
  return Number.isFinite(start) ? start + days * DAY_MS : null;
}

/**
 * Whether deleting this report's audio is safe at all, regardless of the date.
 *
 * The transcript clause does double duty: a meeting still awaiting its batch
 * transcription submits the Drive audio id, and a device holding only a
 * projected report has no transcript to protect the recording with — neither
 * may destroy the audio.
 */
export function sweepable(report: ReportData): boolean {
  return (
    audioExpiresAt(report) !== null &&
    !!report.rawAudioUrl &&
    !!report.driveSyncedAt &&
    !report.audioDeletedAt &&
    (report.audioDeleteAttempts ?? 0) < MAX_ATTEMPTS &&
    (!!report.speech || !!report.transcription?.trim())
  );
}

export function dueAudio(
  reports: ReportData[],
  now: number,
  busy: ReadonlySet<string>,
): ReportData[] {
  return reports.filter(
    (report) =>
      sweepable(report) &&
      !busy.has(report.id) &&
      (audioExpiresAt(report) as number) <= now,
  );
}

const days = (value: number | null) =>
  value === null ? "unbegrenzt" : `${value} ${value === 1 ? "Tag" : "Tage"}`;

export function retentionLabel(policy: RetentionPolicy): {
  audio: string;
  text: string;
} {
  return { audio: days(policy.audioDays), text: days(policy.textDays) };
}
