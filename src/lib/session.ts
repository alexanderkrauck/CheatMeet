import {
  GoogleAuthProvider,
  reauthenticateWithPopup,
  signInWithCredential,
  signInWithPopup,
} from "firebase/auth";
import { auth, provider } from "./firebase";

const SESSION_KEY = "cheatmeet:drive-session";
/** Fallback lifetime when the token's own expiry is unknown. */
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;
/** Renew this far ahead of expiry so an upload never starts on a dying token. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

type DriveSession = {
  token: string;
  owner: string;
  expiresAt: number;
  lifetimeMs: number;
  /** Whether this grant covers the calendar, carried with the token so a
   *  cached session still knows it after a reload. */
  calendar?: boolean;
};
let session: DriveSession | null = null;

function saveSession() {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Private browsing or blocked storage must not prevent this tab signing in.
  }
}

export function rememberToken(
  token: string | undefined,
  lifetimeMs = TOKEN_LIFETIME_MS,
  expectedOwner?: string,
  calendar = false,
) {
  const owner = auth.currentUser?.uid;
  // A token minted for one account must never be stored under another: the
  // signed-in user can change while the request is in flight.
  if (token && expectedOwner && owner !== expectedOwner) return;
  session =
    token && owner
      ? { token, owner, expiresAt: Date.now() + lifetimeMs, lifetimeMs, calendar }
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
          session = {
            ...(candidate as DriveSession),
            lifetimeMs: candidate.lifetimeMs || TOKEN_LIFETIME_MS,
          };
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
    remaining > session.lifetimeMs
  ) {
    session = null;
    saveSession();
    return null;
  }
  return remaining > Math.max(0, minValidityMs) ? session.token : null;
}

/**
 * Whether the stored grant actually covers the calendar. A refresh token's
 * scopes are fixed when it is issued, so enabling the feature server-side does
 * nothing for a user who consented before — they have to authorize again.
 *
 * Read from the session rather than from a module flag: `ensureDriveToken`
 * returns a cached token without contacting the server, so on most page loads
 * nothing would ever set a flag.
 */
export function hasCalendarGrant(): boolean {
  // Whether the grant covers the calendar does not expire with the access
  // token it was learned from. Gating on a live token made the calendar
  // vanish every time the cached token lapsed or a 401 cleared it.
  if (session?.calendar === true) return true;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw)?.calendar === true : false;
  } catch {
    return false;
  }
}

/** Re-renders anything gated on the grant when a token is minted or dropped. */
export function subscribeDriveSession(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("cheatmeet:drive-session", onChange);
  return () => window.removeEventListener("cheatmeet:drive-session", onChange);
}

// --- server-held authorization ---------------------------------------------

let serverAuth: Promise<boolean> | null = null;
let inFlight: Promise<string | null> | null = null;
let refresher: number | undefined;

/**
 * Whether this deployment mints Drive tokens server-side. While false the app
 * keeps the popup flow, so a deployment without the OAuth client secret
 * degrades instead of locking everyone out.
 */
export function serverAuthAvailable(): Promise<boolean> {
  // A network failure is not an answer. Caching it downgraded the whole tab to
  // the popup flow for its lifetime on one flaky request, so only a real
  // response is remembered; a failure answers false and is retried next time.
  return (serverAuth ||= fetch("/api/auth/config")
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    })
    .then((data) => data?.serverAuth === true)
    .catch(() => {
      serverAuth = null;
      return false;
    }));
}

/** Signals the grant is unusable; the app signs the user out to re-consent. */
function reportRevoked(message: string) {
  rememberToken(undefined);
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("cheatmeet:drive-revoked", { detail: { message } }),
    );
}

/**
 * Returns a usable Drive access token, minting a new one from the server when
 * the cached one is close to expiry. Signed in implies Drive-authorized, so
 * this is what the app calls instead of prompting.
 */
export async function ensureDriveToken(
  minValidityMs = RENEW_MARGIN_MS,
): Promise<string | null> {
  const cached = driveToken(minValidityMs);
  if (cached) return cached;
  const user = auth.currentUser;
  if (!user) return null;
  // Pin the identity before the first await: the signed-in account can change
  // while this runs, and a token minted for one user must never reach another.
  const owner = user.uid;
  if (!(await serverAuthAvailable())) return driveToken(minValidityMs);
  // One request at a time: several uploads starting together must not each
  // mint their own token.
  const mint = (inFlight ||= (async () => {
    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/drive-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => ({}));
      if (auth.currentUser?.uid !== owner) return null;
      if (response.status === 403 && data.reauth) {
        reportRevoked(data.error || "Google Drive ist nicht mehr freigegeben.");
        return null;
      }
      if (!response.ok)
        throw new Error(data.error || "Google Drive ist nicht erreichbar.");
      // The grant's real scope set, which can lag the server's configuration.
      rememberToken(
        data.accessToken,
        Math.max(60_000, Number(data.expiresInSeconds || 3600) * 1000 - 60_000),
        owner,
        data.calendar === true,
      );
      return data.accessToken as string;
    } finally {
      // A later sign-in may already own the slot; never clear someone else's.
      if (inFlight === mint) inFlight = null;
    }
  })());
  return mint;
}

/** Keeps the cached token fresh for as long as the user is signed in. */
export function startDriveTokenRefresh() {
  if (refresher !== undefined) return;
  const tick = () => void ensureDriveToken().catch(() => {});
  tick();
  refresher = window.setInterval(tick, 5 * 60 * 1000);
}

export function stopDriveTokenRefresh() {
  if (refresher !== undefined) clearInterval(refresher);
  refresher = undefined;
  inFlight = null;
  serverAuth = null;
}

/**
 * Drops the server-held grant. Google revokes for the whole OAuth client, so
 * this ends Drive access on every device — which is why it is an explicit
 * action in settings and never a side effect of signing out.
 */
export async function revokeDriveGrant(): Promise<void> {
  if (!auth.currentUser) throw new Error("Bitte zuerst anmelden.");
  if (!(await serverAuthAvailable()))
    throw new Error(
      "Diese Installation verwaltet den Drive-Zugriff nicht serverseitig. Bitte den Zugriff direkt im Google-Konto entziehen.",
    );
  const idToken = await auth.currentUser.getIdToken().catch(() => null);
  if (!idToken) throw new Error("Bitte erneut anmelden.");
  // Swallowing this told the user their access was revoked everywhere when it
  // may not have been revoked anywhere.
  const response = await fetch("/api/auth/revoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response || !response.ok)
    throw new Error(
      "Der Zugriff konnte bei Google nicht widerrufen werden. Bitte im Google-Konto unter „Drittanbieter-Apps“ prüfen.",
    );
}

/** The Google account id inside an unverified id_token, for comparison only. */
function googleSubjectOf(idToken: string): string {
  const part = idToken.split(".")[1] || "";
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const sub = String(
    JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))).sub ||
      "",
  );
  if (!sub) throw new Error("Google lieferte keine Identität.");
  return sub;
}

/** Runs the server's consent flow in a popup and resolves the Google id_token. */
function consentPopup(): Promise<string> {
  return new Promise((resolve, reject) => {
    const popup = window.open(
      "/api/auth/google/start",
      "cheatmeet-oauth",
      "width=520,height=640",
    );
    if (!popup) {
      reject(
        new Error(
          "Das Anmeldefenster wurde blockiert. Bitte Pop-ups für diese Seite erlauben.",
        ),
      );
      return;
    }
    const done = (fn: () => void) => {
      window.removeEventListener("message", onMessage);
      clearInterval(watch);
      fn();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; idToken?: string; error?: string };
      if (data?.source !== "cheatmeet-oauth") return;
      if (data.idToken) done(() => resolve(data.idToken!));
      else done(() => reject(new Error(data.error || "Anmeldung abgebrochen.")));
    };
    window.addEventListener("message", onMessage);
    const watch = window.setInterval(() => {
      if (popup.closed)
        done(() =>
          reject(
            new Error(
              "Das Anmeldefenster wurde geschlossen. Du kannst die Anmeldung erneut starten.",
            ),
          ),
        );
    }, 400);
  });
}

export async function connectGoogle(): Promise<string> {
  if (await serverAuthAvailable()) {
    // One consent screen: the server keeps the refresh token and hands back the
    // identity, which Firebase then adopts.
    const previous = auth.currentUser?.providerData.find(
      (p) => p.providerId === "google.com",
    )?.uid;
    const idToken = await consentPopup();
    const granted = googleSubjectOf(idToken);
    if (previous && previous !== granted)
      throw new Error(
        "Bitte dasselbe Google-Konto wie bei der Anmeldung verwenden.",
      );
    await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    const token = await ensureDriveToken(0);
    if (!token)
      throw new Error(
        "Google Drive wurde nicht freigegeben. Bitte erneut verbinden.",
      );
    startDriveTokenRefresh();
    return token;
  }
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
    return "Firebase verweigert das Speichern oder Lesen. Bitte die Firestore-Regeln und Datenbank prüfen. Deine lokale Kopie bleibt erhalten.";
  if (code === "unavailable")
    return "Firebase ist gerade nicht erreichbar. Bitte die Verbindung prüfen und erneut synchronisieren.";
  if (code === "auth/popup-blocked")
    return "Das Anmeldefenster wurde blockiert. Bitte Pop-ups für diese Seite erlauben.";
  if (code === "auth/popup-closed-by-user")
    return "Das Anmeldefenster wurde geschlossen. Du kannst die Anmeldung erneut starten.";
  if (code === "auth/user-mismatch")
    return "Bitte dasselbe Google-Konto wie bei der Anmeldung verwenden.";
  return error instanceof Error
    ? error.message
    : "Etwas ist schiefgegangen. Bitte erneut versuchen.";
}
