import { needsSpeakerReview } from "../../shared/transcription";
import { meetingDurationMs, speakerNamesOf } from "./meetingMeta";
import type { ReportData } from "../types";
import { archiveReportId, archiveSyncedAt } from "../../shared/storage";

// Synchronous SHA-256 keeps projectReport usable in render/index paths. This is
// a bounded cache identity, not an authorization token. Canonicalize object keys
// so JSON property ordering (including an external archive edit) is irrelevant.
function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => canonical(v ?? null)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(data.length - 4, bytes.length * 8);
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  const rotate = (v: number, n: number) => (v >>> n) | (v << (32 - n));
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15],
        y = w[i - 2];
      w[i] =
        w[i - 16] +
        (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
        w[i - 7] +
        (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          SHA256_K[i] +
          w[i]) |
        0;
      const t2 =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => {
      hash[i] = (hash[i] + v) >>> 0;
    });
  }
  return hash.map((v) => v.toString(16).padStart(8, "0")).join("");
}
export function transcriptRevisionOf(report: ReportData): string | undefined {
  if (
    report.transcriptStale ||
    (!report.speech && !report.transcription?.trim())
  )
    return report.transcriptRevision;
  const speech = report.speech ? { ...report.speech } : null;
  if (speech) {
    delete speech.liveConnection;
    delete speech.liveWarning;
    delete speech.liveStartDelayed;
  }
  return `sha256:${sha256(canonical({ transcription: report.transcription || "", speech }))}`;
}

/** Compare provider-pinned archive identity, never the current storage default. */
export function sameReportHome(a: ReportData, b: ReportData): boolean {
  if (!!a.home !== !!b.home || a.id !== b.id) return false;
  if (a.home && b.home)
    return (
      ["connectionId", "driveId", "rootId", "folderId", "reportId"] as const
    ).every((k) => !a.home![k] || !b.home![k] || a.home![k] === b.home![k]);
  return (["driveFolderId", "driveReportId"] as const).every(
    (k) => !a[k] || !b[k] || a[k] === b[k],
  );
}

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
  const { transcription, speech, transcriptStale, ...rest } = report;
  const revision = transcriptRevisionOf(report);
  return {
    ...rest,
    ...(revision ? { transcriptRevision: revision } : {}),
    transcription: "",
    // Re-projecting an already-projected report must not zero the marker: a
    // second device would then look like a meeting that never had a
    // transcript, and every guard keyed on it would fall open.
    transcriptChars:
      (!transcriptStale && (transcription || "").length) ||
      (report.transcriptChars ?? 0),
    // Resolved here because the projection is the only copy another device
    // sees, and these cannot be recomputed without the turns.
    participants:
      speech && !transcriptStale
        ? speakerNamesOf(speech)
        : (report.participants ?? []),
    speakerReviewPending:
      speech && !transcriptStale
        ? needsSpeakerReview(speech)
        : (report.speakerReviewPending ?? false),
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
  if (remoteHasContent || !localContent || !sameReportHome(existing!, remote))
    return remote;
  const localRevision = transcriptRevisionOf(existing!);
  const matchingContent = remote.transcriptRevision
    ? !existing!.transcriptStale && remote.transcriptRevision === localRevision
    : !existing!.transcriptStale &&
      (remote.updatedAt || remote.date) ===
        (existing!.updatedAt || existing!.date);
  return {
    ...remote,
    transcription: existing!.transcription,
    speech: existing!.speech,
    ...(!matchingContent ? { transcriptStale: true } : {}),
  };
}

/** A failed machine-generated stub is not an unsaved human edit. Completion
 * may supersede it only when retained user fields and transcript evidence agree. */
export function isRecoveredProcessingStub(
  local: ReportData,
  remote: ReportData,
): boolean {
  if (
    !["error", "analyzing"].includes(local.status || "") ||
    remote.status !== "completed" ||
    !remote.summary?.trim()
  )
    return false;
  if (local.summary?.trim() || local.todos?.length || local.takeaways?.length)
    return false;
  if (local.transcription?.trim()) {
    if (
      !remote.transcription?.trim() ||
      local.transcription !== remote.transcription
    )
      return false;
  }
  const same = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object")
      return false;
    const keys = Object.keys(a).sort();
    return (
      keys.join("\0") === Object.keys(b).sort().join("\0") &&
      keys.every((k) =>
        same(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    );
  };
  for (const field of [
    "title",
    "projectName",
    "date",
    "consent",
    "calendarEventId",
    "calendarId",
    "calendarLink",
    "singleSpeakerSources",
    "captureSources",
  ] as const) {
    const value = local[field];
    if (value !== undefined && value !== "" && !same(value, remote[field]))
      return false;
  }
  if (
    local.speech &&
    remote.speech &&
    !same(local.speech.speakerAliases || {}, remote.speech.speakerAliases || {})
  )
    return false;
  return true;
}

/**
 * True when a transcript exists but lives on another device — as opposed to a
 * meeting that genuinely contained no speech, which also has an empty
 * transcript and must not be described as missing.
 */
export function transcriptIsElsewhere(report: ReportData): boolean {
  return (
    report.transcriptStale === true ||
    (!report.speech &&
      !report.transcription?.trim() &&
      (report.transcriptChars ?? 0) > 0)
  );
}

/**
 * What to keep when a meeting is restored from Drive.
 *
 * The local copy is almost always "newer" — syncing writes the archive file
 * and then bumps the local revision twice — so comparing timestamps would skip
 * every restore forever. What actually matters is content: the Drive copy is
 * the only place a projected meeting's transcript still exists on this device.
 */
export function mergeRestoredReport(
  local: { report: ReportData; dirty: boolean } | undefined,
  fromDrive: ReportData,
): ReportData | null {
  if (!local) return fromDrive;
  // Unsynced local edits are the user's work and outrank a stored copy.
  if (local.dirty || !sameReportHome(local.report, fromDrive)) return null;
  const missingContent =
    !local.report.speech && !local.report.transcription?.trim();
  const driveHasContent =
    !!fromDrive.speech || !!fromDrive.transcription?.trim();
  if ((!missingContent && !local.report.transcriptStale) || !driveHasContent)
    return null;
  // Never replace the sole, unarchived full text, even when a newer index made
  // its freshness uncertain. An explicit conflict/recovery flow owns that case.
  if (
    !missingContent &&
    (!archiveReportId(local.report) || !archiveSyncedAt(local.report))
  )
    return null;
  const revision = transcriptRevisionOf(fromDrive);
  if (
    local.report.transcriptRevision &&
    revision !== local.report.transcriptRevision
  )
    return null;
  return {
    ...local.report,
    transcription: fromDrive.transcription,
    speech: fromDrive.speech,
    transcriptRevision: revision,
    transcriptStale: false,
    transcriptChars: undefined,
  };
}
