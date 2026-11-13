import express from "express";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { ConfidentialClientApplication, type AuthorizationUrlRequest, type AuthorizationCodeRequest, type SilentFlowRequest, type AccountInfo } from "@azure/msal-node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import firebaseConfig from "../firebase-applet-config.json";
import { fileDocStore, firestoreDocStore, type DocStore } from "./mcp/docStore";
import { serviceAccountToken } from "./tokenStore";

const FILES = "https://graph.microsoft.com/Files.ReadWrite";
const CALENDAR = "https://graph.microsoft.com/Calendars.ReadWrite";
const COOKIE = "cheatmeet_microsoft_state";
const CALLBACK = "/api/auth/microsoft/callback";
const STATE_LIFETIME = 10 * 60_000;
const GRANT_LIFETIME = 365 * 24 * 3600_000;
const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"), { timeoutDuration: 10_000 });

/** Firebase is the existing identity platform, independent of the linked storage provider. */
export async function firebaseAccountFor(token: string, projectId = process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId): Promise<{ uid: string; googleSub: string }> {
  const { payload } = await jwtVerify(token, keys, { algorithms: ["RS256"], audience: projectId, issuer: `https://securetoken.google.com/${projectId}`, requiredClaims: ["sub", "iat", "exp", "auth_time"] });
  const now = Date.now() / 1000;
  if (!payload.sub || payload.sub.length > 128 || typeof payload.iat !== "number" || payload.iat > now || typeof payload.auth_time !== "number" || payload.auth_time < 0 || payload.auth_time > now)
    throw new Error("Ungültige Anmeldung.");
  const identities = (payload.firebase as { identities?: Record<string, unknown> } | undefined)?.identities;
  const google = identities?.["google.com"];
  return { uid: payload.sub, googleSub: Array.isArray(google) && typeof google[0] === "string" ? google[0] : "" };
}

interface MicrosoftResult {
  account: AccountInfo | null;
  accessToken: string;
  expiresOn: Date | null;
  scopes: string[];
  idTokenClaims?: object;
}
/** Deliberately small adapter: real MSAL in production, deterministic provider in unit tests. */
export interface MicrosoftClient {
  getAuthCodeUrl(request: AuthorizationUrlRequest): Promise<string>;
  acquireTokenByCode(request: AuthorizationCodeRequest): Promise<MicrosoftResult | null>;
  acquireTokenSilent(request: SilentFlowRequest): Promise<MicrosoftResult | null>;
  getTokenCache(): { serialize(): string; getAccountByHomeId(id: string): Promise<AccountInfo | null> };
}
export interface MicrosoftConnection { connectionId: string; accountName: string; calendar: boolean }
interface Grant extends MicrosoftConnection { homeAccountId: string; cache: string; revision: string }
interface OwnerDocument { kind: "owner"; owner: string; grants: Grant[] }
interface StateDocument { kind: "state"; owner: string; nonce: string; verifier: string; browserHash: string; calendar: boolean; expiresAt: number; claim?: string }
export type MicrosoftAuthDocument = OwnerDocument | StateDocument;
export interface MicrosoftAuthOptions {
  store?: DocStore<MicrosoftAuthDocument>;
  clientId?: string;
  clientSecret?: string;
  authority?: string;
  publicUrl?: string;
  projectId?: string;
  identify?: (token: string) => Promise<{ uid: string; googleSub: string }>;
  createClient?: (cache?: string) => MicrosoftClient;
  fetchImpl?: typeof fetch;
}
class AuthError extends Error { constructor(public status: number, message: string) { super(message); } }
const denied = () => new AuthError(403, "Bitte den Microsoft-Zugriff erneut freigeben.");
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const secret = () => randomBytes(32).toString("base64url");
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const ownerId = (owner: string) => `owner-${digest(owner)}`;
const stateId = (state: string) => `state-${digest(state)}`;
const scopes = (calendar: boolean) => ["openid", "profile", "offline_access", FILES, ...(calendar ? [CALENDAR] : [])];
const metadata = (owner: string, lifetime = GRANT_LIFETIME) => ({ ownerKey: owner, expireAt: new Date(Date.now() + lifetime) });
const safeConnection = (grant: Grant): MicrosoftConnection => ({ connectionId: grant.connectionId, accountName: grant.accountName, calendar: grant.calendar });
function originFor(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return "";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && process.env.NODE_ENV !== "production")) return "";
    return url.origin;
  } catch { return ""; }
}
function configuration(options: MicrosoftAuthOptions = {}) {
  const clientId = options.clientId ?? process.env.MICROSOFT_CLIENT_ID ?? "";
  const clientSecret = options.clientSecret ?? process.env.MICROSOFT_CLIENT_SECRET ?? "";
  const origin = originFor(options.publicUrl ?? process.env.MICROSOFT_PUBLIC_URL ?? "");
  const authority = options.authority ?? process.env.MICROSOFT_AUTHORITY ?? "https://login.microsoftonline.com/common";
  let validAuthority = false;
  try { const u = new URL(authority); validAuthority = u.origin === "https://login.microsoftonline.com" && /^\/[a-zA-Z0-9.-]+\/?$/.test(u.pathname) && !u.search && !u.hash && !u.username && !u.password; } catch { /* unconfigured */ }
  return { clientId, clientSecret, origin, authority, configured: Boolean(clientId && clientSecret && origin && validAuthority) };
}
export function microsoftConfigured(): boolean { return configuration().configured; }

function defaultStore(options: MicrosoftAuthOptions): DocStore<MicrosoftAuthDocument> {
  if (process.env.NODE_ENV !== "production") return fileDocStore(path.resolve(".microsoft-grants"));
  const fetchImpl = options.fetchImpl || fetch;
  return firestoreDocStore({ collection: "microsoftGrants", projectId: options.projectId || process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId, databaseId: (firebaseConfig as { firestoreDatabaseId?: string }).firestoreDatabaseId || "(default)", fetchImpl, token: () => serviceAccountToken(fetchImpl) });
}

export function createMicrosoftAuthService(options: MicrosoftAuthOptions = {}) {
  const config = configuration(options);
  let store = options.store;
  const docs = () => (store ||= defaultStore(options));
  const requireConfigured = () => { if (!config.configured) throw new AuthError(503, "Microsoft ist noch nicht eingerichtet."); };
  const fetchImpl = options.fetchImpl || fetch;
  const client = options.createClient || ((cache?: string): MicrosoftClient => {
    const network = async <T>(url: string, method: string, opts?: { headers?: Record<string, string>; body?: string }) => {
      // MSAL metadata discovery and token exchange share the same bounded, non-logging transport.
      const response = await fetchImpl(url, { method, headers: opts?.headers, body: opts?.body, signal: AbortSignal.timeout(15_000), redirect: "error" });
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.json() as T };
    };
    const app = new ConfidentialClientApplication({ auth: { clientId: config.clientId, clientSecret: config.clientSecret, authority: config.authority }, system: { networkClient: { sendGetRequestAsync: (url, opts) => network(url, "GET", opts), sendPostRequestAsync: (url, opts) => network(url, "POST", opts) }, loggerOptions: { loggerCallback: () => {}, piiLoggingEnabled: false } } });
    if (cache) app.getTokenCache().deserialize(cache);
    return app;
  });
  async function readOwner(owner: string): Promise<OwnerDocument | null> {
    if (!owner) throw denied();
    const doc = await docs().get(ownerId(owner));
    return doc?.kind === "owner" && doc.owner === owner ? doc : null;
  }
  async function list(owner: string): Promise<MicrosoftConnection[]> {
    return ((await readOwner(owner))?.grants || []).map(safeConnection);
  }
  async function begin(owner: string, calendar: boolean) {
    requireConfigured();
    if (!owner) throw denied();
    const state = secret(), browser = secret(), nonce = secret(), verifier = secret();
    const value: StateDocument = { kind: "state", owner, nonce, verifier, browserHash: digest(browser), calendar, expiresAt: Date.now() + STATE_LIFETIME };
    const url = await client().getAuthCodeUrl({ scopes: scopes(calendar), redirectUri: config.origin + CALLBACK, state, nonce, codeChallenge: digest(verifier), codeChallengeMethod: "S256", prompt: "select_account" });
    await docs().mutate(stateId(state), current => current ? undefined : value, metadata(owner, STATE_LIFETIME));
    return { url, browser };
  }
  async function complete(state: string, browser: string, code: string) {
    requireConfigured();
    if (!/^[\w-]{43}$/.test(state) || !browser) throw denied();
    const claim = randomUUID();
    const pending = await docs().mutate(stateId(state), current => {
      if (current?.kind !== "state" || current.claim || current.expiresAt <= Date.now() || !safeEqual(current.browserHash, digest(browser))) return undefined;
      return { ...current, claim };
    }, value => metadata(value.owner, STATE_LIFETIME));
    if (pending?.kind !== "state" || pending.claim !== claim || !code) throw denied();
    const app = client();
    const result = await app.acquireTokenByCode({ code, scopes: scopes(pending.calendar), redirectUri: config.origin + CALLBACK, codeVerifier: pending.verifier, nonce: pending.nonce });
    if (!result?.account?.homeAccountId || !safeEqual(String((result.idTokenClaims as { nonce?: string } | undefined)?.nonce || ""), pending.nonce)) throw denied();
    const granted = result.scopes.map(s => s.toLowerCase());
    if (!granted.some(s => s === "files.readwrite" || s === FILES.toLowerCase())) throw denied();
    const calendar = pending.calendar && granted.some(s => s === "calendars.readwrite" || s === CALENDAR.toLowerCase());
    // Stable opaque identity keeps report homes usable after an explicit reconnect.
    // Fresh revision still prevents an old in-flight refresh from restoring a disconnected cache.
    const connectionId = digest(JSON.stringify([pending.owner, result.account.homeAccountId]));
    const grant: Grant = { connectionId, homeAccountId: result.account.homeAccountId, accountName: result.account.username || "Microsoft-Konto", calendar, cache: app.getTokenCache().serialize(), revision: randomUUID() };
    await docs().mutate(ownerId(pending.owner), current => {
      if (current && (current.kind !== "owner" || current.owner !== pending.owner)) throw denied();
      return { kind: "owner", owner: pending.owner, grants: [...(current?.kind === "owner" ? current.grants.filter(g => g.connectionId !== connectionId) : []), grant] };
    }, metadata(pending.owner));
  }
  async function getAccess(owner: string, connectionId?: string, attempt = 0): Promise<{ accessToken: string; expiresInSeconds: number; connectionId: string; accountName: string; calendar: boolean }> {
    requireConfigured();
    const grants = (await readOwner(owner))?.grants || [];
    // Never silently switch a pinned home. Multiple accounts require explicit selection.
    const grant = connectionId ? grants.find(g => g.connectionId === connectionId) : grants.length === 1 ? grants[0] : undefined;
    if (!grant) throw denied();
    const app = client(grant.cache);
    const account = await app.getTokenCache().getAccountByHomeId(grant.homeAccountId);
    if (!account) throw denied();
    let result: MicrosoftResult | null;
    try {
      result = await app.acquireTokenSilent({ account, scopes: [FILES, ...(grant.calendar ? [CALENDAR] : [])] });
    } catch (error) {
      const code = (error as { errorCode?: string } | null)?.errorCode;
      if (code && ["invalid_grant", "interaction_required", "consent_required", "login_required", "no_tokens_found", "refresh_token_expired"].includes(code)) throw denied();
      throw error;
    }
    if (!result?.accessToken || result.account?.homeAccountId !== grant.homeAccountId || !result.expiresOn || result.expiresOn.getTime() <= Date.now()) throw denied();
    const returnedScopes = result.scopes.map(s => s.toLowerCase());
    if (!returnedScopes.some(s => s === "files.readwrite" || s === FILES.toLowerCase()) || (grant.calendar && !returnedScopes.some(s => s === "calendars.readwrite" || s === CALENDAR.toLowerCase()))) throw denied();
    const revision = randomUUID();
    const nextCache = app.getTokenCache().serialize();
    const saved = await docs().mutate(ownerId(owner), current => {
      if (current?.kind !== "owner" || current.owner !== owner || !current.grants.some(g => g.connectionId === grant.connectionId && g.revision === grant.revision)) return undefined;
      return { ...current, grants: current.grants.map(g => g.connectionId === grant.connectionId ? { ...g, cache: nextCache, revision } : g) };
    }, metadata(owner));
    if (saved?.kind !== "owner" || !saved.grants.some(g => g.connectionId === grant.connectionId && g.revision === revision)) {
      if (saved?.kind !== "owner" || !saved.grants.some(g => g.connectionId === grant.connectionId)) throw denied();
      if (attempt < 2) return getAccess(owner, grant.connectionId, attempt + 1);
      throw new AuthError(503, "Microsoft-Zugriff wird gerade aktualisiert. Bitte erneut versuchen.");
    }
    return { accessToken: result.accessToken, expiresInSeconds: Math.max(1, Math.floor((result.expiresOn.getTime() - Date.now()) / 1000)), ...safeConnection(grant) };
  }
  async function disconnect(owner: string, connectionId: string) {
    if (!owner || !connectionId) throw denied();
    await docs().mutate(ownerId(owner), current => {
      if (current?.kind !== "owner" || current.owner !== owner) return undefined;
      return { ...current, grants: current.grants.filter(g => g.connectionId !== connectionId) };
    }, metadata(owner));
  }
  return { configured: config.configured, origin: config.origin, begin, complete, list, getAccess, disconnect };
}
let sharedService: ReturnType<typeof createMicrosoftAuthService> | undefined;
const defaultService = () => (sharedService ||= createMicrosoftAuthService());
export const getMicrosoftAccess = (owner: string, connectionId?: string): Promise<{ accessToken: string; expiresInSeconds: number; connectionId: string; accountName: string; calendar: boolean }> => defaultService().getAccess(owner, connectionId);
export const listMicrosoftConnections = (owner: string): Promise<MicrosoftConnection[]> => defaultService().list(owner);

export function createMicrosoftAuthRouter(options: MicrosoftAuthOptions = {}): express.Router {
  const router = express.Router();
  const json = express.json({limit:'4kb'});
  const service = Object.keys(options).length ? createMicrosoftAuthService(options) : defaultService();
  const identify = options.identify || ((token: string) => firebaseAccountFor(token, options.projectId));
  router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); next(); });
  const authenticated = (run: (owner: string, req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler => async (req, res) => {
    let owner: string;
    try {
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || "")?.[1];
      if (!token) throw denied();
      owner = (await identify(token)).uid;
      if (!owner) throw denied();
    } catch { res.status(401).json({ error: "Bitte erneut anmelden." }); return; }
    try {
      if (req.method === "POST" && req.headers.origin && req.headers.origin !== service.origin) throw new AuthError(403, "Ungültiger Anfrageursprung.");
      await run(owner, req, res);
    } catch (error) {
      const known = error instanceof AuthError;
      res.status(known ? error.status : 503).json({ error: known ? error.message : "Microsoft ist gerade nicht erreichbar. Bitte erneut versuchen." });
    }
  };
  router.get("/microsoft/config", (_req, res) => res.json({ configured: service.configured }));
  router.get("/microsoft/connections", authenticated(async (owner, _req, res) => res.json({ connections: await service.list(owner) })));
  router.post("/microsoft/connect", json, authenticated(async (owner, req, res) => {
    if (req.body?.calendar !== undefined && typeof req.body.calendar !== "boolean") throw new AuthError(400, "Ungültige Kalenderfreigabe.");
    const start = await service.begin(owner, req.body?.calendar === true);
    res.cookie(COOKIE, start.browser, { httpOnly: true, secure: service.origin.startsWith("https:"), sameSite: "lax", path: CALLBACK, maxAge: STATE_LIFETIME });
    res.json({ url: start.url });
  }));
  router.get("/auth/microsoft/callback", async (req, res) => {
    let connected = false;
    try {
      const cookie = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) || "";
      await service.complete(typeof req.query.state === "string" ? req.query.state : "", decodeURIComponent(cookie), typeof req.query.code === "string" ? req.query.code : "");
      connected = true;
    } catch { /* No raw OAuth errors, credentials or account information in the popup. */ }
    const scriptNonce = secret();
    const payload = JSON.stringify({ source: "cheatmeet-microsoft-oauth", ...(connected ? { connected: true } : { error: "Microsoft-Verbindung fehlgeschlagen. Bitte erneut versuchen." }) });
    res.clearCookie(COOKIE, { httpOnly: true, secure: service.origin.startsWith("https:"), sameSite: "lax", path: CALLBACK });
    res.status(connected ? 200 : 400).set("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${scriptNonce}'; frame-ancestors 'none'; base-uri 'none'`).type("html").send(`<!doctype html><meta charset="utf-8"><title>CheatMeet</title><p>Dieses Fenster kann geschlossen werden.</p><script nonce="${scriptNonce}">if(window.opener)window.opener.postMessage(${payload},${JSON.stringify(service.origin)});window.close();</script>`);
  });
  router.post("/microsoft/token", json, authenticated(async (owner, req, res) => {
    if (req.body?.connectionId !== undefined && (typeof req.body.connectionId !== "string" || !req.body.connectionId || req.body.connectionId.length > 200)) throw new AuthError(400, "Ungültige Verbindung.");
    res.json(await service.getAccess(owner, req.body?.connectionId));
  }));
  router.post("/microsoft/disconnect", json, authenticated(async (owner, req, res) => {
    if (typeof req.body?.connectionId !== "string" || !req.body.connectionId || req.body.connectionId.length > 200) throw new AuthError(400, "Ungültige Verbindung.");
    await service.disconnect(owner, req.body.connectionId);
    res.json({ disconnected: true });
  }));
  return router;
}
