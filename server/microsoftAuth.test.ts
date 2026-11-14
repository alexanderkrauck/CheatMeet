import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { memoryDocStore } from "./mcp/docStore";
import { SignJWT } from "jose";
const firebaseKey = vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
});
vi.mock("jose", async importOriginal => {
  const actual = await importOriginal<typeof import("jose")>();
  const { publicKey } = await firebaseKey;
  return { ...actual, createRemoteJWKSet: () => publicKey };
});
import { createMicrosoftAuthRouter, createMicrosoftAuthService, firebaseAccountFor as verifyFirebaseAccountFor, microsoftConfigured, type MicrosoftAuthDocument, type MicrosoftClient } from "./microsoftAuth";
import { memoryStore, uidGrantKey } from "./tokenStore";
const firebaseAccountFor = (token: string, projectId: string) => verifyFirebaseAccountFor(token, projectId, memoryStore());

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); vi.unstubAllEnvs(); });
async function fixture() {
  const store = memoryDocStore<MicrosoftAuthDocument>();
  let nonce = "";
  const account = { homeAccountId: "account-1", environment: "login.microsoftonline.com", tenantId: "tenant", username: "user@example.test", localAccountId: "local" };
  const authUrl = vi.fn(async (request: any) => {
    nonce = request.nonce;
    const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    Object.entries(request).forEach(([k,v]) => url.searchParams.set(k, Array.isArray(v) ? v.join(" ") : String(v)));
    return url.href;
  });
  const exchange = vi.fn(async (_request: unknown) => ({ account, accessToken: "access-only", expiresOn: new Date(Date.now()+3600_000), scopes: ["Files.ReadWrite"], idTokenClaims: { nonce } }));
  const silent = vi.fn(async () => ({ account, accessToken: "fresh-access", expiresOn: new Date(Date.now()+3600_000), scopes: ["Files.ReadWrite"], idTokenClaims: {} }));
  const provider = (): MicrosoftClient => ({ getAuthCodeUrl: authUrl, acquireTokenByCode: exchange, acquireTokenSilent: silent, getTokenCache: () => ({ serialize: () => "private-msal-cache", getAccountByHomeId: async () => account }) });
  const options = { store, clientId: "client", clientSecret: "test-only", publicUrl: "https://cheatmeet.example", identify: async (token: string) => { if (token !== "alice" && token !== "bob") throw Error("bad"); return { uid: token, googleSub: "" }; }, createClient: provider };
  // Production mounts the router directly, without an application-wide JSON parser.
  const app = express(); app.use("/api", createMicrosoftAuthRouter(options));
  const server = createServer(app); servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); if (!address || typeof address === "string") throw Error("address");
  const base = `http://127.0.0.1:${address.port}/api`;
  const call = (path: string, owner = "alice", body?: unknown) => fetch(base+path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json", Origin: "https://cheatmeet.example" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const begin = async (calendar = false) => {
    const response = await call("/microsoft/connect", "alice", { calendar });
    expect(response.status).toBe(200);
    return { url: new URL((await response.json()).url), cookie: response.headers.get("set-cookie")!.split(";")[0] };
  };
  const callback = (start: Awaited<ReturnType<typeof begin>>) => fetch(base+`/auth/microsoft/callback?state=${start.url.searchParams.get("state")}&code=one-time-code`, { headers: { Cookie: start.cookie } });
  return { store, options, call, begin, callback, authUrl, exchange, silent, base };
}

it("connects a Firebase-only owner with PKCE, persists MSAL cache, and serves only safe owner metadata/tokens", async () => {
  const f = await fixture();
  expect((await f.call("/microsoft/connections", "invalid")).status).toBe(401);
  const start = await f.begin();
  expect(f.authUrl.mock.calls[0][0]).toMatchObject({ redirectUri: "https://cheatmeet.example/api/auth/microsoft/callback", codeChallengeMethod: "S256" });
  expect(f.authUrl.mock.calls[0][0].codeChallenge).toMatch(/^[\w-]{43}$/);
  expect(f.authUrl.mock.calls[0][0].scopes).toEqual(expect.arrayContaining(["openid", "profile", "offline_access", "https://graph.microsoft.com/Files.ReadWrite"]));
  const result = await f.callback(start);
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('"connected":true');
  expect(f.exchange.mock.calls[0][0]).toMatchObject({ code: "one-time-code", codeVerifier: expect.any(String) });
  const connections = (await (await f.call("/microsoft/connections")).json()).connections;
  expect(connections).toEqual([{ connectionId: expect.any(String), accountName: "user@example.test", calendar: false }]);
  expect((await (await f.call("/microsoft/connections", "bob")).json()).connections).toEqual([]);
  const restarted = createMicrosoftAuthService(f.options);
  expect(await restarted.getAccess("alice", connections[0].connectionId)).toMatchObject({ accessToken: "fresh-access", connectionId: connections[0].connectionId, calendar: false });
  expect(await (await f.call("/microsoft/token", "bob", { connectionId: connections[0].connectionId })).json()).not.toHaveProperty("accessToken");
  expect((await f.call("/microsoft/disconnect", "alice", { connectionId: connections[0].connectionId })).status).toBe(200);
  expect(await restarted.list("alice")).toEqual([]);
  expect((await f.callback(start)).status).toBe(400);
});

async function firebaseToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now()/1000);
  return new SignJWT({ sub: "firebase-microsoft-owner", iat: now, exp: now+3600, auth_time: now, firebase: { identities: { "microsoft.com": ["ms-id"] } }, ...overrides })
    .setProtectedHeader({ alg: "RS256" }).setIssuer("https://securetoken.google.com/test-project").setAudience("test-project").sign((await firebaseKey).privateKey);
}
it("requires Firebase lifetime claims even on a correctly signed token", async () => {
  const noExpiry = await firebaseToken({ exp: undefined });
  await expect(firebaseAccountFor(noExpiry, "test-project")).rejects.toThrow();
  const noIssued = await firebaseToken({ iat: undefined });
  await expect(firebaseAccountFor(noIssued, "test-project")).rejects.toThrow();
});

it("refuses a cached token when Graph Files scope is absent", async () => {
  const f = await fixture();
  await f.callback(await f.begin());
  f.silent.mockImplementationOnce(async () => ({ account: { homeAccountId: "account-1", environment: "login.microsoftonline.com", tenantId: "tenant", username: "user@example.test", localAccountId: "local" }, accessToken: "wrong-scope-access", expiresOn: new Date(Date.now()+3600_000), scopes: [], idTokenClaims: {} }));
  const response = await f.call("/microsoft/token", "alice", {});
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("wrong-scope-access");
});

it("validates real signed Firebase identities independently of Google and rejects wrong claims/signatures", async () => {
  expect(await firebaseAccountFor(await firebaseToken(), "test-project")).toEqual({ uid: "firebase-microsoft-owner", googleSub: "" });
  const grants = memoryStore();
  await grants.set(uidGrantKey("firebase-microsoft-owner"), "fixture-owner-refresh");
  expect(await verifyFirebaseAccountFor(await firebaseToken(), "test-project", grants)).toEqual({uid:"firebase-microsoft-owner",googleSub:uidGrantKey("firebase-microsoft-owner")});
  const googleIdentity = await firebaseToken({ firebase: { identities: { "google.com": ["google-sub"] } } });
  expect(await verifyFirebaseAccountFor(googleIdentity, "test-project", null)).toMatchObject({ googleSub: "google-sub" });
  expect(await firebaseAccountFor(googleIdentity, "test-project")).toMatchObject({ googleSub: uidGrantKey("firebase-microsoft-owner") });
  const legacy = memoryStore(); await legacy.set("google-sub", "fixture-legacy-refresh");
  expect(await verifyFirebaseAccountFor(googleIdentity, "test-project", legacy)).toMatchObject({ googleSub: "google-sub" });
  await expect(firebaseAccountFor(await firebaseToken(), "wrong-project")).rejects.toThrow();
  for (const changes of [{ sub: "" }, { sub: "x".repeat(129) }, { auth_time: undefined }, { auth_time: Date.now()/1000 + 500 }, { iat: Date.now()/1000 + 500 }, { exp: 1 }])
    await expect(firebaseAccountFor(await firebaseToken(changes), "test-project")).rejects.toThrow();
  const token = await firebaseToken();
  const parts = token.split("."); parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
  await expect(firebaseAccountFor(parts.join("."), "test-project")).rejects.toThrow();
});

it("binds state to its browser, checks nonce, and consumes it before exchange", async () => {
  const f = await fixture();
  const start = await f.begin();
  const wrong = await fetch(f.base+`/auth/microsoft/callback?state=${start.url.searchParams.get("state")}&code=x`, { headers: { Cookie: "cheatmeet_microsoft_state=wrong" } });
  expect(wrong.status).toBe(400); expect(f.exchange).not.toHaveBeenCalled();
  f.exchange.mockImplementationOnce(async () => ({ account: { homeAccountId: "account-1", environment: "login.microsoftonline.com", tenantId: "tenant", username: "user@example.test", localAccountId: "local" }, accessToken: "never-expose", expiresOn: new Date(), scopes: ["Files.ReadWrite"], idTokenClaims: { nonce: "wrong" } }));
  const rejected = await f.callback(start);
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).not.toMatch(/never-expose|private-msal-cache|wrong/);
  expect((await f.callback(start)).status).toBe(400);
  expect(f.exchange).toHaveBeenCalledTimes(1);
  expect(await createMicrosoftAuthService(f.options).list("alice")).toEqual([]);
});

it("does not resurrect a connection disconnected while a refresh is in flight", async () => {
  const f = await fixture(); await f.callback(await f.begin());
  const service = createMicrosoftAuthService(f.options);
  const [connection] = await service.list("alice");
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(r => { started = r; });
  const pause = new Promise<void>(r => { release = r; });
  const original = f.silent.getMockImplementation()!;
  f.silent.mockImplementationOnce(async () => { started(); await pause; return original(); });
  const pending = service.getAccess("alice", connection.connectionId);
  await waiting;
  await service.disconnect("alice", connection.connectionId);
  release();
  await expect(pending).rejects.toThrow();
  expect(await service.list("alice")).toEqual([]);
});

it("allows only one concurrent callback exchange", async () => {
  const f = await fixture(); const start = await f.begin();
  const responses = await Promise.all([f.callback(start), f.callback(start)]);
  expect(responses.map(r => r.status).sort()).toEqual([200,400]);
  expect(f.exchange).toHaveBeenCalledTimes(1);
});

it("requires explicit connection choice for multiple grants and disconnects only the owner's exact grant", async () => {
  const f = await fixture(); await f.callback(await f.begin());
  const secondStart = await f.begin();
  const secondResult = await f.exchange.getMockImplementation()!({});
  f.exchange.mockResolvedValueOnce({ ...secondResult, account: { ...secondResult.account, homeAccountId: "account-2" } });
  await f.callback(secondStart);
  const service = createMicrosoftAuthService(f.options);
  const connections = await service.list("alice"); expect(connections).toHaveLength(2);
  await expect(service.getAccess("alice")).rejects.toThrow();
  await service.disconnect("bob", connections[0].connectionId);
  expect(await service.list("alice")).toHaveLength(2);
  await service.disconnect("alice", connections[0].connectionId);
  expect(await service.list("alice")).toEqual([connections[1]]);
});

it("checks cross-origin writes and malformed bodies without leaking provider errors", async () => {
  const f = await fixture();
  expect((await fetch(f.base+"/microsoft/connect", { method: "POST", headers: { Authorization: "Bearer alice", Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  expect((await f.call("/microsoft/connect", "alice", { calendar: "yes" })).status).toBe(400);
  expect((await f.call("/microsoft/token", "alice", { connectionId: {} })).status).toBe(400);
  expect((await f.call("/microsoft/disconnect", "alice", {})).status).toBe(400);
  const start = await f.begin(); f.exchange.mockRejectedValueOnce(new Error("refresh-secret-provider-diagnostic"));
  const response = await f.callback(start);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toContain("refresh-secret-provider-diagnostic");
});

it("executes the real MSAL code exchange and restores its persisted token cache with offline HTTP fixtures", async () => {
  const store = memoryDocStore<MicrosoftAuthDocument>();
  let nonce = "";
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/discovery/instance")) return Response.json({ tenant_discovery_endpoint: "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration", metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }] });
    if (url.includes(".well-known/openid-configuration")) return Response.json({ authorization_endpoint: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize", token_endpoint: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", end_session_endpoint: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/logout", issuer: "https://login.microsoftonline.com/{tenant}/v2.0", jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys" });
    if (url.includes("/oauth2/v2.0/token")) {
      const params = new URLSearchParams(String(init?.body));
      if (params.get("grant_type") === "authorization_code") expect(params.get("code_verifier")).toMatch(/^[\w-]{43}$/);
      else { expect(params.get("grant_type")).toBe("refresh_token"); expect(params.get("refresh_token")).toBe("fixture-refresh"); }
      const now = Math.floor(Date.now()/1000);
      const idToken = [Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"), Buffer.from(JSON.stringify({ aud: "client", iss: "https://login.microsoftonline.com/tenant/v2.0", iat: now, nbf: now, exp: now+3600, nonce, oid: "local", sub: "subject", tid: "tenant", preferred_username: "msal@example.test" })).toString("base64url"), "fixture-signature"].join(".");
      return Response.json({ token_type: "Bearer", scope: "https://graph.microsoft.com/Files.ReadWrite", expires_in: params.get("grant_type") === "authorization_code" ? 1 : 3600, ext_expires_in: 3600, access_token: "msal-access", refresh_token: "fixture-refresh", id_token: idToken, client_info: Buffer.from(JSON.stringify({ uid: "local", utid: "tenant" })).toString("base64url") });
    }
    throw new Error("Unexpected fixture URL: " + url);
  });
  const options = { store, clientId: "client", clientSecret: "fixture-secret", publicUrl: "https://cheatmeet.example", fetchImpl: transport as typeof fetch };
  const service = createMicrosoftAuthService(options);
  const start = await service.begin("owner", false);
  const url = new URL(start.url); nonce = url.searchParams.get("nonce")!;
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  await service.complete(url.searchParams.get("state")!, start.browser, "fixture-code");
  const [connection] = await service.list("owner");
  expect(connection.accountName).toBe("msal@example.test");
  expect(await createMicrosoftAuthService(options).getAccess("owner", connection.connectionId)).toMatchObject({ accessToken: "msal-access", calendar: false });
  expect(await createMicrosoftAuthService(options).getAccess("owner", connection.connectionId)).toMatchObject({ accessToken: "msal-access" });
  expect(transport.mock.calls.filter(([url]) => String(url).includes("/oauth2/v2.0/token"))).toHaveLength(2);
  expect(transport.mock.calls.every(([,init]) => init?.signal instanceof AbortSignal)).toBe(true);
});

it("returns a reconnect status for revoked MSAL grants, not raw diagnostics or a temporary outage", async () => {
  const f = await fixture(); await f.callback(await f.begin());
  f.silent.mockRejectedValueOnce(Object.assign(new Error("private-provider-message"), { errorCode: "invalid_grant" }));
  const response = await f.call("/microsoft/token", "alice", {});
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("private-provider-message");
});

it("requests Calendar only on opt-in and reports only actually granted permission", async () => {
  const f = await fixture();
  await f.begin(false);
  expect(f.authUrl.mock.calls[0][0].scopes).not.toContain("https://graph.microsoft.com/Calendars.ReadWrite");
  const start = await f.begin(true);
  expect(f.authUrl.mock.calls[1][0].scopes).toContain("https://graph.microsoft.com/Calendars.ReadWrite");
  const result = await f.exchange.getMockImplementation()!({});
  f.exchange.mockResolvedValueOnce({ ...result, scopes: ["Files.ReadWrite", "Calendars.ReadWrite"] });
  expect((await f.callback(start)).status).toBe(200);
  const service = createMicrosoftAuthService(f.options);
  const [connection] = await service.list("alice"); expect(connection.calendar).toBe(true);
  const access = await f.silent.getMockImplementation()!();
  f.silent.mockResolvedValueOnce({ ...access, scopes: ["Files.ReadWrite", "Calendars.ReadWrite"] });
  expect(await service.getAccess("alice", connection.connectionId)).toMatchObject({ calendar: true });
});

it("rejects expired state before provider exchange", async () => {
  const f = await fixture(); const start = await f.begin();
  const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11*60_000);
  try { expect((await f.callback(start)).status).toBe(400); expect(f.exchange).not.toHaveBeenCalled(); }
  finally { clock.mockRestore(); }
});

it("requires credentials and a fixed safe public origin, never a request Host fallback", () => {
  vi.stubEnv("MICROSOFT_CLIENT_ID", "fixture-client"); vi.stubEnv("MICROSOFT_CLIENT_SECRET", "fixture-secret");
  vi.stubEnv("MICROSOFT_AUTHORITY", "https://login.microsoftonline.com/common"); vi.stubEnv("MICROSOFT_PUBLIC_URL", "https://cheatmeet.example");
  expect(microsoftConfigured()).toBe(true);
  for (const value of ["", "http://public.example", "https://public.example/path", "https://user:pass@public.example", "https://public.example?query=1"]) {
    vi.stubEnv("MICROSOFT_PUBLIC_URL", value); expect(microsoftConfigured()).toBe(false);
  }
  vi.stubEnv("MICROSOFT_PUBLIC_URL", "https://cheatmeet.example"); vi.stubEnv("MICROSOFT_AUTHORITY", "https://evil.example/common"); expect(microsoftConfigured()).toBe(false);
});

it("preserves a pinned connection ID on reauthorization of the same account without accumulating duplicate grants", async () => {
  const f = await fixture(); const service = createMicrosoftAuthService(f.options);
  await f.callback(await f.begin()); const [original] = await service.list("alice");
  await f.callback(await f.begin());
  expect(await service.list("alice")).toEqual([original]);
  await service.disconnect("alice", original.connectionId);
  await f.callback(await f.begin());
  expect(await service.list("alice")).toEqual([original]);
});

it("preserves explicit Outlook intent and connection order on files-only renewal only with actual Calendar scopes", async () => {
  const f = await fixture();
  const service = createMicrosoftAuthService(f.options);
  const connect = async (calendar: boolean, homeAccountId: string, grantedCalendar: boolean) => {
    const start = await f.begin(calendar);
    const result = await f.exchange.getMockImplementation()!({});
    f.exchange.mockResolvedValueOnce({ ...result, account: { ...result.account, homeAccountId }, scopes: ["Files.ReadWrite", ...(grantedCalendar ? ["Calendars.ReadWrite"] : [])] });
    expect((await f.callback(start)).status).toBe(200);
  };
  await connect(true, "work", true);
  await connect(true, "personal", true);
  const original = await service.list("alice");
  await connect(false, "work", true);
  expect(await service.list("alice")).toEqual(original);
  expect(f.authUrl.mock.calls.at(-1)![0].scopes).not.toContain("https://graph.microsoft.com/Calendars.ReadWrite");
  await connect(false, "work", false);
  expect(await service.list("alice")).toEqual([{ ...original[0], calendar: false }, original[1]]);
  await connect(false, "work", true);
  expect(await service.list("alice")).toEqual(original);
  await connect(false, "new-files-only", true);
  expect((await service.list("alice"))[2].calendar).toBe(false);
});

it("retries cache contention rather than misreporting concurrent valid token requests as revoked", async () => {
  const f = await fixture(); await f.callback(await f.begin());
  const service = createMicrosoftAuthService(f.options);
  const result = await Promise.allSettled([service.getAccess("alice"), service.getAccess("alice")]);
  expect(result.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
});
