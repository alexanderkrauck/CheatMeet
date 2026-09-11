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
) {
  const owner = auth.currentUser?.uid;
  // A token minted for one account must never be stored under another: the
  // signed-in user can change while the request is in flight.
  if (token && expectedOwner && owner !== expectedOwner) return;
  session =
    token && owner
      ? { token, owner, expiresAt: Date.now() + lifetimeMs, lifetimeMs }
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
  return (serverAuth ||= fetch("/api/auth/config")
    .then((r) => r.json())
    .then((d) => d?.serverAuth === true)
    .catch(() => false));
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
      rememberToken(
        data.accessToken,
        Math.max(60_000, Number(data.expiresInSeconds || 3600) * 1000 - 60_000),
        owner,
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

/** Drops the server-held grant so signing out leaves no offline access behind. */
export async function revokeDriveGrant(): Promise<void> {
  if (!auth.currentUser || !(await serverAuthAvailable())) return;
  const idToken = await auth.currentUser.getIdToken().catch(() => null);
  if (!idToken) return;
  await fetch("/api/auth/revoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
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
              "Das Anmeldefenster wurde geschlossen. Sie können die Anmeldung erneut starten.",
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
