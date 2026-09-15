import { asTodos } from "../../shared/analysis";
import { validateConsentRecord } from "../../shared/consent";
import type { ReportData } from "../types";

export const ARCHIVE_VERSION = 1;

/**
 * The contract for `bericht_daten.json` — the boundary between the app's own
 * report shape and the files a person, another device or an AI agent reads out
 * of Drive.
 *
 * The envelope is flat and additive: today's top-level key names are kept, so a
 * client older than this change reads a v1 file exactly as it read a v0 one.
 * Nesting the identity fields would be worse than useless — an old client would
 * "successfully" restore a report with an empty summary and transcript and then
 * overwrite a newer local copy.
 */

/** App internals that mean nothing outside this device's session. */
const INTERNAL = [
  "status",
  "error",
  "captureState",
  "calendarError",
  "transcriptChars",
  "participants",
  "speakerReviewPending",
  // Self-referential: both are re-derived from where the file was found.
  "driveFolderId",
  "driveReportId",
] as const;

export function toArchive(
  report: ReportData,
  generatedAt: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...report };
  for (const key of INTERNAL) delete out[key];
  out.archive = {
    version: ARCHIVE_VERSION,
    generator: "cheatmeet",
    generatedAt,
  };
  return out;
}

const CALENDAR_FIELDS = [
  "calendarEventId",
  "calendarId",
  "calendarLink",
  "calendarSyncedAt",
] as const;

const STATUSES = ["pending", "analyzing", "completed", "error"] as const;

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;

/**
 * Reads one archived meeting back.
 *
 * Only the fields a report view actually renders throw; everything else is
 * dropped, so one corrupt field never makes a meeting unrestorable. Unknown
 * keys are discarded by constructing the result explicitly rather than
 * spreading — an externally editable file must not be able to inject fields
 * into the local store and from there into the cloud.
 */
export function fromArchive(
  value: unknown,
  ids: { driveFolderId: string; driveReportId: string },
): ReportData {
  const raw = value as Record<string, unknown> & { archive?: unknown };
  if (!raw || typeof raw !== "object") throw new Error("Ungültige Berichtsdaten");
  const envelope = raw.archive as { version?: unknown } | undefined;
  if (
    envelope &&
    typeof envelope === "object" &&
    typeof envelope.version === "number" &&
    envelope.version > ARCHIVE_VERSION
  )
    // Must not say "abgelaufen": the restore treats that word as a dead Drive
    // connection and would abort the whole scan instead of skipping one file.
    throw new Error(
      "Dieser Bericht stammt aus einer neueren Version von CheatMeet. Bitte die App aktualisieren.",
    );

  if (
    typeof raw.id !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.date !== "string" ||
    !Number.isFinite(Date.parse(raw.date))
  )
    throw new Error("Ungültige Berichtsdaten");
  // Validate what report views render before admitting external JSON.
  if (
    raw.takeaways !== undefined &&
    (!Array.isArray(raw.takeaways) ||
      !raw.takeaways.every((item: unknown) => typeof item === "string"))
  )
    throw new Error("Ungültige Berichtsinhalte");
  if (raw.todos !== undefined && !Array.isArray(raw.todos))
    throw new Error("Ungültige Berichtsinhalte");
  if (raw.rawAudioUrl !== undefined && typeof raw.rawAudioUrl !== "string")
    throw new Error("Ungültige Audioreferenz");

  const summary = typeof raw.summary === "string" ? raw.summary : "";
  const updatedAt =
    typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : undefined;
  // A v1 file carries no status — it is an app internal. Derive it from what
  // the meeting actually produced rather than marking every restore pending.
  const status = STATUSES.includes(raw.status as (typeof STATUSES)[number])
    ? (raw.status as ReportData["status"])
    : summary.trim()
      ? "completed"
      : "pending";

  let consent: ReportData["consent"];
  try {
    if (raw.consent !== undefined)
      consent = validateConsentRecord(raw.consent);
  } catch {
    // An unreadable consent record is not evidence, so it is not kept — but it
    // must not cost the user the meeting.
    consent = undefined;
  }

  const speech = raw.speech as ReportData["speech"];
  const calendar: Record<string, string> = {};
  for (const field of CALENDAR_FIELDS) {
    const value = text(raw[field]);
    if (value !== undefined) calendar[field] = value;
  }

  return {
    id: raw.id,
    date: raw.date,
    title: raw.title,
    summary,
    transcription:
      typeof raw.transcription === "string" ? raw.transcription : "",
    todos: asTodos(raw.todos),
    takeaways: (raw.takeaways as string[]) || [],
    status,
    driveFolderId: ids.driveFolderId,
    driveReportId: ids.driveReportId,
    ...(updatedAt ? { updatedAt } : {}),
    ...(text(raw.projectName) ? { projectName: text(raw.projectName) } : {}),
    ...(text(raw.suggestedTitle)
      ? { suggestedTitle: text(raw.suggestedTitle) }
      : {}),
    ...(speech && typeof speech === "object" && Array.isArray(speech.turns)
      ? { speech }
      : {}),
    ...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)
      ? { durationMs: raw.durationMs }
      : {}),
    ...(raw.transcriptionOrigin === "live" || raw.transcriptionOrigin === "import"
      ? { transcriptionOrigin: raw.transcriptionOrigin }
      : {}),
    ...(Array.isArray(raw.captureSources)
      ? {
          captureSources: raw.captureSources.filter(
            (s: unknown) => s === "mic" || s === "system",
          ) as ("mic" | "system")[],
        }
      : {}),
    ...(raw.singleSpeakerSources && typeof raw.singleSpeakerSources === "object"
      ? {
          singleSpeakerSources: raw.singleSpeakerSources as ReportData["singleSpeakerSources"],
        }
      : {}),
    ...(text(raw.rawAudioUrl) ? { rawAudioUrl: text(raw.rawAudioUrl) } : {}),
    ...(text(raw.driveMarkdownId)
      ? { driveMarkdownId: text(raw.driveMarkdownId) }
      : {}),
    ...(text(raw.driveTranscriptId)
      ? { driveTranscriptId: text(raw.driveTranscriptId) }
      : {}),
    ...(text(raw.driveConsentId)
      ? { driveConsentId: text(raw.driveConsentId) }
      : {}),
    ...(text(raw.driveSyncedAt) ? { driveSyncedAt: text(raw.driveSyncedAt) } : {}),
    ...(consent ? { consent } : {}),
    ...(text(raw.audioDeletedAt)
      ? { audioDeletedAt: text(raw.audioDeletedAt) }
      : {}),
    ...(typeof raw.audioDeleteAttempts === "number" &&
    Number.isFinite(raw.audioDeleteAttempts)
      ? { audioDeleteAttempts: raw.audioDeleteAttempts }
      : {}),
    ...(text(raw.audioDeleteError)
      ? { audioDeleteError: text(raw.audioDeleteError) }
      : {}),
    ...calendar,
  };
}
