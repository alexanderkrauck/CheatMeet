import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import {
  buildAuthUrl,
  codeChallenge,
  createAuthRouter,
  exchangeCode,
  googleAccountFor,
  refreshAccessToken,
} from "../server/googleAuth";
import { memoryStore } from "../server/tokenStore";

/** A signed-in Google-backed Firebase identity. */
const identity = { uid: "firebase-uid", googleSub: "google-123" };

describe("google oauth helpers", () => {
  it("requests offline access, or Google never issues a refresh token", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "https://app.test/api/auth/google/callback",
        state: "st",
      }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st");
    // Only files the app created: this bounds the damage of a server breach.
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/drive.file",
    );
    expect(url.searchParams.get("scope")).not.toContain("auth/drive ");
  });

  it("sends the client secret only from the server side of the exchange", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ access_token: "at", expires_in: 3599, refresh_token: "rt" }),
    );
    const tokens = await exchangeCode(
      {
        code: "c",
        clientId: "cid",
        clientSecret: "secret",
        redirectUri: "https://app.test/cb",
      },
      fetchImpl as unknown as typeof fetch,
    );
    const body = String((fetchImpl.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain("client_secret=secret");
    expect(body).toContain("grant_type=authorization_code");
    expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt" });
  });

  it("surfaces invalid_grant as a code so callers can stop retrying", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    await expect(
      refreshAccessToken(
        { refreshToken: "rt", clientId: "cid", clientSecret: "s" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("firebase identity mapping", () => {
  const verify = (payload: Record<string, unknown>) =>
    (async () => ({ payload })) as never;

  it("keys the grant by the Google subject inside the Firebase token", async () => {
    // This claim is the only link between a Firebase uid and the stored grant.
    const account = await googleAccountFor(
      "token",
      "project",
      verify({
        sub: "firebase-uid",
        firebase: { identities: { "google.com": ["google-123"] } },
      }),
    );
    expect(account).toEqual({ uid: "firebase-uid", googleSub: "google-123" });
  });

  it.each([
    ["no google identity", { sub: "u", firebase: { identities: {} } }],
    ["a non-Google sign-in", { sub: "u", firebase: { identities: { "password": ["e"] } } }],
    ["no subject", { firebase: { identities: { "google.com": ["g"] } } }],
  ])("rejects %s", async (_label, payload) => {
    await expect(
      googleAccountFor("token", "project", verify(payload)),
    ).rejects.toThrow();
  });
});

describe("drive token endpoint", () => {
  let server: Server;
  let base: string;
  let store: ReturnType<typeof memoryStore>;
  let fetchImpl: ReturnType<typeof vi.fn>;
  const identify = vi.fn();

  const mount = (opts: Record<string, unknown> = {}) => {
    const app = express();
    app.use(
      "/api",
      createAuthRouter({
        store,
        identify: identify as never,
        clientId: "cid",
        clientSecret: "secret",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...opts,
      }),
    );
    return app;
  };

  beforeEach(async () => {
    store = memoryStore();
    fetchImpl = vi.fn();
    identify.mockReset().mockResolvedValue(identity);
    server = mount().listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as never as { port: number }).port}`;
  });
  afterEach(
    () => new Promise<void>((r) => server.close(() => r())),
  );

  const mint = (token = "firebase-id-token") =>
    fetch(`${base}/api/drive-token`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  it("mints an access token from the stored grant without any user prompt", async () => {
    await store.set(identity.googleSub, "stored-refresh");
    fetchImpl.mockResolvedValueOnce(
      Response.json({ access_token: "fresh", expires_in: 3599 }),
    );
    const response = await mint();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accessToken: "fresh",
      expiresInSeconds: 3599,
    });
    expect(String((fetchImpl.mock.calls[0][1] as RequestInit).body)).toContain(
      "refresh_token=stored-refresh",
    );
  });

  it("rejects a request with no Firebase identity", async () => {
    expect((await mint("")).status).toBe(401);
    identify.mockRejectedValueOnce(new Error("bad token"));
    expect((await mint()).status).toBe(401);
  });

  it("asks for consent when the user has no stored grant", async () => {
    const response = await mint();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reauth: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops a revoked grant and asks for consent, rather than retrying forever", async () => {
    await store.set(identity.googleSub, "revoked");
    fetchImpl.mockResolvedValueOnce(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    const response = await mint();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reauth: true });
    // Removed, so the next attempt starts a fresh consent instead of looping.
    expect(await store.get(identity.googleSub)).toBeNull();
  });

  it("keeps the grant when Google is merely unreachable", async () => {
    await store.set(identity.googleSub, "still-good");
    fetchImpl.mockRejectedValueOnce(new Error("network down"));
    expect((await mint()).status).toBe(503);
    expect(await store.get(identity.googleSub)).toBe("still-good");
  });

  it("reports whether the deployment can mint tokens at all", async () => {
    expect(await (await fetch(`${base}/api/auth/config`)).json()).toEqual({
      serverAuth: true,
      clientId: true,
      clientSecret: true,
    });

    const bare = mount({ clientSecret: "" }).listen(0, "127.0.0.1");
    await new Promise<void>((r) => bare.once("listening", r));
    const port = (bare.address() as never as { port: number }).port;
    // Without a secret the client keeps the popup flow instead of breaking.
    // Says which half is missing, so a half-configured deployment is
    // diagnosable without reading the container's environment.
    expect(
      await (await fetch(`http://127.0.0.1:${port}/api/auth/config`)).json(),
    ).toEqual({ serverAuth: false, clientId: true, clientSecret: false });
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/drive-token`, {
          method: "POST",
          headers: { Authorization: "Bearer t" },
        })
      ).status,
    ).toBe(503);
    await new Promise<void>((r) => bare.close(() => r()));
  });

  it("completes consent: state, PKCE, stored grant and identity back to the app", async () => {
    // /start issues the cookie the callback is checked against.
    const started = await fetch(`${base}/api/auth/google/start`, {
      redirect: "manual",
    });
    const setCookie = started.headers.get("set-cookie") || "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/api/auth");
    const cookie = /cheatmeet_oauth_state=([^;]+)/.exec(setCookie)![1];
    const [state, verifier] = decodeURIComponent(cookie).split(".");

    const authUrl = new URL(started.headers.get("location")!);
    expect(authUrl.searchParams.get("state")).toBe(state);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toBe(
      codeChallenge(verifier),
    );
    // Widening scopes silently would defeat the point of drive.file.
    expect(authUrl.searchParams.get("include_granted_scopes")).toBeNull();

    const idToken = [
      "e30",
      Buffer.from(JSON.stringify({ sub: identity.googleSub })).toString(
        "base64url",
      ),
      "sig",
    ].join(".");
    fetchImpl.mockResolvedValueOnce(
      Response.json({ access_token: "at", expires_in: 3599, refresh_token: "rt", id_token: idToken }),
    );

    const response = await fetch(
      `${base}/api/auth/google/callback?code=the-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `cheatmeet_oauth_state=${cookie}` } },
    );
    expect(response.status).toBe(200);
    // The id_token must not be cached by any intermediary.
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie") || "").toContain(
      "cheatmeet_oauth_state=;",
    );
    expect(await response.text()).toContain(idToken);

    const body = String((fetchImpl.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain(`code_verifier=${verifier}`);
    // The redirect_uri must match /start exactly or Google rejects the exchange.
    expect(body).toContain(
      `redirect_uri=${encodeURIComponent(authUrl.searchParams.get("redirect_uri")!)}`,
    );
    expect(await store.get(identity.googleSub)).toBe("rt");
  });

  it("revokes the grant at Google and drops it on sign-out", async () => {
    await store.set(identity.googleSub, "rt");
    fetchImpl.mockResolvedValueOnce(new Response("", { status: 200 }));
    const response = await fetch(`${base}/api/auth/revoke`, {
      method: "POST",
      headers: { Authorization: "Bearer firebase-id-token" },
    });
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls[0][0]).toContain("oauth2.googleapis.com/revoke");
    expect(await store.get(identity.googleSub)).toBeNull();
  });

  it("tells a first-time user to consent rather than claiming revocation", async () => {
    const response = await mint();
    expect(response.status).toBe(403);
    const body = await response.json();
    // A fresh user did nothing wrong; the copy must not say "entzogen".
    expect(body).toMatchObject({ reauth: true, reason: "no_grant" });
    expect(body.error).not.toMatch(/entzogen/i);
  });

  it("drops the grant even when Google's revoke endpoint fails", async () => {
    await store.set(identity.googleSub, "rt");
    fetchImpl.mockRejectedValueOnce(new Error("revoke unreachable"));
    const response = await fetch(`${base}/api/auth/revoke`, {
      method: "POST",
      headers: { Authorization: "Bearer firebase-id-token" },
    });
    expect(response.status).toBe(200);
    expect(await store.get(identity.googleSub)).toBeNull();
  });

  it("refuses to revoke on a deployment that cannot mint tokens", async () => {
    const bare = mount({ clientSecret: "" }).listen(0, "127.0.0.1");
    await new Promise<void>((r) => bare.once("listening", r));
    const port = (bare.address() as never as { port: number }).port;
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/auth/revoke`, {
          method: "POST",
          headers: { Authorization: "Bearer t" },
        })
      ).status,
    ).toBe(503);
    await new Promise<void>((r) => bare.close(() => r()));
  });

  it("reads the state cookie back through Express's url-encoding", async () => {
    // res.cookie url-encodes; a decode mismatch would fail every login with a
    // generic message and nothing pointing at the cause.
    const started = await fetch(`${base}/api/auth/google/start`, {
      redirect: "manual",
    });
    const setCookie = started.headers.get("set-cookie") || "";
    const raw = /cheatmeet_oauth_state=([^;]+)/.exec(setCookie)![1];
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const response = await fetch(
      `${base}/api/auth/google/callback?state=${encodeURIComponent(state)}`,
      { headers: { cookie: `cheatmeet_oauth_state=${raw}` } },
    );
    // State accepted (it fails later, on the missing code) rather than rejected.
    expect(await response.text()).toContain("Google hat die Freigabe abgebrochen");
  });

  it("reports a missing client id distinctly from a missing secret", async () => {
    // The client id normally comes from firebase-applet-config.json; some
    // deployments ship that file without an oAuthClientId key.
    const bare = mount({ clientId: "" }).listen(0, "127.0.0.1");
    await new Promise<void>((r) => bare.once("listening", r));
    const port = (bare.address() as never as { port: number }).port;
    expect(
      await (await fetch(`http://127.0.0.1:${port}/api/auth/config`)).json(),
    ).toEqual({ serverAuth: false, clientId: false, clientSecret: true });
    await new Promise<void>((r) => bare.close(() => r()));
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const response = await fetch(
      `${base}/api/auth/google/callback?code=c&state=forged`,
      { headers: { cookie: "cheatmeet_oauth_state=real" } },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Ungültiger Anmeldevorgang");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
