import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { memoryDocStore } from "../server/mcp/docStore";
import { createLiveRouter } from "../server/mcp/live";
import type { Grant } from "../server/mcp/oauth";
import type { LiveDoc, LivePush } from "../shared/mcp";
import { readLive } from "../shared/mcp";

let server: Server;
let base: string;
let clock: number;
let grants: ReturnType<typeof memoryDocStore<Grant>>;
let live: ReturnType<typeof memoryDocStore<LiveDoc>>;

const grant = (uid: string, scopes: string[], status: Grant["status"] = "active", id = `${uid}-${scopes.join("")}-${status}`): Grant => ({
  id, uid, googleSub: `g-${uid}`, clientId: "c", clientName: "Test", redirectHost: "x", scopes: scopes as any, status, createdAt: clock,
});
const addGrant = (g: Grant) => grants.mutate(g.id, () => g, { ownerKey: g.uid, expireAt: new Date(clock + 3_600_000) });
const turn = (id: string, startMs: number, text: string, final = true) => ({ id, startMs, endMs: startMs + 900, speaker: "mic:0:A", text, final });
const push = (seq: number, extra: Partial<LivePush> = {}): LivePush => ({
  seq, startedAt: "2030-06-01T11:00:00.000Z", languages: ["de"], state: "recording", upsert: [], remove: [], speakerNames: {}, ...extra,
});

beforeEach(async () => {
  clock = Date.UTC(2030, 5, 1, 12, 0, 0);
  grants = memoryDocStore<Grant>();
  live = memoryDocStore<LiveDoc>();
  const app = express();
  app.use("/api", createLiveRouter({
    grants, live, now: () => clock,
    verifyToken: async (token) => {
      if (!["alice", "bob"].includes(token)) throw new Error("bad");
      return token;
    },
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/live`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const send = (reportId: string, body: unknown, token = "alice", method = "PUT") =>
  fetch(`${base}/${reportId}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === "DELETE" ? undefined : JSON.stringify(body),
  });
const sent = async (reportId: string, body: LivePush | { probe: true }, token = "alice") => {
  const response = await send(reportId, body, token);
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const tick = () => { clock += 1000; };

describe("who may listen", () => {
  it("stores nothing, and says so, while no assistant holds a live grant", async () => {
    const result = await sent("m1", push(1, { reset: true, upsert: [turn("1", 0, "geheim")] }));
    expect(result).toMatchObject({ status: 403, body: { listening: false } });
    expect(await live.listByOwner("alice")).toEqual([]);
  });
  it("does not count a read-only or a revoked grant", async () => {
    await addGrant(grant("alice", ["meetings:read"]));
    await addGrant(grant("alice", ["meetings:live"], "revoked"));
    expect((await sent("m1", push(1, { reset: true }))).status).toBe(403);
    expect(await live.listByOwner("alice")).toEqual([]);
  });
  it("answers a probe without writing anything", async () => {
    expect(await sent("m1", { probe: true })).toMatchObject({ status: 200, body: { listening: false } });
    await addGrant(grant("alice", ["meetings:live"]));
    clock += 11_000;
    expect(await sent("m1", { probe: true })).toMatchObject({ status: 200, body: { listening: true } });
    expect(await live.listByOwner("alice")).toEqual([]);
  });
  it("notices a revoked grant within the cache window", async () => {
    const g = grant("alice", ["meetings:live"]);
    await addGrant(g);
    tick();
    expect((await sent("m1", push(1, { reset: true }))).status).toBe(200);
    await grants.mutate(g.id, (cur) => (cur ? { ...cur, status: "revoked" } : undefined), { ownerKey: "alice", expireAt: new Date(clock + 1000) });
    clock += 11_000;
    expect(await sent("m1", push(2))).toMatchObject({ status: 403, body: { listening: false } });
  });
  it("keeps other users' grants out of the decision", async () => {
    await addGrant(grant("bob", ["meetings:live"]));
    expect((await sent("m1", push(1, { reset: true }), "alice")).status).toBe(403);
  });
});

describe("authentication and input", () => {
  beforeEach(async () => { await addGrant(grant("alice", ["meetings:live"])); await addGrant(grant("bob", ["meetings:live"])); });
  it("needs a valid Firebase identity", async () => {
    expect((await send("m1", push(1, { reset: true }), "")).status).toBe(401);
    expect((await send("m1", push(1, { reset: true }), "mallory")).status).toBe(401);
  });
  it("rejects malformed meeting ids and bodies", async () => {
    for (const id of ["a b", "x".repeat(101), "a%2Fb", "..", "a.b"]) {
      const r = await send(id, push(1, { reset: true }));
      expect([400, 404], id).toContain(r.status);
    }
    for (const bad of [{}, { seq: 0 }, { seq: "1" }, push(1, { state: "weird" as any }), push(1, { upsert: [{ id: 1 }] as any }), push(1, { reset: true, upsert: [turn("1", 0, "x".repeat(20_001))] })]) {
      tick();
      expect((await sent("m1", bad as any)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
  });
  it("refuses a body over 1 MB", async () => {
    tick();
    const huge = push(1, { reset: true, upsert: Array.from({ length: 200 }, (_, i) => turn(`t${i}`, i, "x".repeat(9000))) });
    expect((await sent("m1", huge)).status).toBe(413);
  });
});

describe("pushing", () => {
  beforeEach(async () => { await addGrant(grant("alice", ["meetings:live"])); await addGrant(grant("bob", ["meetings:live"])); });
  it("stores a reset push and lets the assistant read it in the saved-transcript format", async () => {
    tick();
    const result = await sent("m1", push(1, { reset: true, upsert: [turn("1", 0, "Guten Morgen"), turn("2", 5000, "wir starten", false)], speakerNames: { "mic:0:A": "Anna" } }));
    expect(result).toMatchObject({ status: 200, body: { seq: 1, listening: true } });
    const [doc] = await live.listByOwner("alice");
    expect(doc.reportId).toBe("m1");
    expect(readLive(doc, {}, clock).text).toContain("[0:00] (Mikrofon · Anna) Guten Morgen");
  });
  it("is idempotent for a replay, and asks for a resync when a push was lost", async () => {
    tick();
    await sent("m1", push(1, { reset: true, upsert: [turn("1", 0, "a")] }));
    tick();
    expect(await sent("m1", push(1, { upsert: [turn("9", 1, "zzz")] }))).toMatchObject({ status: 200, body: { seq: 1 } });
    expect((await live.listByOwner("alice"))[0].turns).toHaveLength(1);
    tick();
    expect(await sent("m1", push(3))).toMatchObject({ status: 409, body: { resync: true } });
    tick();
    expect(await sent("m1", push(3, { reset: true, upsert: [turn("7", 0, "neu")] }))).toMatchObject({ status: 200 });
    expect((await live.listByOwner("alice"))[0].turns.map((t) => t.id)).toEqual(["7"]);
  });
  it("throttles a client that pushes faster than every 700 ms", async () => {
    tick();
    await sent("m1", push(1, { reset: true }));
    clock += 100;
    const fast = await send("m1", push(2));
    expect(fast.status).toBe(429);
    expect(Number(fast.headers.get("retry-after"))).toBeGreaterThan(0);
    clock += 700;
    expect((await send("m1", push(2))).status).toBe(200);
  });
  it("allows at most five running meetings per user", async () => {
    for (let i = 0; i < 5; i++) { tick(); expect((await sent(`m${i}`, push(1, { reset: true }))).status).toBe(200); }
    tick();
    expect((await sent("m5", push(1, { reset: true }))).status).toBe(429);
    tick();
    expect((await sent("m0", push(2))).status).toBe(200);
  });
  it("keeps two users' meetings apart even when they use the same meeting id", async () => {
    tick();
    await sent("same", push(1, { reset: true, upsert: [turn("1", 0, "Alices Text")] }), "alice");
    tick();
    await sent("same", push(1, { reset: true, upsert: [turn("1", 0, "Bobs Text")] }), "bob");
    const alice = (await live.listByOwner("alice"))[0];
    const bob = (await live.listByOwner("bob"))[0];
    expect(alice.turns[0].text).toBe("Alices Text");
    expect(bob.turns[0].text).toBe("Bobs Text");
  });
  it("marks a meeting ended, and lets it expire 30 minutes later", async () => {
    tick();
    await sent("m1", push(1, { reset: true }));
    tick();
    await sent("m1", push(2, { state: "ended" }));
    expect((await live.listByOwner("alice"))[0].state).toBe("ended");
    // Wall-clock expiry is enforced by the store with Date.now(); the server sets the deadline.
    const doc = await live.get("alice:m1");
    expect(doc).not.toBeNull();
  });
  it("deletes on request and only for the owner", async () => {
    tick();
    await sent("m1", push(1, { reset: true }));
    expect((await send("m1", undefined, "bob", "DELETE")).status).toBe(200);
    expect(await live.get("alice:m1")).not.toBeNull();
    expect((await send("m1", undefined, "alice", "DELETE")).status).toBe(200);
    expect(await live.get("alice:m1")).toBeNull();
  });
});
