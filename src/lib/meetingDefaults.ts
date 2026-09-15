import {
  DEFAULT_RETENTION,
  retentionDays,
  type RetentionPolicy,
} from "../../shared/consent";
import { DEFAULT_LANGUAGES, validLanguages } from "../../shared/transcription";

/**
 * How a new meeting starts. Both settings are per browser, like the audio
 * source preference: they describe a habit on this device, not an account,
 * and keeping them out of Firestore avoids a rules change for a preference
 * that is worth nothing on another machine.
 */
const LANGUAGE_KEY = "cheatmeet:languages";
const NAME_KEY = "cheatmeet:my-name";
const CALENDAR_KEY = "cheatmeet:calendar-sync";
const RETENTION_KEY = "cheatmeet:retention";

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private browsing or blocked site data: fall back to the shipped default.
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // The choice just does not persist.
  }
};

/** The set a new recording starts from, never empty and never invalid. */
export function defaultLanguages(): string[] {
  const stored = read(LANGUAGE_KEY);
  if (!stored) return [...DEFAULT_LANGUAGES];
  const parsed = stored.split(",").filter(Boolean);
  return validLanguages(parsed) ? parsed : [...DEFAULT_LANGUAGES];
}

export function setDefaultLanguages(languages: string[]) {
  write(LANGUAGE_KEY, validLanguages(languages) ? languages.join(",") : "");
}

/**
 * The name the microphone speaker gets in a live transcript. The Google
 * account name is a reasonable guess, not a decision — it can be a full legal
 * name, and it ends up in every report.
 */
export function ownSpeakerName(accountName?: string | null): string {
  return (
    read(NAME_KEY)?.trim().slice(0, 80) ||
    accountName?.trim().slice(0, 80) ||
    "Ich"
  );
}

export const setOwnSpeakerName = (name: string) =>
  write(NAME_KEY, name.trim().slice(0, 80));

/**
 * Whether a finished report is written back to its calendar event on its own.
 * Off by default: writing into someone's calendar is not something to start
 * doing because a scope happens to be available.
 */
export const calendarSyncEnabled = () => read(CALENDAR_KEY) === "on";
export const setCalendarSync = (on: boolean) => write(CALENDAR_KEY, on ? "on" : "");

/**
 * What a NEW meeting promises. Per device on purpose: the enforced value is
 * frozen into each meeting's consent record, so a different default on another
 * machine can only change what the next notice says — never what an existing
 * promise enforces.
 */
export function savedRetention(): RetentionPolicy {
  const stored = read(RETENTION_KEY);
  if (!stored) return DEFAULT_RETENTION;
  try {
    const parsed = JSON.parse(stored);
    return {
      audioDays: retentionDays(parsed?.audioDays),
      textDays: retentionDays(parsed?.textDays),
    };
  } catch {
    return DEFAULT_RETENTION;
  }
}

export const setSavedRetention = (policy: RetentionPolicy) =>
  write(
    RETENTION_KEY,
    JSON.stringify({
      audioDays: retentionDays(policy.audioDays),
      textDays: retentionDays(policy.textDays),
    }),
  );
