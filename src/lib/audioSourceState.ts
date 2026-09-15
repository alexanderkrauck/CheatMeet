import type { ConsentSource } from "../../shared/consent";
import type { AudioSourcePreference } from "./audioSources";

/**
 * What is actually being recorded, and what to tell the user when that is less
 * than they asked for.
 *
 * The recorder and the consent notice must name the same sources: the notice
 * claims "the audio of this call, including the other participants' voices"
 * only when system audio really arrived. Deriving both from this one function
 * is what keeps the promise and the recording from drifting apart.
 */
export function describeAudioSources(input: {
  requested: AudioSourcePreference;
  displayMediaSupported: boolean;
  system: MediaStream | undefined;
}): { sources: ConsentSource[]; warning: string } {
  const micOnly = { sources: ["mic"] as ConsentSource[], warning: "" };
  if (input.requested !== "mic+system") return micOnly;
  if (!input.displayMediaSupported)
    return {
      ...micOnly,
      warning:
        "Dieser Browser unterstützt keine Bildschirmfreigabe. Es wird nur das Mikrofon aufgenommen.",
    };
  if (!input.system)
    return {
      ...micOnly,
      warning:
        "Systemaudio wurde nicht freigegeben. Es wird nur das Mikrofon aufgenommen.",
    };
  if (!input.system.getAudioTracks().length)
    return {
      ...micOnly,
      warning:
        "Die Freigabe enthält kein Systemaudio. Es wird nur das Mikrofon aufgenommen. Prüfe beim nächsten Mal „Audio teilen“ und ob dein Browser Audio für den gewählten Tab oder Bildschirm unterstützt.",
    };
  return { sources: ["mic", "system"], warning: "" };
}
