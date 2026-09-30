import type { LiveConnection } from "../../shared/transcription";

export interface LiveStatus {
  text: string;
  /** True when the app gave up on its own and only a person can start it again. */
  canRestart: boolean;
}

/** Shown while an assistant is actually reading along, so it is never a surprise. */
export function shareNotice(share: "waiting" | "listening" | "off" | undefined, recording: string): string | null {
  return share === "listening" && recording === "recording" ? "Ein KI-Assistent liest live mit" : null;
}

/**
 * What to tell the person recording about the live transcript. Null means
 * nothing is wrong (or nothing is expected): the bar stays quiet, so a message
 * always means "look at this".
 */
export function liveStatus(
  connection: LiveConnection | undefined,
  recording: string,
): LiveStatus | null {
  if (recording !== "recording") return null;
  if (connection === "reconnecting")
    return { text: "Live-Transkript getrennt – verbinde neu …", canRestart: false };
  if (connection === "stopped")
    return { text: "Live-Transkript unterbrochen. Die Aufnahme läuft weiter.", canRestart: true };
  return null;
}
