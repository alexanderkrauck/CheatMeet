import express from "express";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createAuthRouter } from "./googleAuth";
import { memoryStore, resolveOwnerGoogleKey, uidGrantKey } from "./tokenStore";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); vi.restoreAllMocks(); });
async function fixture(clientSecret = "fixture-secret") {
  const store = memoryStore();
  const identify = vi.fn(async (_token: string) => ({ uid: "owner", googleSub: "" }));
  const transport = vi.fn<typeof fetch>();
  const app = express();
  app.use("/api", createAuthRouter({ store, identify, fetchImpl: transport, clientId: "fixture-client", clientSecret }));
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(r => server.once("listening", r));
  const port = (server.address() as {port:number}).port;
  const call = (path: string, body?: object, cookie?: string) => fetch(`http://127.0.0.1:${port}/api${path}`, { method: body ? "POST" : "GET", redirect: "manual", headers: { Authorization: "Bearer fixture-identity", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { store, identify, transport, call };
}

it("binds data-only consent to the verified Firebase UID and preserves legacy access before unlink", async () => {
  const bare = await fixture("");
  const blocked = await bare.call("/auth/google/preserve", {});
  expect(blocked.status).toBe(503);
  expect((await blocked.json()).error).toMatch(/serverseitige Google-Verbindung/);
  const f = await fixture();
  const start = await f.call("/auth/google/start", {});
  expect(start.status).toBe(200);
  const url = new URL((await start.json()).url);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const forged = cookie.replace(/.$/, cookie.endsWith("a") ? "b" : "a");
  expect((await f.call(`/auth/google/callback?state=${url.searchParams.get("state")}&code=fixture`, undefined, forged)).status).toBe(400);
  expect(f.transport).not.toHaveBeenCalled();
  const idToken = `e30.${Buffer.from(JSON.stringify({sub:"data-only-google"})).toString("base64url")}.sig`;
  f.transport.mockResolvedValueOnce(Response.json({ access_token:"unused", refresh_token:"uid-refresh", id_token:idToken }));
  const callback = await f.call(`/auth/google/callback?state=${url.searchParams.get("state")}&code=fixture`, undefined, cookie);
  expect(callback.status).toBe(200);
  expect(await f.store.get("data-only-google")).toBeNull(); // not another workspace's legacy grant
  expect(await resolveOwnerGoogleKey({uid:"owner",googleSub:""}, f.store)).toBe(uidGrantKey("owner"));
  f.transport.mockResolvedValueOnce(Response.json({access_token:"uid-access",expires_in:3600}));
  expect(await (await f.call("/drive-token", {})).json()).toMatchObject({accessToken:"uid-access"});
  expect(String(f.transport.mock.calls.at(-1)![1]!.body)).toContain("refresh_token=uid-refresh");
  f.identify.mockResolvedValue({uid:"other-owner",googleSub:""});
  expect((await f.call("/drive-token", {})).status).toBe(403);

  f.identify.mockResolvedValue({uid:"legacy-owner",googleSub:"legacy-google"});
  await f.store.set("legacy-google", "legacy-refresh");
  expect((await f.call("/auth/google/preserve", {})).status).toBe(200);
  // An old cached client can still renew the legacy subject-keyed grant.
  await f.store.set("legacy-google", "renewed-by-legacy-client");
  f.transport.mockResolvedValueOnce(Response.json({access_token:"legacy-renewed"}));
  expect((await f.call("/drive-token", {})).status).toBe(200);
  expect(String(f.transport.mock.calls.at(-1)![1]!.body)).toContain("refresh_token=renewed-by-legacy-client");
  f.identify.mockResolvedValue({uid:"legacy-owner",googleSub:""});
  f.transport.mockResolvedValueOnce(Response.json({access_token:"after-unlink"}));
  expect(await (await f.call("/drive-token", {})).json()).toMatchObject({accessToken:"after-unlink"});
  expect(await f.store.get("legacy-google")).toBe("renewed-by-legacy-client"); // old jobs/clients still work
});

async function consent(f: Awaited<ReturnType<typeof fixture>>, subject: string, refreshToken: string) {
  const start = await f.call("/auth/google/start", {});
  const url = new URL((await start.json()).url);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const idToken = `e30.${Buffer.from(JSON.stringify({sub:subject})).toString("base64url")}.sig`;
  f.transport.mockResolvedValueOnce(Response.json({access_token:"unused",refresh_token:refreshToken,id_token:idToken}));
  expect((await f.call(`/auth/google/callback?state=${url.searchParams.get("state")}&code=fixture`, undefined, cookie)).status).toBe(200);
}

it("R10-S1 never revokes a historical alias reassigned to another workspace", async () => {
  const f = await fixture();
  f.identify.mockResolvedValue({uid:"owner",googleSub:"google-G"});
  await consent(f, "google-G", "A-G-refresh");
  await f.call("/auth/google/preserve", {});
  f.identify.mockResolvedValue({uid:"owner",googleSub:""});
  await consent(f, "google-H", "A-H-refresh");
  f.identify.mockResolvedValue({uid:"owner-B",googleSub:"google-G"});
  await consent(f, "google-G", "B-G-refresh");
  f.identify.mockResolvedValue({uid:"owner",googleSub:""});
  f.transport.mockClear().mockImplementation(async () => new Response("", {status:200}));
  expect((await f.call("/auth/revoke", {})).status).toBe(200);
  expect(await f.store.get("google-G")).toBe("B-G-refresh");
  expect(await f.store.get(uidGrantKey("owner-B"))).toBe("B-G-refresh");
  expect(f.transport.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)).get("token"))).toEqual(["A-H-refresh"]);
});

const deferred = <T,>() => { let resolve!: (value:T)=>void; const promise = new Promise<T>(r => {resolve=r;}); return {promise,resolve}; };

it("R10-S2 fences deferred legacy adoption after partial revoke", async () => {
  const f = await fixture();
  f.identify.mockResolvedValue({uid:"owner",googleSub:"google-G"});
  await f.store.set("google-G", "R1");
  await f.call("/auth/google/preserve", {});
  await f.store.set("google-G", "R2");
  const entered = deferred<void>(); const release = deferred<void>();
  // The original store has only get; the repaired store exposes versioned read.
  const method = "read" in f.store ? "read" : "get";
  const original = (f.store as any)[method].bind(f.store);
  let paused = false;
  vi.spyOn(f.store as any, method).mockImplementation(async (key: string) => {
    const value = await original(key);
    if (key === "google-G" && !paused) { paused=true; entered.resolve(); await release.promise; }
    return value;
  });
  const mint = f.call("/drive-token", {});
  await entered.promise;
  f.transport.mockRejectedValue(Error("provider unavailable"));
  const revoke = await f.call("/auth/revoke", {});
  expect(await revoke.json()).toMatchObject({revoked:false,localDisconnected:true});
  release.resolve();
  await mint;
  expect(await f.store.get(uidGrantKey("owner"))).toBeNull();
  expect(await f.store.get("google-G")).toBeNull();
  expect((await f.call("/drive-token", {})).status).toBe(403);
});

it.each(["uid", "legacy"])("R10-L2 keeps a fresh %s reconnect when an old refresh returns invalid_grant", async kind => {
  const f = await fixture();
  f.identify.mockResolvedValue({uid:"owner",googleSub:kind === "legacy" ? "google-G" : ""});
  const key = kind === "legacy" ? "google-G" : uidGrantKey("owner");
  await f.store.set(key, "R1");
  const entered = deferred<void>(); const failed = deferred<Response>();
  f.transport.mockImplementationOnce(async () => {entered.resolve(); return failed.promise;});
  const mint = f.call("/drive-token", {});
  await entered.promise;
  if (kind === "uid") await consent(f, "google-H", "R2");
  else await f.store.set(key, "R2"); // cached subject-only reconnect
  failed.resolve(Response.json({error:"invalid_grant"}, {status:400}));
  expect((await mint).status).toBe(403);
  expect(await f.store.get(key)).toBe("R2");
});

it("R10-S1 refuses stale revocation if the alias is replaced after its snapshot", async () => {
  const f=await fixture();
  f.identify.mockResolvedValue({uid:"owner",googleSub:"google-G"});
  await consent(f,"google-G","A-G-refresh");
  const entered=deferred<void>();const release=deferred<void>();
  const read=f.store.read!.bind(f.store);let paused=false;
  vi.spyOn(f.store,"read").mockImplementation(async key=>{
    const value=await read(key);
    if(key==="google-G"&&!paused){paused=true;entered.resolve();await release.promise;}
    return value;
  });
  const revoke=f.call("/auth/revoke",{});
  await entered.promise;
  f.identify.mockResolvedValue({uid:"owner-B",googleSub:"google-G"});
  await consent(f,"google-G","B-G-refresh");
  f.transport.mockClear();
  release.resolve();
  const response=await revoke;
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({revoked:false,localDisconnected:false});
  expect(await f.store.get("google-G")).toBe("B-G-refresh");
  expect(f.transport).not.toHaveBeenCalled();
});

it("does not claim local disconnection when a new consent completes during failed provider revoke", async () => {
  const f=await fixture();
  await consent(f,"google-H","R1");
  const entered=deferred<void>();const failed=deferred<Response>();
  f.transport.mockImplementationOnce(async()=>{entered.resolve();return failed.promise;});
  const revoke=f.call("/auth/revoke",{});
  await entered.promise;
  await consent(f,"google-H","R2");
  failed.resolve(new Response("",{status:500}));
  const response=await revoke;
  expect(await response.json()).toMatchObject({revoked:false,localDisconnected:false});
  expect(await f.store.get(uidGrantKey("owner"))).toBe("R2");
});

it("preserves a true cached-client renewal before unlink without needing a prior mint", async () => {
  const f=await fixture();
  f.identify.mockResolvedValue({uid:"owner",googleSub:"google-G"});
  await f.store.set("google-G","R1");
  await f.call("/auth/google/preserve",{});
  await f.store.set("google-G","R2");
  expect((await f.call("/auth/google/preserve",{})).status).toBe(200);
  expect(await f.store.get(uidGrantKey("owner"))).toBe("R2");
});

it("rejects a delayed successful mint after its grant was locally revoked", async () => {
  const f=await fixture();await consent(f,"google-H","R1");
  const entered=deferred<void>();const refreshed=deferred<Response>();
  f.transport.mockImplementationOnce(async()=>{entered.resolve();return refreshed.promise;});
  const mint=f.call("/drive-token",{});await entered.promise;
  f.transport.mockResolvedValueOnce(new Response("",{status:500}));
  expect(await (await f.call("/auth/revoke",{})).json()).toMatchObject({localDisconnected:true});
  refreshed.resolve(Response.json({access_token:"stale-access"}));
  expect((await mint).status).toBe(403);
});

it("fences a bound consent exchange already in flight when revoke removes the grant", async () => {
  const f=await fixture();await consent(f,"google-H","R1");
  const start=await f.call("/auth/google/start",{});
  const url=new URL((await start.json()).url);const cookie=start.headers.get("set-cookie")!.split(";")[0];
  const entered=deferred<void>();const exchanged=deferred<Response>();
  f.transport.mockImplementationOnce(async()=>{entered.resolve();return exchanged.promise;});
  const callback=f.call(`/auth/google/callback?state=${url.searchParams.get("state")}&code=pending`,undefined,cookie);
  await entered.promise;
  f.transport.mockResolvedValueOnce(new Response("",{status:500}));
  expect(await (await f.call("/auth/revoke",{})).json()).toMatchObject({localDisconnected:true});
  const idToken=`e30.${Buffer.from(JSON.stringify({sub:"google-H"})).toString("base64url")}.sig`;
  exchanged.resolve(Response.json({refresh_token:"R2",id_token:idToken}));
  expect((await callback).status).toBe(400);
  expect(await f.store.get(uidGrantKey("owner"))).toBeNull();
});

it("rejects an older bound flow whose callback arrives only after local revocation", async () => {
  const f = await fixture(); await consent(f, "google-H", "R1");
  const start = await f.call("/auth/google/start", {});
  const url = new URL((await start.json()).url);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  f.transport.mockResolvedValueOnce(new Response("", { status: 500 }));
  expect(await (await f.call("/auth/revoke", {})).json()).toMatchObject({ localDisconnected: true });
  const contained = await f.store.read!(uidGrantKey("owner"));
  f.transport.mockReset().mockResolvedValueOnce(Response.json({ refresh_token: "old-flow-R2", id_token: `e30.${Buffer.from(JSON.stringify({sub:"google-H"})).toString("base64url")}.sig` }));
  expect((await f.call(`/auth/google/callback?state=${url.searchParams.get("state")}&code=old-flow`, undefined, cookie)).status).toBe(400);
  expect(await f.store.read!(uidGrantKey("owner"))).toEqual(contained);
  expect(f.transport).not.toHaveBeenCalled();
  f.transport.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(contained.revokedAt! + 1);
  await consent(f, "google-H", "fresh-flow-R3");
  expect(await f.store.get(uidGrantKey("owner"))).toBe("fresh-flow-R3");
});

it.each(["owned", "initially missing UID", "initially missing UID and subject", "remove/recreate same token"])("R10-S2 rejects unbound exchange across revoke: %s", async kind => {
  const f=await fixture();f.identify.mockResolvedValue({uid:"owner",googleSub:"google-G"});
  if(kind!=="initially missing UID and subject")await f.store.set("google-G","R1");
  if(kind==="owned"||kind==="remove/recreate same token")await f.call("/auth/google/preserve",{});
  const start=await f.call("/auth/google/start");
  const state=new URL(start.headers.get("location")!).searchParams.get("state");
  const cookie=start.headers.get("set-cookie")!.split(";")[0];
  const entered=deferred<void>();const exchanged=deferred<Response>();
  f.transport.mockImplementationOnce(async()=>{entered.resolve();return exchanged.promise;});
  const callback=f.call(`/auth/google/callback?state=${state}&code=pending`,undefined,cookie);
  await entered.promise;
  f.transport.mockResolvedValueOnce(new Response("",{status:500}));
  expect(await (await f.call("/auth/revoke",{})).json()).toMatchObject({revoked:false,localDisconnected:true});
  if(kind==="remove/recreate same token")await f.store.set("google-G","R1");
  const before=await f.store.read!("google-G");
  const idToken=`e30.${Buffer.from(JSON.stringify({sub:"google-G"})).toString("base64url")}.sig`;
  exchanged.resolve(Response.json({refresh_token:"stale-R2",id_token:idToken}));
  expect((await callback).status).toBe(400);
  expect(await f.store.read!("google-G")).toEqual(before);
  expect(await f.store.get(uidGrantKey("owner"))).toBeNull();
});

it("does not re-adopt the same invalid UID credential from its owned legacy alias", async () => {
  const f=await fixture();f.identify.mockResolvedValue({uid:"owner",googleSub:"google-G"});
  await consent(f,"google-G","invalid-R1");
  f.transport.mockResolvedValueOnce(Response.json({error:"invalid_grant"},{status:400}));
  expect((await f.call("/drive-token",{})).status).toBe(403);
  f.transport.mockClear().mockImplementation(async () => Response.json({access_token:"should-not-be-minted"}));
  expect((await f.call("/drive-token",{})).status).toBe(403);
  expect(f.transport).not.toHaveBeenCalled();
  expect(await f.store.get("google-G")).toBeNull();
});

it("accepts fresh unbound first consent after disconnecting an absent grant", async () => {
  const f=await fixture();f.identify.mockResolvedValue({uid:"owner",googleSub:"google-G"});
  expect(await (await f.call("/auth/revoke",{})).json()).toMatchObject({localDisconnected:true});
  const cutoff=(await f.store.read!("google-G")).revokedAt!;
  vi.spyOn(Date,"now").mockReturnValue(cutoff+1);
  const start=await f.call("/auth/google/start");
  const state=new URL(start.headers.get("location")!).searchParams.get("state");
  const cookie=start.headers.get("set-cookie")!.split(";")[0];
  const idToken=`e30.${Buffer.from(JSON.stringify({sub:"google-G"})).toString("base64url")}.sig`;
  f.transport.mockResolvedValueOnce(Response.json({refresh_token:"fresh-R1",id_token:idToken}));
  expect((await f.call(`/auth/google/callback?state=${state}&code=fresh`,undefined,cookie)).status).toBe(200);
  expect(await resolveOwnerGoogleKey({uid:"owner",googleSub:"google-G"},f.store)).toBe(uidGrantKey("owner"));
  expect(await f.store.get(uidGrantKey("owner"))).toBe("fresh-R1");
});

it.each(["tampered start", "unsigned old state", "expired"])("rejects unauthenticated unbound flow evidence: %s", async kind => {
  const f=await fixture();const start=await f.call("/auth/google/start");
  const state=new URL(start.headers.get("location")!).searchParams.get("state");
  const original=start.headers.get("set-cookie")!.split(";")[0];
  const parts=decodeURIComponent(original.split("=")[1]).split(".");
  const context=JSON.parse(Buffer.from(parts[2],"base64url").toString());
  expect(context).toMatchObject({startedAt:expect.any(Number),expiresAt:expect.any(Number)});
  if(kind==="tampered start")parts[2]=Buffer.from(JSON.stringify({...context,startedAt:context.startedAt+1})).toString("base64url");
  if(kind==="unsigned old state")parts.splice(2);
  if(kind==="expired")vi.spyOn(Date,"now").mockReturnValue(context.expiresAt+1);
  const cookie=`cheatmeet_oauth_state=${encodeURIComponent(parts.join("."))}`;
  expect((await f.call(`/auth/google/callback?state=${state}&code=not-exchanged`,undefined,cookie)).status).toBe(400);
  expect(f.transport).not.toHaveBeenCalled();
});

it("never confirms provider revocation after transport, timeout, HTTP or already-invalid failures while containing legacy grants", async () => {
  const f = await fixture();
  f.identify.mockResolvedValue({uid:"owner",googleSub:"legacy-google"});
  for (const result of ["network", "timeout", 500, 400, 200] as const) {
    await f.store.set("legacy-google", "legacy-refresh");
    await f.call("/auth/google/preserve", {});
    if (result === "network") f.transport.mockRejectedValueOnce(Error("private-provider-diagnostic"));
    else if (result === "timeout") {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(ms => { expect(ms).toBe(8_000); return timeout(1); });
      f.transport.mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {once:true});
      }));
    }
    else f.transport.mockResolvedValueOnce(result === 400 ? Response.json({error:"invalid_token"},{status:400}) : new Response("",{status:result}));
    const response = await f.call("/auth/revoke", {});
    const body = await response.json();
    expect(body).toMatchObject({revoked: result === 200, localDisconnected:true});
    if (result !== 200) {
      expect(response.ok).toBe(false); // cached clients must not mistake partial containment for success
      expect(body.warning).toMatch(/Google-Konto/);
      expect(JSON.stringify(body)).not.toContain("private-provider-diagnostic");
    }
    expect(await f.store.get("legacy-google")).toBeNull();
    expect(await f.store.get(uidGrantKey("owner"))).toBeNull();
  }
});
