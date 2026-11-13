import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mcpConfig } from "../server/mcp/config";
import { memoryDocStore } from "../server/mcp/docStore";
import {
  createOAuthRouter,
  redirectAllowed,
  redirectMatches,
  verifyAccessToken,
  type Grant,
} from "../server/mcp/oauth";

const ISSUER = "https://cheatmeet.example.com";
const RESOURCE = `${ISSUER}/api/mcp`;
const config = mcpConfig({ MCP_PUBLIC_URL: ISSUER, MCP_TOKEN_SECRET: "s".repeat(48) })!;

let server: Server;
let base: string;
let clock: number;
let store: ReturnType<typeof memoryDocStore<Grant>>;
let driveGrants: Set<string>;

const IDENTITIES: Record<string, { uid: string; googleSub: string }> = {
  "alice-token": { uid: "alice", googleSub: "g-alice" },
  "bob-token": { uid: "bob", googleSub: "g-bob" },
  "nogoogle-token": { uid: "carol", googleSub: "g-carol" },
  "microsoft-token": { uid: "microsoft-owner", googleSub: "" },
};

beforeEach(async () => {
  clock = Date.UTC(2030, 0, 1, 12, 0, 0);
  store = memoryDocStore<Grant>();
  driveGrants = new Set(["g-alice", "g-bob"]);
  const app = express();
  app.use(createOAuthRouter({
    config,
    store,
    now: () => clock,
    identify: async (token) => {
      const found = IDENTITIES[token];
      if (!found) throw new Error("bad token");
      return found;
    },
    hasDriveGrant: async (sub) => driveGrants.has(sub),
    hasStorageGrant: async ({uid,googleSub}) => uid === 'microsoft-owner' || driveGrants.has(googleSub),
    limits: { perMinute: 1000 },
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});
const S256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

async function register(overrides: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/api/oauth/register`, json({
    client_name: "Test Assistant",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: "none",
    ...overrides,
  }));
  return { response, body: await response.json() as any };
}
interface Flow { clientId: string; verifier: string; challenge: string; redirect: string; }
async function startFlow(overrides: { redirect?: string; scope?: string; resource?: string | null; name?: string } = {}) {
  const redirect = overrides.redirect ?? "https://claude.ai/api/mcp/auth_callback";
  const { body } = await register({ redirect_uris: [redirect], ...(overrides.name ? { client_name: overrides.name } : {}) });
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code", client_id: body.client_id, redirect_uri: redirect, state: "st-1",
    code_challenge: S256(verifier), code_challenge_method: "S256",
    ...(overrides.scope !== undefined ? { scope: overrides.scope } : {}),
    ...(overrides.resource === null ? {} : { resource: overrides.resource ?? RESOURCE }),
  });
  const response = await fetch(`${base}/api/oauth/authorize?${query}`, { redirect: "manual" });
  return { flow: { clientId: body.client_id, verifier, challenge: S256(verifier), redirect } as Flow, response };
}
const requestOf = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("request")!;
async function approve(request: string, token = "alice-token", extra: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/api/oauth/decision`, {
    ...json({ request, approve: true, ...extra }),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  return { response, body: await response.json() as any };
}
async function authorizeAll(scope?: string, token = "alice-token") {
  const { flow, response } = await startFlow({ scope });
  const decided = await approve(requestOf(response), token);
  const url = new URL(decided.body.redirectTo);
  return { flow, code: url.searchParams.get("code")!, url };
}
it('authorizes a Microsoft-only account through its own connected archive, without a Google grant',async()=>{
  const {response}=await startFlow({scope:'meetings:read'});
  const approved=await approve(requestOf(response),'microsoft-token');
  expect(approved.response.status).toBe(200);
  expect(new URL(approved.body.redirectTo).searchParams.get('code')).toBeTruthy();
  expect((await store.listByOwner('microsoft-owner'))[0]).toMatchObject({uid:'microsoft-owner',googleSub:''});
});
const exchange = (flow: Flow, code: string, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/oauth/token`, form({
    grant_type: "authorization_code", code, code_verifier: flow.verifier, client_id: flow.clientId,
    redirect_uri: flow.redirect, resource: RESOURCE, ...extra,
  }));
const refresh = (flow: Flow, token: string, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/oauth/token`, form({ grant_type: "refresh_token", refresh_token: token, client_id: flow.clientId, ...extra }));
async function fullLogin(scope?: string) {
  const { flow, code } = await authorizeAll(scope);
  const tokens = await (await exchange(flow, code)).json() as any;
  return { flow, tokens };
}

describe("redirect rules", () => {
  it("allows https and loopback http only", () => {
    for (const ok of ["https://claude.ai/api/mcp/auth_callback", "http://localhost:6274/cb", "http://127.0.0.1:1/cb", "http://[::1]:9/cb"])
      expect(redirectAllowed(ok), ok).toBe(true);
    for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "myapp://cb", "https://a.example/cb#frag", "https://user:pw@a.example/cb", "not a url", ""])
      expect(redirectAllowed(bad), bad).toBe(false);
  });
  it("matches exactly, except that a loopback port may differ", () => {
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb")).toBe(true);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb2")).toBe(false);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb?x=1")).toBe(false);
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:53211/cb")).toBe(true);
    expect(redirectMatches(["http://localhost/cb"], "http://127.0.0.1:53211/cb")).toBe(true);
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:53211/other")).toBe(false);
    expect(redirectMatches(["https://a.example:8443/cb"], "https://a.example:9443/cb")).toBe(false);
  });
});

describe("consent page", () => {
  it("cannot be framed, so nobody can be tricked into pressing Allow", async () => {
    const app = express();
    app.use(createOAuthRouter({ config, store, now: () => clock, identify: async () => IDENTITIES["alice-token"], hasDriveGrant: async () => true }));
    app.get("/connect", (_req, res) => res.send("spa"));
    const framed = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const response = await fetch(`http://127.0.0.1:${(framed.address() as AddressInfo).port}/connect?request=x`);
    await new Promise<void>((resolve) => framed.close(() => resolve()));
    expect(await response.text()).toBe("spa");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("discovery", () => {
  it("publishes the authorization server metadata from the configured URL, not from Host", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { Host: "evil.example" } });
    const meta = await response.json() as any;
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/api/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/api/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${ISSUER}/api/oauth/register`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect(meta.scopes_supported).toEqual(["meetings:read", "meetings:live"]);
    expect(meta.client_id_metadata_document_supported).toBeUndefined();
  });
  it("serves the protected resource metadata at the path-aware and the root URL, resource equal to the MCP URL", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource"]) {
      const meta = await (await fetch(`${base}${path}`)).json() as any;
      expect(meta.resource).toBe(RESOURCE);
      expect(meta.authorization_servers).toEqual([ISSUER]);
      expect(meta.scopes_supported).toEqual(["meetings:read", "meetings:live"]);
    }
  });
  it("answers browser preflights with permissive CORS and never an error", async () => {
    for (const path of ["/api/oauth/token", "/api/oauth/register", "/api/oauth/revoke", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/api/mcp"]) {
      const response = await fetch(`${base}${path}`, { method: "OPTIONS", headers: { Origin: "https://claude.ai", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization,mcp-protocol-version" } });
      expect(response.status, path).toBe(204);
      expect(response.headers.get("access-control-allow-origin"), path).toBe("*");
      expect(response.headers.get("access-control-allow-headers")!.toLowerCase(), path).toContain("content-type");
    }
  });
});

describe("registration", () => {
  it("issues a signed client id that stores nothing and stays small", async () => {
    const { response, body } = await register({ redirect_uris: Array.from({ length: 5 }, (_, i) => `https://claude.ai/${"p".repeat(170)}${i}`), client_name: "N".repeat(100) });
    expect(response.status).toBe(201);
    expect(body.client_id.length).toBeLessThan(2048);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });
  it("rejects unsafe or malformed registrations", async () => {
    for (const bad of [
      { redirect_uris: ["http://evil.example/cb"] },
      { redirect_uris: ["javascript:alert(1)"] },
      { redirect_uris: [] },
      { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) },
      { redirect_uris: ["https://a.example/cb"], client_name: "" },
      { redirect_uris: ["https://a.example/cb"], client_name: "x".repeat(101) },
      { redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" },
      { redirect_uris: "https://a.example/cb" },
    ]) {
      const { response, body } = await register(bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(body.error).toMatch(/invalid_(redirect_uri|client_metadata)/);
    }
  });
});

describe("authorize", () => {
  it("never redirects to an unregistered or unknown target", async () => {
    const { body } = await register();
    const q = (extra: Record<string, string>) => new URLSearchParams({
      response_type: "code", client_id: body.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "x".repeat(43), code_challenge_method: "S256", ...extra,
    });
    for (const query of [q({ redirect_uri: "https://evil.example/cb" }), q({ client_id: "garbage" }), q({ redirect_uri: "" })]) {
      const response = await fetch(`${base}/api/oauth/authorize?${query}`, { redirect: "manual" });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });
  it("answers protocol mistakes with an error redirect that carries state and iss", async () => {
    const { body } = await register();
    const base64 = "x".repeat(43);
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: "" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://other.example/api/mcp" }, "invalid_target"],
    ];
    for (const [extra, error] of cases) {
      const query = new URLSearchParams({
        response_type: "code", client_id: body.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "abc",
        code_challenge: base64, code_challenge_method: "S256", ...extra,
      });
      const response = await fetch(`${base}/api/oauth/authorize?${query}`, { redirect: "manual" });
      expect(response.status, error).toBe(302);
      const target = new URL(response.headers.get("location")!);
      expect(target.origin + target.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
      expect(target.searchParams.get("error")).toBe(error);
      expect(target.searchParams.get("state")).toBe("abc");
      expect(target.searchParams.get("iss")).toBe(ISSUER);
    }
  });
  it("accepts a request without the optional resource parameter", async () => {
    const { response } = await startFlow({ resource: null });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(`${ISSUER}/connect?request=`);
  });
  it("sends a valid request to the consent page with a 302, never a 307", async () => {
    const { response } = await startFlow();
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).origin).toBe(ISSUER);
  });
});

describe("decision", () => {
  it("needs a signed-in Google user", async () => {
    const { response } = await startFlow();
    const request = requestOf(response);
    const anonymous = await fetch(`${base}/api/oauth/decision`, json({ request, approve: true }));
    expect(anonymous.status).toBe(401);
    expect((await approve(request, "unknown-token")).response.status).toBe(401);
  });
  it("needs the Drive connection the tools read through", async () => {
    IDENTITIES["nodrive-token"] = { uid: "dave", googleSub: "g-dave" };
    const { response } = await startFlow();
    const result = await approve(requestOf(response), "nodrive-token");
    expect(result.response.status).toBe(409);
    expect(result.body.error).toBe("no_drive_grant");
  });
  it("redirects with access_denied when the user says no", async () => {
    const { response } = await startFlow();
    const denied = await fetch(`${base}/api/oauth/decision`, {
      ...json({ request: requestOf(response), approve: false }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer alice-token" },
    });
    const target = new URL((await denied.json() as any).redirectTo);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("st-1");
    expect(target.searchParams.get("code")).toBeNull();
  });
  it("issues a code with state and iss on approval, and lets the user narrow the scopes", async () => {
    const { flow, code, url } = await authorizeAll();
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("iss")).toBe(ISSUER);
    expect(code).toBeTruthy();
    void flow;
    const { response } = await startFlow();
    const narrowed = await approve(requestOf(response), "alice-token", { scopes: ["meetings:read"] });
    expect(narrowed.response.status).toBe(200);
    const list = await store.listByOwner("alice");
    expect(list.at(-1)!.scopes).toEqual(["meetings:read"]);
  });
  it("refuses an approval that grants nothing, and a tampered request", async () => {
    const { response } = await startFlow();
    const request = requestOf(response);
    expect((await approve(request, "alice-token", { scopes: [] })).response.status).toBe(400);
    expect((await approve(request.slice(0, -3) + "AAA")).response.status).toBe(400);
  });
  it("refuses an expired request", async () => {
    const { response } = await startFlow();
    clock += 11 * 60_000;
    expect((await approve(requestOf(response))).response.status).toBe(400);
  });
  it("caps the number of connected assistants per user at 25", async () => {
    for (let i = 0; i < 25; i++) {
      const { response } = await startFlow();
      expect((await approve(requestOf(response))).response.status).toBe(200);
    }
    const { response } = await startFlow();
    expect((await approve(requestOf(response))).response.status).toBe(429);
  });
});

describe("token: authorization code", () => {
  it("exchanges a code for an audience-bound access token and a refresh token", async () => {
    const { flow, code } = await authorizeAll();
    const response = await exchange(flow, code);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const tokens = await response.json() as any;
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("meetings:read meetings:live");
    const info = await verifyAccessToken(tokens.access_token, { config, store, now: () => clock });
    expect(info.scopes).toEqual(["meetings:read", "meetings:live"]);
    expect(info.extra).toMatchObject({ uid: "alice", googleSub: "g-alice" });
    expect(info.resource?.href).toBe(RESOURCE);
  });
  it("rejects a wrong verifier, wrong redirect_uri, wrong client, wrong resource, and an expired code", async () => {
    const wrongs: [string, Record<string, string>][] = [
      ["invalid_grant", { code_verifier: randomBytes(32).toString("base64url") }],
      ["invalid_grant", { redirect_uri: "https://claude.ai/api/mcp/other" }],
      ["invalid_target", { resource: "https://other.example/api/mcp" }],
    ];
    for (const [error, extra] of wrongs) {
      const { flow, code } = await authorizeAll();
      const response = await exchange(flow, code, extra);
      expect(response.status, error).toBe(400);
      expect((await response.json() as any).error).toBe(error);
    }
    const a = await authorizeAll();
    const b = await startFlow({ name: "Another Assistant" });
    expect(b.flow.clientId).not.toBe(a.flow.clientId);
    const otherClient = await exchange({ ...a.flow, clientId: b.flow.clientId }, a.code);
    expect(otherClient.status).toBeGreaterThanOrEqual(400);
    const late = await authorizeAll();
    clock += 61_000;
    expect((await exchange(late.flow, late.code)).status).toBe(400);
  });
  it("accepts a token request that omits the resource parameter", async () => {
    const { flow, code } = await authorizeAll();
    const response = await exchange(flow, code, { resource: "" });
    expect(response.status).toBe(200);
  });
  it("ignores openid / offline_access in the requested scope instead of failing", async () => {
    const { flow, code } = await authorizeAll("openid offline_access meetings:read");
    const tokens = await (await exchange(flow, code)).json() as any;
    expect(tokens.scope).toBe("meetings:read");
  });
  it("kills the grant when a code is used a second time", async () => {
    const { flow, code } = await authorizeAll();
    const first = await (await exchange(flow, code)).json() as any;
    const second = await exchange(flow, code);
    expect(second.status).toBe(400);
    expect((await second.json() as any).error).toBe("invalid_grant");
    await expect(verifyAccessToken(first.access_token, { config, store, now: () => clock })).rejects.toThrow();
    expect((await refresh(flow, first.refresh_token)).status).toBe(400);
  });
  it("lets exactly one of 20 simultaneous redemptions win", async () => {
    const { flow, code } = await authorizeAll();
    const results = await Promise.all(Array.from({ length: 20 }, () => exchange(flow, code)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
  it("accepts form-encoded bodies and reports errors in the RFC 6749 shape", async () => {
    const response = await fetch(`${base}/api/oauth/token`, form({ grant_type: "password" }));
    expect(response.status).toBe(400);
    expect((await response.json() as any).error).toBe("unsupported_grant_type");
  });
});

describe("token: refresh", () => {
  it("rotates the refresh token and keeps working", async () => {
    const { flow, tokens } = await fullLogin();
    const next = await (await refresh(flow, tokens.refresh_token)).json() as any;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const again = await refresh(flow, next.refresh_token);
    expect(again.status).toBe(200);
  });
  it("revokes the whole grant when an old refresh token is replayed after the grace window", async () => {
    const { flow, tokens } = await fullLogin();
    const next = await (await refresh(flow, tokens.refresh_token)).json() as any;
    clock += 60_000;
    const replay = await refresh(flow, tokens.refresh_token);
    expect(replay.status).toBe(400);
    expect((await replay.json() as any).error).toBe("invalid_grant");
    expect((await refresh(flow, next.refresh_token)).status).toBe(400);
    await expect(verifyAccessToken(next.access_token, { config, store, now: () => clock })).rejects.toThrow();
  });
  it("tolerates a duplicate refresh within seconds without punishing the client", async () => {
    const { flow, tokens } = await fullLogin();
    const winner = await (await refresh(flow, tokens.refresh_token)).json() as any;
    clock += 2_000;
    const loser = await refresh(flow, tokens.refresh_token);
    expect(loser.status).toBe(400);
    expect((await refresh(flow, winner.refresh_token)).status).toBe(200);
  });
  it("may narrow the scope but never widen it", async () => {
    const { flow, tokens } = await fullLogin("meetings:read");
    const widened = await (await refresh(flow, tokens.refresh_token, { scope: "meetings:read meetings:live" })).json() as any;
    expect(widened.scope).toBe("meetings:read");
    const narrowed = await (await refresh(flow, widened.refresh_token, { scope: "meetings:read" })).json() as any;
    expect(narrowed.scope).toBe("meetings:read");
  });
  it("expires after 90 days without use", async () => {
    const { flow, tokens } = await fullLogin();
    clock += 91 * 24 * 3_600_000;
    expect((await refresh(flow, tokens.refresh_token)).status).toBe(400);
  });
  it("is bound to the client it was issued to", async () => {
    const { tokens } = await fullLogin();
    const other = await startFlow({ name: "Another Assistant" });
    expect((await refresh(other.flow, tokens.refresh_token)).status).toBe(400);
  });
});

describe("access tokens", () => {
  const info = (token: string) => verifyAccessToken(token, { config, store, now: () => clock });
  it("stop working when they expire", async () => {
    const { tokens } = await fullLogin();
    await expect(info(tokens.access_token)).resolves.toBeTruthy();
    clock += 3_601_000;
    await expect(info(tokens.access_token)).rejects.toThrow();
  });
  it("stop working the moment the grant is revoked", async () => {
    const { tokens } = await fullLogin();
    const [grant] = await store.listByOwner("alice");
    const revoked = await fetch(`${base}/api/mcp/grants/${grant.id}`, { method: "DELETE", headers: { Authorization: "Bearer alice-token" } });
    expect(revoked.status).toBe(200);
    await expect(info(tokens.access_token)).rejects.toThrow();
  });
  it("reject tampering, the none algorithm, another audience, and garbage", async () => {
    const { tokens } = await fullLogin();
    const [head, payload, sig] = tokens.access_token.split(".");
    await expect(info(`${head}.${payload}.${sig.slice(0, -2)}AA`)).rejects.toThrow();
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${payload}.`;
    await expect(info(none)).rejects.toThrow();
    await expect(info("not-a-jwt")).rejects.toThrow();
    const { SignJWT } = await import("jose");
    const foreign = await new SignJWT({ gid: "x", scope: "meetings:read" })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).setAudience("https://other.example/api/mcp").setIssuer(ISSUER)
      .setSubject("alice").setIssuedAt(Math.floor(clock / 1000)).setExpirationTime(Math.floor(clock / 1000) + 600)
      .sign(config.secret);
    await expect(info(foreign)).rejects.toThrow();
  });
});

describe("grants and revocation", () => {
  it("lists only the caller's own grants, without secrets", async () => {
    await fullLogin();
    const mine = await (await fetch(`${base}/api/mcp/grants`, { headers: { Authorization: "Bearer alice-token" } })).json() as any;
    expect(mine.grants).toHaveLength(1);
    expect(mine.grants[0]).toMatchObject({ clientName: "Test Assistant", scopes: ["meetings:read", "meetings:live"], redirectHost: "claude.ai" });
    expect(JSON.stringify(mine)).not.toMatch(/hash|secret|refresh/i);
    const theirs = await (await fetch(`${base}/api/mcp/grants`, { headers: { Authorization: "Bearer bob-token" } })).json() as any;
    expect(theirs.grants).toEqual([]);
    expect((await fetch(`${base}/api/mcp/grants`)).status).toBe(401);
  });
  it("lets nobody revoke someone else's grant", async () => {
    await fullLogin();
    const [grant] = await store.listByOwner("alice");
    const denied = await fetch(`${base}/api/mcp/grants/${grant.id}`, { method: "DELETE", headers: { Authorization: "Bearer bob-token" } });
    expect(denied.status).toBe(404);
    expect((await store.get(grant.id))?.status).toBe("active");
  });
  it("revokes through the standard endpoint too, and answers 200 for unknown tokens", async () => {
    const { flow, tokens } = await fullLogin();
    expect((await fetch(`${base}/api/oauth/revoke`, form({ token: "nonsense", client_id: flow.clientId }))).status).toBe(200);
    expect((await fetch(`${base}/api/oauth/revoke`, form({ token: tokens.refresh_token, client_id: flow.clientId }))).status).toBe(200);
    expect((await refresh(flow, tokens.refresh_token)).status).toBe(400);
  });
});

describe("abuse limits", () => {
  it("answers 429 with Retry-After once a client is too fast", async () => {
    const app = express();
    app.use(createOAuthRouter({ config, store, now: () => clock, identify: async () => IDENTITIES["alice-token"], hasDriveGrant: async () => true, limits: { perMinute: 3 } }));
    const limited = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/api/oauth/register`;
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 5; i++) {
      const response = await fetch(url, json({ client_name: "x", redirect_uris: ["https://a.example/cb"] }));
      statuses.push(response.status);
      retryAfter ||= response.headers.get("retry-after");
    }
    await new Promise<void>((resolve) => limited.close(() => resolve()));
    expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
