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
  meetingHome: MicrosoftHome | null;
};
const key = (owner = auth.currentUser?.uid) =>
  `cheatmeet:provider-settings:${owner || "signed-out"}`;
function read(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(key()) || "{}");
    return {
      calendarProvider:
        raw.calendarProvider === "microsoft" ? "microsoft" : "google",
      meetingHome: raw.meetingHome ? microsoftHome(raw.meetingHome) : null,
    };
  } catch {
    return { calendarProvider: "google", meetingHome: null };
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
  try {
    localStorage.setItem(key(uid), JSON.stringify(value));
  } catch {
    /* optional cache */
  }
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("cheatmeet:provider-settings"));
}
export const savedCalendarProvider = (): ServiceProvider =>
  auth.currentUser ? read().calendarProvider : "google";
export const savedMeetingHome = (): MicrosoftHome | null =>
  auth.currentUser ? read().meetingHome : null;
export const hasMicrosoftCalendar = () =>
  cachedMicrosoftConnections().some((c) => c.calendar);
export async function loadProviderSettings(): Promise<Settings> {
  const { uid, check } = owner();
  const snap = await getDoc(doc(db, "users", uid, "settings", "providers"));
  check();
  const raw = snap.data();
  if (!raw) return read();
  const value: Settings = {
    calendarProvider:
      raw.calendarProvider === "microsoft" ? "microsoft" : "google",
    meetingHome: raw.meetingHome ? microsoftHome(raw.meetingHome) : null,
  };
  cache(uid, value);
  return value;
}
export async function loadMeetingHome() {
  return (await loadProviderSettings()).meetingHome;
}
async function save(patch: Partial<Settings>) {
  const { uid, check } = owner();
  const next = { ...read(), ...patch };
  await setDoc(doc(db, "users", uid, "settings", "providers"), patch, {
    merge: true,
  });
  check();
  cache(uid, next);
}
export async function saveCalendarProvider(provider: ServiceProvider) {
  await save({ calendarProvider: provider });
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
