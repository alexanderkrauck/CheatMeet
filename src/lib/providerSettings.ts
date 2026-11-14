import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase";
import { cachedMicrosoftConnections } from "./microsoft";
import {
  microsoftHome,
  type MicrosoftHome,
  type ServiceProvider,
} from "../../shared/storage";

type Settings = {
  calendarProvider: ServiceProvider;
  calendarConnectionId?: string;
  calendarId: string;
  meetingHome: MicrosoftHome | null;
};
const key = (owner = auth.currentUser?.uid) =>
  `cheatmeet:provider-settings:${owner || "signed-out"}`;
const legacy = (): Settings => ({
  calendarProvider: "google",
  calendarConnectionId: "",
  calendarId: "primary",
  meetingHome: null,
});
function parse(raw: Record<string, unknown>): Settings {
  if (
    raw.calendarProvider !== undefined &&
    raw.calendarProvider !== "google" &&
    raw.calendarProvider !== "microsoft"
  )
    throw new Error(
      "Die gespeicherte Kalenderauswahl ist ungültig. Bitte in den Einstellungen erneut auswählen.",
    );
  for (const field of ["calendarId", "calendarConnectionId"])
    if (
      raw[field] !== undefined &&
      (typeof raw[field] !== "string" || (raw[field] as string).length > 512)
    )
      throw new Error(
        "Die gespeicherte Kalenderauswahl ist ungültig. Bitte in den Einstellungen erneut auswählen.",
      );
  return {
    calendarProvider:
      raw.calendarProvider === "microsoft" ? "microsoft" : "google",
    calendarConnectionId:
      typeof raw.calendarConnectionId === "string" && raw.calendarConnectionId
        ? raw.calendarConnectionId
        : "",
    calendarId:
      typeof raw.calendarId === "string" && raw.calendarId
        ? raw.calendarId
        : "primary",
    meetingHome: raw.meetingHome ? microsoftHome(raw.meetingHome) : null,
  };
}
/** Absent/corrupt cache is unknown, not evidence of an authoritative Google default. */
function known(owner = auth.currentUser?.uid): Settings | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key(owner)) || "null");
    return raw &&
      (raw.calendarProvider === "google" ||
        raw.calendarProvider === "microsoft")
      ? parse(raw)
      : null;
  } catch {
    return null;
  }
}
function owner() {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Bitte zuerst anmelden.");
  return {
    uid,
    check: () => {
      if (auth.currentUser?.uid !== uid)
        throw new Error("Das angemeldete Konto hat sich geändert.");
    },
  };
}
function cache(uid: string, value: Settings) {
  const before = known(uid);
  try {
    localStorage.setItem(key(uid), JSON.stringify(value));
  } catch {
    /* optional cache */
  }
  if (
    typeof window !== "undefined" &&
    JSON.stringify(before) !== JSON.stringify(value)
  )
    window.dispatchEvent(new Event("cheatmeet:provider-settings"));
}
/** Synchronous presentation only; default-dependent operations await loadProviderSettings. */
export const savedCalendarProvider = (): ServiceProvider =>
  known()?.calendarProvider || "google";
export const savedCalendarConnectionId = (): string | undefined =>
  known()?.calendarConnectionId || undefined;
export const savedCalendarId = (): string => known()?.calendarId || "primary";
export const savedMeetingHome = (): MicrosoftHome | null =>
  auth.currentUser ? known()?.meetingHome || null : null;
export const hasMicrosoftCalendar = (
  connectionId = savedCalendarConnectionId(),
) =>
  !!connectionId &&
  cachedMicrosoftConnections().some(
    (c) => c.connectionId === connectionId && c.calendar,
  );

const pending = new Map<string, Promise<Settings>>();
export async function loadProviderSettings(): Promise<Settings> {
  const { uid, check } = owner();
  const existing = pending.get(uid);
  if (existing) {
    const value = await existing;
    check();
    return value;
  }
  const request = (async () => {
    let snap;
    try {
      snap = await getDoc(doc(db, "users", uid, "settings", "providers"));
    } catch (error) {
      check();
      const cached = known(uid);
      if (cached) return cached;
      throw error;
    }
    check();
    // Successful absence is the legacy Google default; malformed explicit data is not.
    const raw = snap.data();
    const value = raw ? parse(raw) : legacy();
    cache(uid, value);
    return value;
  })();
  pending.set(uid, request);
  try {
    return await request;
  } finally {
    if (pending.get(uid) === request) pending.delete(uid);
  }
}
export async function loadMeetingHome() {
  return (await loadProviderSettings()).meetingHome;
}
async function save(patch: Partial<Settings>, loaded?: Settings) {
  const { uid, check } = owner();
  const current = loaded || (await loadProviderSettings());
  check();
  const next = { ...current, ...patch };
  await setDoc(doc(db, "users", uid, "settings", "providers"), patch, {
    merge: true,
  });
  check();
  cache(uid, next);
}
export async function saveCalendarProvider(
  provider: ServiceProvider,
  connectionId?: string,
  calendarId?: string,
): Promise<void> {
  const { check } = owner();
  const current = await loadProviderSettings();
  check();
  let pinned =
    connectionId ||
    (current.calendarProvider === provider
      ? current.calendarConnectionId
      : undefined);
  if (provider === "microsoft" && !pinned) {
    const candidates = cachedMicrosoftConnections().filter((c) => c.calendar);
    if (candidates.length > 1)
      throw new Error("Bitte das Outlook-Konto für den Kalender auswählen.");
    pinned = candidates[0]?.connectionId;
  }
  await save(
    {
      calendarProvider: provider,
      calendarConnectionId: provider === "microsoft" ? pinned || "" : "",
      calendarId:
        calendarId ||
        (current.calendarProvider === provider
          ? current.calendarId
          : "primary"),
    },
    current,
  );
}
export async function saveMeetingHome(home: MicrosoftHome | null) {
  const valid = home ? microsoftHome(home) : null;
  if (
    valid &&
    (valid.folderId ||
      valid.audioId ||
      valid.reportId ||
      valid.markdownId ||
      valid.transcriptId ||
      valid.consentId ||
      valid.syncedAt)
  )
    throw new Error(
      "Bitte einen Stammordner, kein bestehendes Meeting wählen.",
    );
  await save({ meetingHome: valid });
}
