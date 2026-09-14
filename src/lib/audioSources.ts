/**
 * Which capture sources a new recording should use. A purely local UX
 * preference, not synced across devices: `getDisplayMedia`'s own consent
 * prompt cannot be remembered by the browser across sessions either, so
 * there is nothing meaningful to keep in sync.
 */
export type AudioSourcePreference = "mic" | "mic+system";

const KEY = "cheatmeet:audio-sources";

/** Falls back to today's shipped behaviour (mic + system) so an existing
 * user who has never opened this setting sees no change. */
export function audioSourcePreference(): AudioSourcePreference {
  try {
    return localStorage.getItem(KEY) === "mic" ? "mic" : "mic+system";
  } catch {
    return "mic+system";
  }
}

export function setAudioSourcePreference(value: AudioSourcePreference) {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Private browsing or a full quota: the choice just does not persist.
  }
}
