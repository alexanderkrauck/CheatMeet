import {
  GoogleAuthProvider,
  getAdditionalUserInfo,
  linkWithPopup,
  reload,
  reauthenticateWithPopup,
  signInWithPopup,
  unlink,
} from "firebase/auth";
import { auth, provider } from "./firebase";
import {markIdentitySetup} from './identitySetup';

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
  const owner=auth.currentUser?.uid;
  if(!owner) return false;
  // Whether the grant covers the calendar does not expire with the access
  // token it was learned from. Gating on a live token made the calendar
  // vanish every time the cached token lapsed or a 401 cleared it.
  if (session?.owner === owner && session?.calendar === true) return true;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const stored=raw ? JSON.parse(raw) : null;
    return stored?.owner === owner && stored?.calendar === true;
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
let grantRevision = 0;
const revokingOwners = new Set<string>();
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
  if (auth.currentUser && revokingOwners.has(auth.currentUser.uid)) return null;
  const cached = driveToken(minValidityMs);
  if (cached) return cached;
  const user = auth.currentUser;
  if (!user) return null;
  // Pin the identity before the first await: the signed-in account can change
  // while this runs, and a token minted for one user must never reach another.
  const owner = user.uid;
  const revision = grantRevision;
  if (!(await serverAuthAvailable())) return driveToken(minValidityMs);
  if (auth.currentUser?.uid !== owner || revision !== grantRevision) return null;
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
      if (auth.currentUser?.uid !== owner || revision !== grantRevision) return null;
      if (response.status === 403 && data.reauth) {
        if(data.reason==='no_grant')rememberToken(undefined);
        else reportRevoked(data.error || "Google Drive ist nicht mehr freigegeben.");
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
 * Explicitly contain local credentials and request provider-wide revocation.
 * Resolve only on confirmed provider success; partial/unknown results throw a
 * German warning. Ordinary sign-out never calls this action.
 */
export async function revokeDriveGrant(): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error("Bitte zuerst anmelden.");
  const owner = user.uid;
  if (revokingOwners.has(owner)) throw Error("Die Google-Verbindung wird bereits getrennt.");
  revokingOwners.add(owner);
  const check = () => { if (auth.currentUser?.uid !== owner) throw Error("Das angemeldete Konto hat sich geändert."); };
  // Also discard a mint already in flight; deleting storage alone lets its late
  // response put the old credential back. No sign-out or provider revoke on logout.
  grantRevision++;
  stopDriveTokenRefresh();
  rememberToken(undefined);
  try {
    if (!(await serverAuthAvailable()))
      throw new Error(
        "Diese Installation verwaltet den Drive-Zugriff nicht serverseitig. Bitte den Zugriff direkt im Google-Konto entziehen.",
      );
    check();
    const idToken = await user.getIdToken().catch(() => null);
    check();
    if (!idToken) throw new Error("Bitte erneut anmelden.");
    // A failed provider call is not confirmed provider-wide revocation.
    const response = await fetch("/api/auth/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    check();
    const data = await response?.json().catch(() => ({}));
    check();
    if (!response?.ok || data?.revoked !== true)
      throw new Error(
        typeof data?.warning === "string" ? data.warning : "Der lokale Google-Zugriff wurde in diesem Tab beendet. Der Widerruf bei Google ist nicht bestätigt. Bitte im Google-Konto unter „Drittanbieter-Apps“ den Drive-/Kalender-Zugriff prüfen; laufende Verarbeitung kann unterbrochen werden.",
      );
  } finally {
    revokingOwners.delete(owner);
    if (auth.currentUser?.uid === owner) {
      grantRevision++;
      inFlight = null;
      rememberToken(undefined);
    }
  }
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
function consentPopup(url = "/api/auth/google/start"): Promise<string> {
  return new Promise((resolve, reject) => {
    const popup = window.open(
      url,
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
      if (event.origin !== window.location.origin || event.source !== popup) return;
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

/** Identity only: file/calendar permission is requested later in connection setup. */
export async function signInGoogle():Promise<void>{
  if(auth.currentUser)throw Error('Bitte Google in den Einstellungen ausdrücklich mit dem bestehenden Arbeitsbereich verknüpfen.');
  const result=await signInWithPopup(auth,new GoogleAuthProvider());
  markIdentitySetup(result.user.uid,getAdditionalUserInfo(result)?.isNewUser===true);
}
export async function linkGoogleIdentity():Promise<void>{
  const user=auth.currentUser;
  if(!user)throw Error('Bitte zuerst mit dem bestehenden Konto anmelden.');
  const owner=user.uid;
  const result=await linkWithPopup(user,new GoogleAuthProvider());
  if(auth.currentUser?.uid!==owner||result.user.uid!==owner)throw Error('Das angemeldete Konto hat sich geändert. Die Verknüpfung wurde nicht übernommen.');
}
/** Remove only a login method, never provider files, grants or workspace data. */
export async function unlinkGoogleIdentity(): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw Error("Bitte zuerst mit dem bestehenden Konto anmelden.");
  const owner = user.uid;
  const check = () => {
    if (auth.currentUser?.uid !== owner) throw Error("Das angemeldete Konto hat sich geändert.");
    if (!user.providerData.some(p => p.providerId === "google.com")) throw Error("Google ist nicht als Anmeldung verknüpft.");
    if (!user.providerData.some(p => p.providerId === "microsoft.com")) throw Error("Die letzte Anmeldemethode kann nicht entfernt werden. Bitte zuerst eine weitere Anmeldung verknüpfen.");
  };
  try {
    await reload(user);
    check();
    const identity = await user.getIdToken(true);
    check();
    const response = await fetch("/api/auth/google/preserve", {method: "POST", headers: {Authorization: `Bearer ${identity}`}, signal: AbortSignal.timeout(30_000)});
    check();
    const data = await response.json().catch(() => ({}));
    check();
    if (!response.ok || data.preserved !== true) throw Error(typeof data.error === "string" ? data.error : "Der Google-Zugriff konnte nicht sicher vom Login getrennt werden. Bitte später erneut versuchen. Die Anmeldung bleibt verknüpft.");
    await reload(user);
    check();
    await unlink(user, "google.com");
    if (auth.currentUser?.uid !== owner) throw Error("Das angemeldete Konto hat sich geändert.");
    await user.getIdToken(true);
    if (auth.currentUser?.uid !== owner) throw Error("Das angemeldete Konto hat sich geändert.");
  } catch (error) {
    if ((error as {code?: string})?.code === "auth/requires-recent-login") throw Error("Bitte erneut anmelden und die Anmeldemethode danach entfernen. Die Verknüpfung wurde nicht entfernt.");
    throw error;
  }
}
export async function connectGoogle(): Promise<string> {
  const startingUser=auth.currentUser;
  const owner=startingUser?.uid;
  if (!startingUser) throw Error("Bitte zuerst anmelden. Google-Datenzugriff und Anmeldung sind getrennt.");
  const check=()=>{if(auth.currentUser?.uid!==owner)throw new Error("Das angemeldete Konto hat sich geändert.");};
  if (await serverAuthAvailable()) {
    check();
    // Data consent is bound to the existing UID; it never adopts/adds a login.
    const previous = auth.currentUser?.providerData.find(
      (p) => p.providerId === "google.com",
    )?.uid;
    const identity = await startingUser.getIdToken();
    check();
    const start = await fetch("/api/auth/google/start", {method:"POST",headers:{Authorization:`Bearer ${identity}`},signal:AbortSignal.timeout(20_000)});
    check();
    const data = await start.json().catch(() => ({}));
    check();
    if (!start.ok || typeof data.url !== "string") throw Error("Google-Verbindung konnte nicht gestartet werden. Bitte erneut versuchen.");
    const target = new URL(data.url);
    if (target.origin !== "https://accounts.google.com") throw Error("Ungültige Google-Anmeldeadresse.");
    const idToken = await consentPopup(target.href);
    check();
    const granted = googleSubjectOf(idToken);
    if (previous && previous !== granted)
      throw new Error(
        "Bitte dasselbe Google-Konto wie bei der Anmeldung verwenden.",
      );
    grantRevision++;
    inFlight = null;
    rememberToken(undefined);
    const token = await ensureDriveToken(0);
    if (!token)
      throw new Error(
        "Google Drive wurde nicht freigegeben. Bitte erneut verbinden.",
      );
    startDriveTokenRefresh();
    return token;
  }
  check();
  if (!startingUser.providerData?.some(p=>p.providerId==="google.com"))
    throw Error("Google-Datenzugriff ohne zusätzliche Anmeldung benötigt die serverseitige Google-Verbindung. Bitte die Einrichtung dieser Installation prüfen. Es wurde keine Anmeldemethode hinzugefügt.");
  const result = await reauthenticateWithPopup(startingUser, provider);
  check();
  const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  rememberToken(token, TOKEN_LIFETIME_MS, owner);
  if (!token)
    throw new Error(
      "Google Drive wurde nicht freigegeben. Bitte erneut verbinden.",
    );
  return token;
}

export function errorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "auth/account-exists-with-different-credential" || code === "auth/credential-already-in-use" || code === "auth/email-already-in-use")
    return "Diese Anmeldung gehört zu einem bestehenden Konto. Bitte zuerst mit dessen ursprünglicher Anmeldemethode anmelden und die weitere Anmeldemethode in den Einstellungen ausdrücklich verknüpfen. Konten werden nicht anhand gleicher E-Mail-Adressen zusammengeführt.";
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
