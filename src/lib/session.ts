import {
  GoogleAuthProvider,
  reauthenticateWithPopup,
  signInWithPopup,
} from "firebase/auth";
import { auth, provider } from "./firebase";
const SESSION_KEY = "cheatmeet:drive-session";
// Google access tokens are short-lived. Keep a conservative margin rather than
// treating the persisted Firebase login as permanent Drive authorization.
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;
type DriveSession = { token: string; owner: string; expiresAt: number };
let session: DriveSession | null = null;

function saveSession() {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Private browsing or blocked storage must not prevent this tab signing in.
  }
}

export function rememberToken(token: string | undefined) {
  const owner = auth.currentUser?.uid;
  session =
    token && owner
      ? { token, owner, expiresAt: Date.now() + TOKEN_LIFETIME_MS }
      : null;
  saveSession();
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("cheatmeet:drive-session"));
}

export function driveToken(minValidityMs = 0): string | null {
  const owner = auth.currentUser?.uid;
  // Firebase restores its account asynchronously. Do not discard the stored
  // token while that restoration is still pending; logout clears it explicitly.
  if (!owner) return null;
  if (!session) {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const candidate = JSON.parse(raw) as Partial<DriveSession> | null;
        if (
          candidate &&
          typeof candidate.token === "string" &&
          candidate.token &&
          typeof candidate.owner === "string" &&
          candidate.owner &&
          typeof candidate.expiresAt === "number" &&
          Number.isFinite(candidate.expiresAt)
        )
          session = candidate as DriveSession;
        else saveSession();
      }
    } catch {
      saveSession();
    }
  }
  if (!session) return null;
  const remaining = session.expiresAt - Date.now();
  if (
    session.owner !== owner ||
    remaining <= 0 ||
    remaining > TOKEN_LIFETIME_MS
  ) {
    session = null;
    saveSession();
    return null;
  }
  return remaining > Math.max(0, minValidityMs) ? session.token : null;
}
export async function connectGoogle() {
  const result = auth.currentUser
    ? await reauthenticateWithPopup(auth.currentUser, provider)
    : await signInWithPopup(auth, provider);
  const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  rememberToken(token);
  if (!token)
    throw new Error(
      "Google Drive wurde nicht freigegeben. Bitte erneut verbinden.",
    );
  return token;
}
export function errorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "permission-denied")
    return "Firebase verweigert das Speichern oder Lesen. Bitte die Firestore-Regeln und Datenbank prüfen. Ihre lokale Kopie bleibt erhalten.";
  if (code === "unavailable")
    return "Firebase ist gerade nicht erreichbar. Bitte die Verbindung prüfen und erneut synchronisieren.";
  if (code === "auth/popup-blocked")
    return "Das Anmeldefenster wurde blockiert. Bitte Pop-ups für diese Seite erlauben.";
  if (code === "auth/popup-closed-by-user")
    return "Das Anmeldefenster wurde geschlossen. Sie können die Anmeldung erneut starten.";
  if (code === "auth/user-mismatch")
    return "Bitte dasselbe Google-Konto wie bei der Anmeldung verwenden.";
  return error instanceof Error
    ? error.message
    : "Etwas ist schiefgegangen. Bitte erneut versuchen.";
}
