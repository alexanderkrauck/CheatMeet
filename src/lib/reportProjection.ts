import { needsSpeakerReview } from "../../shared/transcription";
import { meetingDurationMs, speakerNamesOf } from "./meetingMeta";
import type { ReportData } from "../types";

/**
 * What goes to Firestore: everything except the two unbounded fields.
 *
 * A deny-list rather than an allow-list on purpose — an allow-list silently
 * drops every field added later, which is how a Drive file id or a consent
 * record would quietly stop syncing. The two fields removed here are the only
 * ones that grow with meeting length, and they are the reason a long meeting
 * would otherwise hit Firestore's document limit and stop syncing for good.
 */
export function projectReport(report: ReportData): ReportData {
  const { transcription, speech, ...rest } = report;
  return {
    ...rest,
    transcription: "",
    transcriptChars: (transcription || "").length,
    // Resolved here because the projection is the only copy another device
    // sees, and these cannot be recomputed without the turns.
    participants: speakerNamesOf(speech),
    speakerReviewPending: needsSpeakerReview(speech),
    durationMs: meetingDurationMs(report),
  };
}

/**
 * The guard that makes the projection safe.
 *
 * The local store replaces a whole document when it accepts a remote one, and
 * a report is written locally and remotely under the SAME revision — so the
 * cloud echo of a report this device just recorded comes back without the
 * transcript, at an identical timestamp, and both staleness guards let it
 * through. Carrying the local content forward is what stops that echo from
 * erasing the transcript on the device that produced it.
 */
export function mergeRemoteReport(
  existing: ReportData | undefined,
  remote: ReportData,
): ReportData {
  const remoteHasContent = !!remote.speech || !!remote.transcription?.trim();
  const localContent = existing?.speech || existing?.transcription?.trim();
  if (remoteHasContent || !localContent) return remote;
  return {
    ...remote,
    transcription: existing!.transcription,
    speech: existing!.speech,
  };
}

/**
 * True when a transcript exists but lives on another device — as opposed to a
 * meeting that genuinely contained no speech, which also has an empty
 * transcript and must not be described as missing.
 */
export function transcriptIsElsewhere(report: ReportData): boolean {
  return (
    !report.speech &&
    !report.transcription?.trim() &&
    (report.transcriptChars ?? 0) > 0
  );
}
