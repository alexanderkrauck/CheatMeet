import express from "express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";
import firebaseConfig from "../firebase-applet-config.json";
import {
  fileGrantStore,
  firestoreStore,
  type RefreshTokenStore,
  ownerGoogleGrant,
  ownerGoogleGrantState,
  disconnectOwnerGoogleGrant,
  invalidateOwnerGoogleGrant,
  saveOwnerGoogleGrant,
  preserveOwnerGoogleGrant,
} from "./tokenStore";
import { firebaseAccountFor } from "./microsoftAuth";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Only files this app created. Never widen: it bounds a server compromise. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/**
 * Read and write events, on the user's calendars.
 *
 * Opt-in because it is a sensitive scope and its prerequisites live outside
 * this repo: the Calendar API has to be enabled on the project and the scope
 * has to be registered on the OAuth consent screen. Leaving it off keeps the
 * authorization request identical to the Drive-only one, so a deployment that
 * has not done that setup is unaffected.
 */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/**
 * The full-calendar scope is a superset — it can delete whole calendars, which
 * this app never does, so it is never requested. But a grant that already has
 * it can do everything the feature needs, and refusing that would be a false
 * negative the user could not diagnose.
 */
const CALENDAR_SUPERSET = "https://www.googleapis.com/auth/calendar";
export const grantsCalendar = (scope = "") => {
  const granted = scope.split(/\s+/);
  return granted.includes(CALENDAR_SCOPE) || granted.includes(CALENDAR_SUPERSET);
};
const SCOPES = `openid email profile ${DRIVE_SCOPE} ${CALENDAR_SCOPE}`;
const STATE_COOKIE = "cheatmeet_oauth_state";

export interface GoogleTokens {
  accessToken: string;
  expiresInSeconds: number;
  scope?: string;
  refreshToken?: string;
  idToken?: string;
}

export const codeChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export function buildAuthUrl({
  clientId,
  redirectUri,
  state,
  verifier,
  loginHint,
}: {
  clientId: string;
  redirectUri: string;
  state: string;
  verifier?: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    // Required to be issued a refresh token at all, and to be issued a new one
    // rather than silently reusing a grant we may not have stored.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  if (verifier) {
    params.set("code_challenge", codeChallenge(verifier));
    params.set("code_challenge_method", "S256");
  }
  if (loginHint) params.set("login_hint", loginHint);
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function tokenRequest(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<GoogleTokens> {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const error = new Error(String(data.error || response.status));
    // invalid_grant means the grant is gone for good: revoked, expired or
    // replaced. Callers translate it into a sign-out rather than a retry.
    (error as { code?: string }).code = String(data.error || "token_error");
    throw error;
  }
  return {
    accessToken: String(data.access_token || ""),
    expiresInSeconds: Number(data.expires_in || 3600),
    // What the grant actually covers. A refresh token's scope set is fixed at
    // grant time, so a user who consented before the calendar scope was
    // added keeps a Drive-only token however new the server is.
    scope: typeof data.scope === "string" ? data.scope : undefined,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    idToken: typeof data.id_token === "string" ? data.id_token : undefined,
  };
}

export const exchangeCode = (
  {
    code,
    clientId,
    clientSecret,
    redirectUri,
    verifier,
  }: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    verifier?: string;
  },
  fetchImpl: typeof fetch = fetch,
) =>
  tokenRequest(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      ...(verifier ? { code_verifier: verifier } : {}),
    }),
    fetchImpl,
  );

export const refreshAccessToken = (
  {
    refreshToken,
    clientId,
    clientSecret,
  }: { refreshToken: string; clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
) =>
  tokenRequest(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
    fetchImpl,
  );

const keys = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

/**
 * The Google account behind a Firebase ID token. `firebase.identities` carries
 * the provider's own subject, which is what the grant store is keyed by.
 */
export async function googleAccountFor(
  token: string,
  projectId: string,
  verify = jwtVerify,
): Promise<{ uid: string; googleSub: string }> {
  const { payload } = await verify(token, keys, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  });
  const identities = (
    payload.firebase as { identities?: Record<string, unknown> } | undefined
  )?.identities;
  const google = identities?.["google.com"];
  const googleSub = Array.isArray(google) ? String(google[0] || "") : "";
  if (!payload.sub || !googleSub)
    throw new Error("Not a Google-backed Firebase identity");
  return { uid: String(payload.sub), googleSub };
}

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Express url-encodes cookie values; compare the decoded form.
function readCookie(header: string | undefined, name: string) {
  const raw = (header || "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)?.[1];
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Escapes a value for embedding in the callback page's inline script. */
const asJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

export interface AuthRouterOptions {
  store?: RefreshTokenStore;
  fetchImpl?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  projectId?: string;
  identify?: (token: string) => Promise<{ uid: string; googleSub: string }>;
}

/**
 * Server-held Drive authorization.
 *
 * Firebase's Google sign-in gives the browser an access token that expires in
 * about an hour and never a refresh token, so the only client-side recovery is
 * another consent popup. Here the server runs the authorization-code flow,
 * keeps the refresh token, and mints short-lived access tokens on demand. The
 * browser still uploads straight to Drive; media never passes through here.
 */
export function createAuthRouter(options: AuthRouterOptions = {}) {
  const router = express.Router();
  const fetchImpl = options.fetchImpl || fetch;
  const projectId =
    options.projectId ||
    process.env.FIREBASE_PROJECT_ID ||
    firebaseConfig.projectId;
  // `??` not `||`: an explicitly supplied empty option means "not configured",
  // which is the only way to exercise the missing-client-id path in a checkout
  // whose firebase-applet-config.json happens to carry an oAuthClientId.
  const clientId =
    options.clientId ??
    (process.env.GOOGLE_OAUTH_CLIENT_ID ||
      (firebaseConfig as { oAuthClientId?: string }).oAuthClientId ||
      "");
  const clientSecret =
    options.clientSecret ?? (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "");
  const identify =
    options.identify || ((token: string) => firebaseAccountFor(token, projectId, null));

  let store = options.store;
  // Same split as the transcription store: Firestore in production, private
  // files locally, because the Firestore path needs the Cloud Run metadata
  // server to authenticate.
  const grantStore = () =>
    (store ||=
      process.env.NODE_ENV === "production"
        ? firestoreStore({ fetchImpl })
        : fileGrantStore());
  const configured = () => Boolean(clientId && clientSecret);
  const redirectUri = (req: express.Request) =>
    `${req.protocol}://${req.get("host")}/api/auth/google/callback`;
  const bindingSignature = (value: string) => createHmac("sha256", clientSecret).update(value).digest("base64url");
  const authenticated = async (req: express.Request) => {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || "")?.[1];
    if (!token) throw Error("Bitte erneut anmelden.");
    const identity = await identify(token);
    if (!identity.uid) throw Error("Bitte erneut anmelden.");
    return identity;
  };

  // Owner-bound data consent, independent from Firebase sign-in/linking. A MAC
  // prevents a browser from changing the owner encoded in its HttpOnly cookie.
  router.post("/auth/google/start", async (req, res) => {
    if (!configured()) { res.status(503).json({error: "Server-Anmeldung ist nicht eingerichtet."}); return; }
    let identity: {uid: string; googleSub: string};
    try { identity = await authenticated(req); }
    catch { res.status(401).json({error: "Bitte erneut anmelden."}); return; }
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const startedAt = Date.now();
    const binding = Buffer.from(JSON.stringify({...identity, startedAt, expiresAt: startedAt + 10 * 60_000})).toString("base64url");
    const value = `${state}.${verifier}.${binding}`;
    res.cookie(STATE_COOKIE, `${value}.${bindingSignature(value)}`, {httpOnly: true, sameSite: "lax", secure: req.protocol === "https", path: "/api/auth", maxAge: 10 * 60_000});
    res.set("Cache-Control", "no-store").json({url: buildAuthUrl({clientId, redirectUri: redirectUri(req), state, verifier})});
  });
  router.post("/auth/google/preserve", async (req, res) => {
    if (!configured()) { res.status(503).json({error: "Die serverseitige Google-Verbindung ist nicht eingerichtet. Der Google-Login bleibt verknüpft, damit vorhandene Archive erreichbar bleiben."}); return; }
    let identity: {uid: string; googleSub: string};
    try { identity = await authenticated(req); }
    catch { res.status(401).json({error: "Bitte erneut anmelden."}); return; }
    try {
      await preserveOwnerGoogleGrant(grantStore(), identity);
      res.set("Cache-Control", "no-store").json({preserved: true});
    } catch { res.status(503).json({error: "Der Google-Zugriff konnte nicht sicher vom Login getrennt werden. Bitte später erneut versuchen."}); }
  });

  // The client falls back to the popup flow while this is false, so an
  // incomplete deployment degrades instead of locking everyone out. The two
  // booleans say which half is missing: a bare `false` cannot, and the client
  // ID in particular comes from firebase-applet-config.json, which some
  // deployments ship without an `oAuthClientId` key.
  router.get("/auth/config", (_req, res) =>
    res.json({
      serverAuth: configured(),
      clientId: Boolean(clientId),
      clientSecret: Boolean(clientSecret),
    }),
  );

  router.get("/auth/google/start", (req, res) => {
    if (!configured()) {
      res.status(503).json({ error: "Server-Anmeldung ist nicht eingerichtet." });
      return;
    }
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    // Cached clients still use GET, but cannot authenticate their own start time.
    const startedAt = Date.now();
    const binding = Buffer.from(JSON.stringify({startedAt, expiresAt:startedAt + 10 * 60_000})).toString("base64url");
    const value = `${state}.${verifier}.${binding}`;
    res.cookie(STATE_COOKIE, `${value}.${bindingSignature(value)}`, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.protocol === "https",
      path: "/api/auth",
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(
      buildAuthUrl({
        clientId,
        redirectUri: redirectUri(req),
        state,
        verifier,
        loginHint:
          typeof req.query.hint === "string" ? req.query.hint : undefined,
      }),
    );
  });

  router.get("/auth/google/callback", async (req, res) => {
    const finish = (payload: Record<string, unknown>) =>
      res
        .status(payload.error ? 400 : 200)
        .clearCookie(STATE_COOKIE, { path: "/api/auth" })
        .set("Cache-Control", "no-store")
        .type("html")
        .send(
          `<!doctype html><meta charset="utf-8"><title>CheatMeet</title><body><p>Fenster kann geschlossen werden.</p><script>(function(){var m=${asJson(payload)};if(window.opener){window.opener.postMessage(Object.assign({source:"cheatmeet-oauth"},m),window.location.origin);}setTimeout(function(){window.close();},300);})();</script>`,
        );
    try {
      const cookie = readCookie(req.headers.cookie, STATE_COOKIE) || "";
      const [expected, verifier] = cookie.split(".");
      const state = typeof req.query.state === "string" ? req.query.state : "";
      if (!expected || !state || !sameSecret(expected, state))
        throw new Error("Ungültiger Anmeldevorgang. Bitte erneut versuchen.");
      const parts = cookie.split(".");
      let bound: {uid: string; googleSub: string; expiresAt: number} | undefined;
      // Unsigned pre-deployment in-flight flows must restart; accepting them
      // would let a browser invent a start after the revocation cutoff.
      if (parts.length !== 4 || !sameSecret(bindingSignature(parts.slice(0, 3).join(".")), parts[3])) throw Error("Ungültiger Anmeldevorgang.");
      const binding = JSON.parse(Buffer.from(parts[2], "base64url").toString());
      if (!Number.isFinite(binding.expiresAt) || binding.expiresAt <= Date.now()) throw Error("Anmeldevorgang abgelaufen.");
      if (binding.uid) bound = binding;
      const startedAt = binding.startedAt;
      if (!bound && (!Number.isSafeInteger(startedAt) || startedAt > Date.now() || binding.expiresAt !== startedAt + 10 * 60_000)) throw Error("Ungültiger Anmeldevorgang.");
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!code) throw new Error("Google hat die Freigabe abgebrochen.");

      // Same expression as /start: a mismatch here silently breaks the exchange.
      // Snapshot before provider I/O: revoke/reconnect during exchange fences
      // this callback too; UID + alias + binding publish in one atomic commit.
      const pendingGrant = bound ? await ownerGoogleGrantState(grantStore(), bound) : undefined;
      if (pendingGrant?.owned.revokedAt !== undefined &&
          (!Number.isSafeInteger(startedAt) || startedAt <= pendingGrant.owned.revokedAt))
        throw Error("Die Google-Verbindung wurde inzwischen geändert. Bitte erneut versuchen.");
      const tokens = await exchangeCode(
        { code, clientId, clientSecret, redirectUri: redirectUri(req), verifier },
        fetchImpl,
      );
      if (!tokens.idToken) throw new Error("Google lieferte keine Identität.");
      const googleSub = String(decodeJwt(tokens.idToken).sub || "");
      if (!googleSub) throw new Error("Google lieferte keine Identität.");
      if (bound?.googleSub && !bound.googleSub.startsWith("uid-") && bound.googleSub !== googleSub)
        throw Error("Bitte dasselbe Google-Konto wie bei der Anmeldung verwenden.");
      if (bound) {
        await saveOwnerGoogleGrant(grantStore(), bound, googleSub, tokens.refreshToken, pendingGrant);
      } else {
        // The subject is unknown before exchange. A signed start plus durable
        // cutoff rejects older flows even if the revoked token was recreated.
        const previous = await grantStore().read!(googleSub);
        if (previous.revokedAt !== undefined && startedAt <= previous.revokedAt)
          throw Error("Die Google-Verbindung wurde inzwischen geändert. Bitte erneut versuchen.");
        if (tokens.refreshToken) {
          if (!await grantStore().compare!([previous], [{...previous,refreshToken:tokens.refreshToken}]))
            throw Error("Die Google-Verbindung wurde inzwischen geändert. Bitte erneut versuchen.");
        } else if (!previous.refreshToken) {
          throw Error("Google hat keinen dauerhaften Zugriff erteilt. Bitte erneut versuchen.");
        }
      }
      finish({ idToken: tokens.idToken });
    } catch (error) {
      console.error("OAuth callback failed:", error);
      finish({
        error:
          error instanceof Error
            ? error.message
            : "Die Anmeldung ist fehlgeschlagen.",
      });
    }
  });

  router.post("/drive-token", async (req, res) => {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || "");
    if (!match) {
      res.status(401).json({ error: "Bitte erneut anmelden." });
      return;
    }
    if (!configured()) {
      res.status(503).json({ error: "Server-Anmeldung ist nicht eingerichtet." });
      return;
    }
    let identity: {uid: string; googleSub: string};
    let grant: Awaited<ReturnType<typeof ownerGoogleGrant>>;
    try {
      identity = await identify(match[1]);
    } catch {
      res.status(401).json({ error: "Bitte erneut anmelden." });
      return;
    }
    try {
      grant = await ownerGoogleGrant(grantStore(), identity);
      const refreshToken = grant?.refreshToken;
      if (!refreshToken) {
        // No stored grant: the user must consent once before Drive works.
        res.status(403).json({
          error:
            "Bitte einmalig Google Drive freigeben, damit CheatMeet dauerhaft verbunden bleibt.",
          reauth: true,
          reason: "no_grant",
        });
        return;
      }
      const tokens = await refreshAccessToken(
        { refreshToken, clientId, clientSecret },
        fetchImpl,
      );
      if ((await grantStore().read!(grant!.key)).version !== grant!.version) {
        res.status(403).json({error:"Die Google-Verbindung wurde inzwischen geändert. Bitte erneut verbinden.", reauth:true, reason:"revoked"});
        return;
      }
      res.json({
        accessToken: tokens.accessToken,
        expiresInSeconds: tokens.expiresInSeconds,
        // The client needs the real scope set, not what this request asked
        // for: they differ for everyone who granted before the calendar
        // scope was added, until they consent again.
        calendar: grantsCalendar(tokens.scope),
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "invalid_grant") {
        // A late failure has authority only over the exact attempted version.
        if (grant) await invalidateOwnerGoogleGrant(grantStore(), identity, grant).catch(() => {});
        res.status(403).json({
          error:
            "Der Google-Drive-Zugriff wurde entzogen. Bitte erneut anmelden.",
          reauth: true,
          reason: "revoked",
        });
        return;
      }
      console.error("Drive token refresh failed:", error);
      res
        .status(503)
        .json({ error: "Google Drive ist gerade nicht erreichbar." });
    }
  });

  router.post("/auth/revoke", async (req, res) => {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || "");
    if (!match) {
      res.status(401).json({ error: "Bitte erneut anmelden." });
      return;
    }
    if (!configured()) {
      res.status(503).json({ error: "Server-Anmeldung ist nicht eingerichtet." });
      return;
    }
    let identity: {uid: string; googleSub: string};
    try { identity = await authenticated(req); }
    catch { res.status(401).json({error: "Bitte erneut anmelden."}); return; }
    const warning = "CheatMeet hat die gespeicherte Google-Verbindung getrennt. Der Widerruf bei Google ist nicht bestätigt. Bereits ausgegebene Drive-/Kalender-Tokens können bis zum Ablauf gültig bleiben; laufende Uploads und Verarbeitung können unterbrochen werden. Bitte den Zugriff im Google-Konto unter „Drittanbieter-Apps“ prüfen und dort entziehen.";
    try {
      // Atomically contain exactly the still-current grant and its owned alias.
      // A competing reconnect is not deleted, nor reported as disconnected.
      const tokens = await disconnectOwnerGoogleGrant(grantStore(), identity);
      const results = await Promise.all(tokens.map(async token => {
        try {
          const response = await fetchImpl("https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token }),
            signal: AbortSignal.timeout(8_000),
          });
          // A 400 invalid_token only describes this token, not global access.
          return response.ok;
        } catch { return false; }
      }));
      const current = await ownerGoogleGrantState(grantStore(), identity);
      const localDisconnected = !current.owned.refreshToken && !(current.aliasOwned && current.legacy?.refreshToken);
      const revoked = localDisconnected && results.length > 0 && results.every(Boolean);
      const changedWarning = "Die Google-Verbindung wurde während des Widerrufs erneut geändert. Die aktuelle Verbindung ist nicht als getrennt bestätigt. Bitte den Zugriff prüfen und erneut trennen.";
      res.status(!localDisconnected ? 503 : revoked ? 200 : 502).json({revoked, localDisconnected, ...(revoked ? {} : {warning:localDisconnected ? warning : changedWarning})});
    } catch {
      res.status(503).json({revoked: false, localDisconnected: false, warning: "Der Google-Zugriff konnte nicht vollständig getrennt werden. Bitte im Google-Konto unter „Drittanbieter-Apps“ den Zugriff entziehen und anschließend erneut versuchen."});
    }
  });

  return router;
}
