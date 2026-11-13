import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { SCOPES, narrowScopes, parseScopes, type Scope } from "../../shared/mcp";
import type { McpConfig } from "./config";
import type { DocStore } from "./docStore";

/**
 * A small OAuth 2.1 authorization server for the MCP endpoint.
 *
 * Google cannot play this role (it offers neither dynamic client registration
 * nor client-ID metadata documents), so CheatMeet issues its own tokens. The
 * only login is the app's existing Google sign-in, used on the consent page.
 * The Google/Drive credential never leaves the server; the assistant only ever
 * holds a CheatMeet token that is valid for the MCP endpoint alone.
 */

const DAY = 86_400_000;
const CODE_TTL = 60_000;
const REQUEST_TTL = 10 * 60_000;
const REFRESH_TTL = 90 * DAY;
const REFRESH_GRACE = 10_000;
const MAX_GRANTS = 25;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface Grant {
  id: string;
  uid: string;
  googleSub: string;
  clientId: string;
  clientName: string;
  redirectHost: string;
  scopes: Scope[];
  status: "pending" | "active" | "revoked";
  createdAt: number;
  lastUsedAt?: number;
  /** Single use. Kept after redemption so a replay can be recognised and punished. */
  code?: { hash: string; exp: number; challenge: string; redirectUri: string; resource: string; used?: boolean };
  refresh?: { hash: string; exp: number; prevHash?: string; rotatedAt?: number };
}

export interface OAuthOptions {
  config: McpConfig;
  store: DocStore<Grant>;
  now?: () => number;
  /** The Google-backed Firebase identity behind a browser ID token. */
  identify: (token: string) => Promise<{ uid: string; googleSub: string }>;
  /** Whether the server holds Drive access for this Google account. */
  hasDriveGrant: (googleSub: string) => Promise<boolean>;
  /** Provider-aware archive access. Existing integrations may keep the Google callback. */
  hasStorageGrant?: (identity: {uid:string;googleSub:string}) => Promise<boolean>;
  limits?: { perMinute?: number };
}

// ---- redirect rules -------------------------------------------------------

export function redirectAllowed(value: string): boolean {
  if (!value || value.length > 200) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

/** Exact match; a loopback redirect may differ in port (RFC 8252) and localhost/127.0.0.1. */
export function redirectMatches(registered: readonly string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  let wanted: URL;
  try {
    wanted = new URL(candidate);
  } catch {
    return false;
  }
  if (wanted.protocol !== "http:" || !LOOPBACK.has(wanted.hostname)) return false;
  return registered.some((entry) => {
    try {
      const url = new URL(entry);
      return url.protocol === "http:" && LOOPBACK.has(url.hostname)
        && url.pathname === wanted.pathname && url.search === wanted.search;
    } catch {
      return false;
    }
  });
}

// ---- small helpers ----------------------------------------------------------

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const pkce = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const text = (value: unknown, max = 2048): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
const secretOf = () => randomBytes(32).toString("base64url");
const split = (token: string): [string, string] | null => {
  const dot = token.indexOf(".");
  return dot > 0 && dot < token.length - 1 && !token.includes(".", dot + 1)
    ? [token.slice(0, dot), token.slice(dot + 1)]
    : null;
};
/** Owner and expiry follow from the grant, so every write keeps them consistent. */
const metaFor = (now: number) => (grant: Grant) => ({
  ownerKey: grant.uid,
  expireAt: new Date(now + (grant.status === "pending" ? 15 * 60_000 : grant.status === "active" ? 120 * DAY : 30 * DAY)),
});
const revoked = (grant: Grant): Grant => ({ ...grant, status: "revoked", refresh: undefined });

// ---- signed, stateless client ids and authorization requests ------------------

type Verify = { secret: Uint8Array; issuer: string; now: () => number };
const CLIENT_TYP = "cheatmeet-client";
const REQUEST_TYP = "cheatmeet-authrequest";
const ACCESS_TYP = "at+jwt";

interface ClientInfo { name: string; redirectUris: string[] }
async function signClient(secret: Uint8Array, info: ClientInfo, now: number) {
  return new SignJWT({ name: info.name, ru: info.redirectUris })
    .setProtectedHeader({ alg: "HS256", typ: CLIENT_TYP })
    .setIssuedAt(Math.floor(now / 1000))
    .sign(secret);
}
async function readClient(id: string, secret: Uint8Array): Promise<ClientInfo | null> {
  try {
    const { payload } = await jwtVerify(id, secret, { algorithms: ["HS256"], typ: CLIENT_TYP });
    const uris = payload.ru;
    if (typeof payload.name !== "string" || !Array.isArray(uris) || !uris.every((u) => typeof u === "string")) return null;
    return { name: payload.name, redirectUris: uris as string[] };
  } catch {
    return null;
  }
}

interface AuthRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  challenge: string;
  scopes: Scope[];
  resource: string;
}
async function signRequest(ctx: Verify, request: AuthRequest) {
  const seconds = Math.floor(ctx.now() / 1000);
  return new SignJWT({
    cid: request.clientId, cn: request.clientName, ru: request.redirectUri, st: request.state,
    cc: request.challenge, sc: request.scopes, res: request.resource,
  })
    .setProtectedHeader({ alg: "HS256", typ: REQUEST_TYP })
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + REQUEST_TTL / 1000)
    .sign(ctx.secret);
}
async function readRequest(token: string, ctx: Verify): Promise<AuthRequest | null> {
  try {
    const { payload } = await jwtVerify(token, ctx.secret, {
      algorithms: ["HS256"], typ: REQUEST_TYP, currentDate: new Date(ctx.now()),
    });
    const scopes = Array.isArray(payload.sc) ? (payload.sc as string[]).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)) : [];
    if (typeof payload.cid !== "string" || typeof payload.ru !== "string" || typeof payload.cc !== "string" || !scopes.length) return null;
    return {
      clientId: payload.cid, clientName: String(payload.cn ?? ""), redirectUri: payload.ru,
      state: typeof payload.st === "string" ? payload.st : undefined, challenge: payload.cc, scopes,
      resource: String(payload.res ?? ""),
    };
  } catch {
    return null;
  }
}

// ---- access tokens ---------------------------------------------------------

async function signAccess(
  ctx: Verify & { resource: string; ttl: number },
  grant: Grant,
  scopes: Scope[],
) {
  const seconds = Math.floor(ctx.now() / 1000);
  return new SignJWT({ gid: grant.id, scope: scopes.join(" "), client_id: grant.clientId })
    .setProtectedHeader({ alg: "HS256", typ: ACCESS_TYP })
    .setSubject(grant.uid)
    .setIssuer(ctx.issuer)
    .setAudience(ctx.resource)
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + ctx.ttl)
    .sign(ctx.secret);
}

/**
 * Verifies an access token for the MCP endpoint. Reads the grant every time
 * (no cache), so revoking access takes effect on the very next request.
 */
export async function verifyAccessToken(
  token: string,
  deps: { config: McpConfig; store: DocStore<Grant>; now?: () => number },
): Promise<AuthInfo> {
  const now = deps.now ?? Date.now;
  const invalid = (message: string) => new OAuthError(OAuthErrorCode.InvalidToken, message);
  let payload;
  try {
    ({ payload } = await jwtVerify(token, deps.config.secret, {
      algorithms: ["HS256"], typ: ACCESS_TYP, issuer: deps.config.issuer, audience: deps.config.resource,
      currentDate: new Date(now()),
    }));
  } catch {
    throw invalid("Ungültiges Token.");
  }
  const grant = typeof payload.gid === "string" ? await deps.store.get(payload.gid) : null;
  if (!grant || grant.status !== "active" || grant.uid !== payload.sub) throw invalid("Zugriff wurde entzogen.");
  const scopes = narrowScopes(grant.scopes, parseScopes(String(payload.scope ?? "")));
  if (!grant.lastUsedAt || now() - grant.lastUsedAt > 5 * 60_000) {
    // Best effort and off the request path: it only feeds the "last used" column.
    void deps.store.mutate(grant.id, (cur) => (cur && cur.status === "active" ? { ...cur, lastUsedAt: now() } : undefined), metaFor(now())).catch(() => {});
  }
  return {
    token,
    clientId: String(payload.client_id ?? grant.clientId),
    scopes,
    expiresAt: payload.exp,
    resource: new URL(deps.config.resource),
    extra: { uid: grant.uid, googleSub: grant.googleSub, grantId: grant.id },
  };
}

// ---- the router -------------------------------------------------------------

export function createOAuthRouter(options: OAuthOptions): Router {
  const { config, store } = options;
  const now = options.now ?? Date.now;
  const router = express.Router();
  const ctx: Verify = { secret: config.secret, issuer: config.issuer, now };
  const accessCtx = { ...ctx, resource: config.resource, ttl: config.accessTtlSeconds };
  const parsers = [express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" })];
  const perMinute = options.limits?.perMinute ?? 60;

  // Per-address limiter for the unauthenticated endpoints. In memory on purpose:
  // it only needs to blunt a single noisy client, not be exact across instances.
  const windows = new Map<string, { start: number; count: number }>();
  const limited = (req: Request, res: Response, next: NextFunction) => {
    const at = now();
    const key = String(req.ip || req.socket.remoteAddress || "unknown");
    let entry = windows.get(key);
    if (!entry || at - entry.start >= 60_000) {
      entry = { start: at, count: 0 };
      windows.set(key, entry);
      if (windows.size > 10_000) for (const [k, v] of windows) if (at - v.start >= 60_000) windows.delete(k);
    }
    if (++entry.count > perMinute) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.start + 60_000 - at) / 1000))));
      res.status(429).json({ error: "temporarily_unavailable", error_description: "Zu viele Anfragen." });
      return;
    }
    next();
  };

  const cors = (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type, Authorization, MCP-Protocol-Version");
      res.setHeader("Access-Control-Max-Age", "600");
      res.sendStatus(204);
      return;
    }
    next();
  };
  for (const path of ["/.well-known", "/api/oauth/register", "/api/oauth/token", "/api/oauth/revoke"]) router.use(path, cors);

  const oauthError = (res: Response, error: string, description?: string, status = 400) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
  };
  const bearer = async (req: Request) => {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || "");
    if (!match) return null;
    try {
      return await options.identify(match[1]);
    } catch {
      return null;
    }
  };

  // The consent page is the one place a click grants access, so it must never
  // load inside someone else's frame. Set here, then handed on to the app.
  router.get("/connect", (_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // ---- discovery
  const metadata = (body: unknown) => (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(body);
  };
  router.get("/.well-known/oauth-authorization-server", metadata({
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/api/oauth/authorize`,
    token_endpoint: `${config.issuer}/api/oauth/token`,
    registration_endpoint: `${config.issuer}/api/oauth/register`,
    revocation_endpoint: `${config.issuer}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
  }));
  const resourceMetadata = {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "CheatMeet",
  };
  router.get(["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource"], metadata(resourceMetadata));

  // ---- dynamic client registration (stateless: the client id carries its own data)
  router.post("/api/oauth/register", limited, ...parsers, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every((u) => typeof u === "string"))
      return oauthError(res, "invalid_client_metadata", "redirect_uris muss 1 bis 5 Einträge enthalten.");
    if (!(uris as string[]).every(redirectAllowed))
      return oauthError(res, "invalid_redirect_uri", "Nur https oder Loopback-Adressen sind erlaubt.");
    const name = body.client_name === undefined ? "Unbenannter Assistent" : clean(String(body.client_name));
    if (!name || name.length > 100 || typeof body.client_name === "object")
      return oauthError(res, "invalid_client_metadata", "client_name fehlt oder ist zu lang.");
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none")
      return oauthError(res, "invalid_client_metadata", "Nur öffentliche Clients (none) werden unterstützt.");
    const redirectUris = uris as string[];
    const clientId = await signClient(config.secret, { name, redirectUris }, now());
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ---- authorization request -> consent page
  router.get("/api/oauth/authorize", limited, async (req: Request, res: Response) => {
    const q = req.query;
    const client = text(q.client_id, 4096) ? await readClient(String(q.client_id), config.secret) : null;
    const redirectUri = text(q.redirect_uri, 400);
    // Until the client and its redirect are known, never redirect: an error
    // page here cannot be turned into an open redirect.
    if (!client || !redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
      res.status(400).type("text/plain").send("Ungültige Anfrage: Client oder Redirect-URI unbekannt.");
      return;
    }
    const state = text(q.state, 512);
    const fail = (error: string, description: string) => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      if (state) target.searchParams.set("state", state);
      target.searchParams.set("iss", config.issuer);
      res.redirect(302, target.toString());
    };
    if (q.response_type !== "code") return fail("unsupported_response_type", "Nur response_type=code wird unterstützt.");
    const challenge = text(q.code_challenge, 128);
    if (!challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || q.code_challenge_method !== "S256")
      return fail("invalid_request", "PKCE mit S256 ist erforderlich.");
    const resource = text(q.resource, 2048);
    if (resource && resource !== config.resource) return fail("invalid_target", "Unbekannte Ressource.");
    const request = await signRequest(ctx, {
      clientId: String(q.client_id), clientName: client.name, redirectUri, state, challenge,
      scopes: parseScopes(text(q.scope, 512)), resource: config.resource,
    });
    res.redirect(302, `${config.issuer}/connect?request=${encodeURIComponent(request)}`);
  });

  // What the consent page shows; everything in it is re-verified on the decision.
  router.get("/api/oauth/request-info", limited, async (req: Request, res: Response) => {
    const request = await readRequest(String(req.query.request ?? ""), ctx);
    if (!request) return oauthError(res, "invalid_request", "Die Anfrage ist abgelaufen oder ungültig.");
    res.setHeader("Cache-Control", "no-store");
    res.json({ clientName: request.clientName, redirectHost: new URL(request.redirectUri).host, scopes: request.scopes });
  });

  // ---- the user's decision, authenticated with their Firebase (Google) identity
  router.post("/api/oauth/decision", limited, ...parsers, async (req: Request, res: Response) => {
    const identity = await bearer(req);
    if (!identity) return oauthError(res, "unauthorized", "Bitte erneut anmelden.", 401);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const request = await readRequest(String(body.request ?? ""), ctx);
    if (!request) return oauthError(res, "invalid_request", "Die Anfrage ist abgelaufen oder ungültig.");
    const back = (params: Record<string, string>) => {
      const target = new URL(request.redirectUri);
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
      if (request.state) target.searchParams.set("state", request.state);
      target.searchParams.set("iss", config.issuer);
      return target.toString();
    };
    res.setHeader("Cache-Control", "no-store");
    if (body.approve !== true) {
      res.json({ redirectTo: back({ error: "access_denied", error_description: "Der Nutzer hat den Zugriff abgelehnt." }) });
      return;
    }
    const hasArchive=options.hasStorageGrant?await options.hasStorageGrant(identity):await options.hasDriveGrant(identity.googleSub);
    if (!hasArchive)
      return oauthError(res, identity.googleSub?'no_drive_grant':'no_storage_grant', identity.googleSub?'Bitte zuerst Google Drive in CheatMeet verbinden.':'Bitte zuerst OneDrive in CheatMeet verbinden.', 409);
    let scopes = request.scopes;
    if (body.scopes !== undefined) {
      const asked = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
      scopes = request.scopes.filter((scope) => asked.includes(scope));
      if (!scopes.length) return oauthError(res, "invalid_request", "Mindestens ein Zugriffsbereich muss erlaubt sein.");
    }
    const existing = (await store.listByOwner(identity.uid)).filter((grant) => grant.status !== "revoked");
    if (existing.length >= MAX_GRANTS)
      return oauthError(res, "too_many_grants", "Zu viele verbundene Assistenten. Bitte einen entziehen.", 429);
    const id = randomBytes(12).toString("base64url");
    const code = secretOf();
    const at = now();
    const grant: Grant = {
      id, uid: identity.uid, googleSub: identity.googleSub,
      clientId: request.clientId, clientName: request.clientName,
      redirectHost: new URL(request.redirectUri).host, scopes, status: "pending", createdAt: at,
      code: { hash: sha(code), exp: at + CODE_TTL, challenge: request.challenge, redirectUri: request.redirectUri, resource: request.resource },
    };
    await store.mutate(id, () => grant, metaFor(at));
    res.json({ redirectTo: back({ code: `${id}.${code}` }) });
  });

  // ---- token endpoint
  router.post("/api/oauth/token", limited, ...parsers, async (req: Request, res: Response) => {
    const p = (req.body ?? {}) as Record<string, unknown>;
    const grantType = text(p.grant_type, 64);
    if (grantType !== "authorization_code" && grantType !== "refresh_token")
      return oauthError(res, "unsupported_grant_type", "Nur authorization_code und refresh_token werden unterstützt.");
    const clientId = text(p.client_id, 4096);
    if (!clientId || !(await readClient(clientId, config.secret)))
      return oauthError(res, "invalid_client", "Unbekannter Client.");
    const resource = text(p.resource, 2048);
    if (resource && resource !== config.resource) return oauthError(res, "invalid_target", "Unbekannte Ressource.");
    const at = now();
    const denied = () => oauthError(res, "invalid_grant", "Der Code oder das Token ist ungültig oder abgelaufen.");
    const respond = async (grant: Grant, scopes: Scope[], refreshSecret: string) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.json({
        access_token: await signAccess(accessCtx, grant, scopes),
        token_type: "Bearer",
        expires_in: config.accessTtlSeconds,
        refresh_token: `${grant.id}.${refreshSecret}`,
        scope: scopes.join(" "),
      });
    };

    if (grantType === "authorization_code") {
      const parts = split(text(p.code, 512) ?? "");
      const verifier = text(p.code_verifier, 200);
      const redirectUri = text(p.redirect_uri, 400);
      if (!parts || !verifier || !redirectUri) return denied();
      const [id, secret] = parts;
      const refreshSecret = secretOf();
      const result = { ok: false };
      const stored = await store.mutate(id, (cur) => {
        result.ok = false;
        if (!cur || cur.status === "revoked" || !cur.code || !same(sha(secret), cur.code.hash)) return undefined;
        // A code that already produced tokens is being replayed: whoever holds
        // those tokens is now suspect, so the whole grant goes.
        if (cur.status === "active" || cur.code.used) return revoked(cur);
        if (cur.code.exp <= at || cur.clientId !== clientId || cur.code.redirectUri !== redirectUri) return undefined;
        if (!same(pkce(verifier), cur.code.challenge)) return undefined;
        result.ok = true;
        return { ...cur, status: "active", code: { ...cur.code, used: true }, refresh: { hash: sha(refreshSecret), exp: at + REFRESH_TTL }, lastUsedAt: at };
      }, metaFor(at)).catch(() => null);
      if (!result.ok || !stored) return denied();
      return respond(stored, stored.scopes, refreshSecret);
    }

    const parts = split(text(p.refresh_token, 512) ?? "");
    if (!parts) return denied();
    const [id, secret] = parts;
    const nextSecret = secretOf();
    let scopes: Scope[] = [];
    const result = { ok: false };
    const stored = await store.mutate(id, (cur) => {
      result.ok = false;
      if (!cur || cur.status !== "active" || !cur.refresh || cur.clientId !== clientId) return undefined;
      const presented = sha(secret);
      if (same(presented, cur.refresh.hash)) {
        if (cur.refresh.exp <= at) return undefined;
        const asked = narrowScopes(cur.scopes, parseScopes(text(p.scope, 512)));
        scopes = p.scope === undefined || !asked.length ? cur.scopes : asked;
        result.ok = true;
        return { ...cur, lastUsedAt: at, refresh: { hash: sha(nextSecret), exp: at + REFRESH_TTL, prevHash: cur.refresh.hash, rotatedAt: at } };
      }
      if (cur.refresh.prevHash && same(presented, cur.refresh.prevHash)) {
        // Two refreshes racing each other is normal; a stale token turning up
        // later means a copy exists somewhere it should not.
        return at - (cur.refresh.rotatedAt ?? 0) <= REFRESH_GRACE ? undefined : revoked(cur);
      }
      return undefined;
    }, metaFor(at)).catch(() => null);
    if (!result.ok || !stored) return denied();
    return respond(stored, scopes, nextSecret);
  });

  // ---- revocation: RFC 7009 (always 200) and the settings page
  router.post("/api/oauth/revoke", limited, ...parsers, async (req: Request, res: Response) => {
    const p = (req.body ?? {}) as Record<string, unknown>;
    const token = text(p.token, 4096) ?? "";
    const clientId = text(p.client_id, 4096);
    let grantId: string | undefined;
    const refresh = split(token);
    if (refresh) grantId = refresh[0];
    else {
      try {
        const { payload } = await jwtVerify(token, config.secret, { algorithms: ["HS256"], typ: ACCESS_TYP, audience: config.resource, issuer: config.issuer, currentDate: new Date(now()) });
        grantId = typeof payload.gid === "string" ? payload.gid : undefined;
      } catch { /* unknown token: nothing to revoke */ }
    }
    if (grantId && clientId) {
      await store.mutate(grantId, (cur) => {
        if (!cur || cur.status === "revoked" || cur.clientId !== clientId) return undefined;
        if (refresh) {
          const presented = sha(refresh[1]);
          const known = (cur.refresh && (same(presented, cur.refresh.hash) || (cur.refresh.prevHash && same(presented, cur.refresh.prevHash)))) || false;
          if (!known) return undefined;
        }
        return revoked(cur);
      }, metaFor(now())).catch(() => {});
    }
    res.status(200).json({});
  });

  router.get("/api/mcp/grants", async (req: Request, res: Response) => {
    const identity = await bearer(req);
    if (!identity) return oauthError(res, "unauthorized", "Bitte erneut anmelden.", 401);
    const grants = (await store.listByOwner(identity.uid))
      .filter((grant) => grant.status === "active")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((grant) => ({
        id: grant.id, clientName: grant.clientName, redirectHost: grant.redirectHost, scopes: grant.scopes,
        createdAt: grant.createdAt, lastUsedAt: grant.lastUsedAt ?? null,
      }));
    res.setHeader("Cache-Control", "no-store");
    res.json({ grants });
  });
  router.delete("/api/mcp/grants/:id", async (req: Request, res: Response) => {
    const identity = await bearer(req);
    if (!identity) return oauthError(res, "unauthorized", "Bitte erneut anmelden.", 401);
    let found = false;
    await store.mutate(String(req.params.id), (cur) => {
      found = Boolean(cur && cur.uid === identity.uid && cur.status !== "revoked");
      return found ? revoked(cur!) : undefined;
    }, metaFor(now()));
    if (!found) return oauthError(res, "not_found", "Diese Verbindung gibt es nicht.", 404);
    res.json({ revoked: true });
  });

  // Malformed bodies on these routes answer in OAuth's own shape.
  router.use((error: { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (error && typeof error.status === "number" && error.status >= 400 && error.status < 500)
      return oauthError(res, "invalid_request", "Die Anfrage konnte nicht gelesen werden.");
    next(error);
  });
  return router;
}
