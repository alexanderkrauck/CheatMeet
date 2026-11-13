import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SignJWT } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mcpConfig } from "../server/mcp/config";
import { memoryDocStore } from "../server/mcp/docStore";
import type { Grant } from "../server/mcp/oauth";
import { createMcpRouter, type McpDeps } from "../server/mcp/index";
import { TranscriptError, decodeFields, type IndexEntry } from "../server/mcp/meetings";
import type { LiveDoc } from "../shared/mcp";

const ISSUER = "https://cheatmeet.example.com";
const config = mcpConfig({ MCP_PUBLIC_URL: ISSUER, MCP_TOKEN_SECRET: "s".repeat(48) })!;
let clock = Date.UTC(2030, 5, 1, 12, 0, 0);
let server: Server;
let base: string;
let grants: ReturnType<typeof memoryDocStore<Grant>>;
let live: ReturnType<typeof memoryDocStore<LiveDoc>>;
let entries: Record<string, IndexEntry[]>;
let files: Record<string, string>;
let driveOwner: Record<string, Set<string>>;
let driveMode: "ok" | "revoked" | "down" = "ok";
let indexDown = false;
let reads = 0;

const entry = (id: string, date: string, extra: Partial<IndexEntry> = {}): IndexEntry => ({
  id, date, title: `Meeting ${id}`, summary: `Zusammenfassung ${id}`, todos: [], takeaways: [], participants: [],
  status: "completed", transcriptChars: 100, driveTranscriptId: `file-${id}`, ...extra,
});
const FRONT = (id: string) => `---\nschema: cheatmeet.meeting/1\nid: ${id}\n---\n`;

beforeEach(async () => {
  clock = Date.UTC(2030, 5, 1, 12, 0, 0);
  grants = memoryDocStore<Grant>();
  live = memoryDocStore<LiveDoc>();
  driveMode = "ok";
  indexDown = false;
  reads = 0;
  entries = {
    alice: [
      entry("a1", "2030-05-30T09:00:00.000Z", { title: "Budgetrunde", summary: "Das Budget wurde besprochen.", participants: ["Anna"], todos: [{ text: "Angebot senden", done: false }] as any }),
      entry("a2", "2030-05-20T09:00:00.000Z", { title: "Kickoff" }),
      entry("a3", "2030-05-10T09:00:00.000Z", { title: "Ohne Transkript", transcriptChars: 0, driveTranscriptId: undefined }),
      entry("a4", "kaputt", { title: "Kaputtes Datum" }),
    ],
    bob: [entry("b1", "2030-05-29T09:00:00.000Z", { title: "Bobs Geheimnis", summary: "streng vertraulich" })],
  };
  files = {
    "file-a1": FRONT("a1") + Array.from({ length: 40 }, (_, i) => `[0:${String(i).padStart(2, "0")}] (${i % 2 ? "Ben" : "Anna"}) ${i === 0 ? "Wir reden über das Budget und den Zeitplan." : `Beitrag Nummer ${i} zum Thema Budget und Planung.`}`).join("\n\n"),
    "file-a2": FRONT("a2") + "[0:01] (Anna) Willkommen zum Kickoff.",
    "file-b1": FRONT("b1") + "[0:01] (Bob) Passwort ist hunter2.",
  };
  driveOwner = { "g-alice": new Set(["file-a1", "file-a2"]), "g-bob": new Set(["file-b1"]) };

  const deps: McpDeps = {
    config,
    grants,
    live,
    now: () => clock,
    index: { list: async (uid) => { if (indexDown) throw new Error("index down"); return entries[uid] ?? []; } },
    transcripts: {
      readMeeting: async (uid: string, meeting: IndexEntry) => {
        reads++;
        if (!entries[uid]?.some(e => e.id === meeting.id)) throw new TranscriptError('not_found');
        const fileId = (meeting as any).home?.transcriptId;
        if (!fileId || files[fileId] === undefined) throw new TranscriptError('not_found');
        return files[fileId];
      },
      read: async (googleSub, fileId) => {
        reads++;
        if (driveMode === "revoked") throw new TranscriptError("drive_revoked");
        if (driveMode === "down") throw new TranscriptError("drive_unavailable");
        if (!driveOwner[googleSub]?.has(fileId) || files[fileId] === undefined) throw new TranscriptError("not_found");
        return files[fileId];
      },
    },
  };
  const app = express();
  app.use(createMcpRouter(deps));
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function mint(uid: string, scopes: string[] = ["meetings:read", "meetings:live"], googleSub = `g-${uid}`) {
  const id = `grant-${uid}-${Math.random().toString(36).slice(2)}`;
  await grants.mutate(id, () => ({
    id, uid, googleSub, clientId: "c", clientName: "Test", redirectHost: "x", scopes: scopes as any, status: "active", createdAt: clock,
  }), { ownerKey: uid, expireAt: new Date(clock + 3_600_000) });
  const seconds = Math.floor(clock / 1000);
  return new SignJWT({ gid: id, scope: scopes.join(" "), client_id: "c" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).setSubject(uid).setIssuer(ISSUER).setAudience(config.resource)
    .setIssuedAt(seconds).setExpirationTime(seconds + 3600).sign(config.secret);
}
async function connect(token: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { authProvider: { token: async () => token } }));
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  return { text, isError: Boolean(result.isError), result };
};
const data = (text: string) => JSON.parse(text);

it('reads and searches OneDrive meetings for a Microsoft-only workspace without Google identity', async()=>{
  entries.alice=[entry('ms1','2030-05-30T09:00:00Z',{driveTranscriptId:undefined,home:{provider:'microsoft',connectionId:'conn',driveId:'drive',rootId:'root',rootName:'Meetings',folderId:'folder',transcriptId:'ms-transcript'}} as any)];
  files['ms-transcript']=FRONT('ms1')+'[0:01] (Anna) Microsoft Budgetentscheid.';
  const client=await connect(await mint('alice',['meetings:read'],''));
  const transcript=await call(client,'get_transcript',{meeting_id:'ms1'});
  expect(transcript.isError).toBe(false);
  expect(data(transcript.text).text).toContain('Microsoft Budgetentscheid');
  const searched=data((await call(client,'search_meetings',{query:'Budgetentscheid'})).text);
  expect(searched.hits).toEqual(expect.arrayContaining([expect.objectContaining({meeting_id:'ms1',where:'transcript'})]));
  expect((await call(await connect(await mint('bob')),'get_transcript',{meeting_id:'ms1'})).isError).toBe(true);
});

describe("firestore value decoding", () => {
  it("decodes every value type the report index uses", () => {
    expect(decodeFields({
      s: { stringValue: "x" }, i: { integerValue: "42" }, d: { doubleValue: 1.5 }, b: { booleanValue: true }, n: { nullValue: null },
      t: { timestampValue: "2030-01-01T00:00:00Z" },
      a: { arrayValue: { values: [{ stringValue: "p" }, { integerValue: "1" }] } }, e: { arrayValue: {} },
      m: { mapValue: { fields: { k: { stringValue: "v" } } } },
    })).toEqual({ s: "x", i: 42, d: 1.5, b: true, n: null, t: "2030-01-01T00:00:00Z", a: ["p", 1], e: [], m: { k: "v" } });
  });
  it("tolerates missing and unknown shapes", () => {
    expect(decodeFields(undefined)).toEqual({});
    expect(decodeFields({ x: { weirdValue: 1 } as any })).toEqual({ x: null });
  });
});

describe("authentication", () => {
  it("answers 401 with a pointer to the resource metadata when there is no token", async () => {
    const response = await fetch(`${base}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${config.metadataUrl}"`);
  });
  it("rejects a revoked grant on the very next call", async () => {
    const token = await mint("alice");
    const client = await connect(token);
    await call(client, "list_meetings");
    for (const [id] of Object.entries((await grants.listByOwner("alice")))) void id;
    const [grant] = await grants.listByOwner("alice");
    await grants.mutate(grant.id, (cur) => (cur ? { ...cur, status: "revoked" } : undefined), { ownerKey: "alice", expireAt: new Date(clock + 1000) });
    await expect(call(client, "list_meetings")).rejects.toThrow();
  });
  it("rejects a token issued for another resource", async () => {
    const seconds = Math.floor(clock / 1000);
    const foreign = await new SignJWT({ gid: "x", scope: "meetings:read" }).setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setSubject("alice").setIssuer(ISSUER).setAudience("https://other.example/api/mcp").setIssuedAt(seconds).setExpirationTime(seconds + 600).sign(config.secret);
    const response = await fetch(`${base}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${foreign}` }, body: "{}" });
    expect(response.status).toBe(401);
  });
  it("refuses a browser Origin that is not allowed, and lets requests without one through", async () => {
    const token = await mint("alice");
    const evil = await fetch(`${base}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Authorization: `Bearer ${token}` }, body: "{}" });
    expect(evil.status).toBe(403);
    const client = await connect(token);
    expect((await call(client, "list_meetings")).isError).toBe(false);
  });
  it("serves 2025-era clients statelessly, with no session header", async () => {
    const token = await mint("alice");
    const response = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });
  it("is switched off with a clear message when the feature is not configured", async () => {
    const app = express();
    app.use(createMcpRouter(null as any));
    const off = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const response = await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/api/mcp`, { method: "POST" });
    await new Promise<void>((resolve) => off.close(() => resolve()));
    expect(response.status).toBe(503);
    expect((await response.json() as any).error).toMatch(/nicht eingerichtet/);
  });
});

describe("tool list", () => {
  it("offers only what the granted scopes allow, and marks every tool read-only", async () => {
    const both = await (await connect(await mint("alice"))).listTools();
    expect(both.tools.map((t) => t.name)).toEqual(["list_meetings", "get_meeting", "get_transcript", "search_meetings", "list_live_meetings", "get_live_transcript"]);
    for (const tool of both.tools) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(tool.description!.length, tool.name).toBeGreaterThan(40);
    }
    const readOnly = await (await connect(await mint("alice", ["meetings:read"]))).listTools();
    expect(readOnly.tools.map((t) => t.name)).toEqual(["list_meetings", "get_meeting", "get_transcript", "search_meetings"]);
    const liveOnly = await (await connect(await mint("alice", ["meetings:live"]))).listTools();
    expect(liveOnly.tools.map((t) => t.name)).toEqual(["list_live_meetings", "get_live_transcript"]);
  });
});

describe("list_meetings", () => {
  it("lists newest first and tolerates an unparseable date", async () => {
    const { text } = await call(await connect(await mint("alice")), "list_meetings");
    const out = data(text);
    expect(out.meetings.map((m: any) => m.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(out.meetings[0]).toMatchObject({ id: "a1", title: "Budgetrunde", has_transcript: true, participants: ["Anna"] });
    expect(out.meetings[2].has_transcript).toBe(false);
    expect(out.next_cursor).toBeNull();
  });
  it("filters by date and pages with a stable cursor", async () => {
    const client = await connect(await mint("alice"));
    const ranged = data((await call(client, "list_meetings", { from: "2030-05-15", to: "2030-05-30" })).text);
    expect(ranged.meetings.map((m: any) => m.id)).toEqual(["a1", "a2"]);
    const first = data((await call(client, "list_meetings", { limit: 2 })).text);
    expect(first.meetings.map((m: any) => m.id)).toEqual(["a1", "a2"]);
    const second = data((await call(client, "list_meetings", { limit: 2, cursor: first.next_cursor })).text);
    expect(second.meetings.map((m: any) => m.id)).toEqual(["a3", "a4"]);
    expect(second.next_cursor).toBeNull();
  });
  it("never shows another user's meetings", async () => {
    const alice = data((await call(await connect(await mint("alice")), "list_meetings")).text);
    const bob = data((await call(await connect(await mint("bob")), "list_meetings")).text);
    expect(JSON.stringify(alice)).not.toContain("Bobs Geheimnis");
    expect(bob.meetings.map((m: any) => m.id)).toEqual(["b1"]);
  });
  it("reports an unreachable index as a tool error, not as an empty archive", async () => {
    indexDown = true;
    const { isError, text } = await call(await connect(await mint("alice")), "list_meetings");
    expect(isError).toBe(true);
    expect(text).toMatch(/nicht erreichbar/);
  });
});

describe("get_meeting and get_transcript", () => {
  it("returns the details of one meeting", async () => {
    const out = data((await call(await connect(await mint("alice")), "get_meeting", { meeting_id: "a1" })).text);
    expect(out).toMatchObject({ id: "a1", summary: "Das Budget wurde besprochen.", todos: [{ text: "Angebot senden" }] });
    expect(out.transcript_chars).toBeGreaterThan(0);
  });
  it("does not know meetings of other users, even by exact id", async () => {
    const client = await connect(await mint("alice"));
    for (const name of ["get_meeting", "get_transcript"]) {
      const { isError, text } = await call(client, name, { meeting_id: "b1" });
      expect(isError, name).toBe(true);
      expect(text, name).not.toContain("hunter2");
      expect(text, name).toMatch(/nicht gefunden/);
    }
  });
  it("cannot be fooled into reading another user's Drive file through the id", async () => {
    entries.alice.push(entry("evil", "2030-05-01T00:00:00.000Z", { driveTranscriptId: "file-b1" }));
    const { isError, text } = await call(await connect(await mint("alice")), "get_transcript", { meeting_id: "evil" });
    expect(isError).toBe(true);
    expect(text).not.toContain("hunter2");
  });
  it("returns the transcript without the front matter, and pages it", async () => {
    const client = await connect(await mint("alice"));
    const whole = data((await call(client, "get_transcript", { meeting_id: "a1" })).text);
    expect(whole.text).toContain("[0:00] (Anna) Wir reden über das Budget");
    expect(whole.text).not.toContain("schema:");
    expect(whole.next_offset).toBeNull();
    const first = data((await call(client, "get_transcript", { meeting_id: "a1", max_chars: 1000 })).text);
    expect(first.text.length).toBeLessThanOrEqual(1000);
    expect(first.next_offset).toBeGreaterThan(0);
    expect(first.text.endsWith("\n")).toBe(true);
    const rest = data((await call(client, "get_transcript", { meeting_id: "a1", offset: first.next_offset })).text);
    expect(first.text + rest.text).toBe(whole.text);
    expect(first.total_chars).toBe(whole.total_chars);
  });
  it("tells apart: no transcript, not in Drive, Drive access revoked, Drive unreachable", async () => {
    const client = await connect(await mint("alice"));
    expect((await call(client, "get_transcript", { meeting_id: "a3" })).text).toMatch(/kein Transkript/);
    entries.alice.push(entry("a5", "2030-05-02T00:00:00.000Z", { driveTranscriptId: undefined, transcriptChars: 500 }));
    expect((await call(client, "get_transcript", { meeting_id: "a5" })).text).toMatch(/noch nicht in Google Drive/);
    entries.alice.push(entry("gone", "2030-05-03T00:00:00.000Z", { driveTranscriptId: "file-gone" }));
    expect((await call(client, "get_transcript", { meeting_id: "gone" })).text).toMatch(/nicht (mehr )?in (Google )?Drive|nicht gefunden/i);
    driveMode = "revoked";
    const revoked = await call(client, "get_transcript", { meeting_id: "a1" });
    expect(revoked.isError).toBe(true);
    expect(revoked.text).toMatch(/Google-Drive-Zugriff.*entzogen/);
    driveMode = "down";
    const down = await call(client, "get_transcript", { meeting_id: "a2" });
    expect(down.isError).toBe(true);
    expect(down.text).toMatch(/Google Drive.*nicht erreichbar/);
  });
  it("rejects nonsense arguments before touching any data", async () => {
    const client = await connect(await mint("alice"));
    const before = reads;
    for (const args of [{ meeting_id: "a1", max_chars: 5_000_000 }, {}, { meeting_id: "a1", offset: -1 }]) {
      const result = await call(client, "get_transcript", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.text).toMatch(/validation|invalid|Input/i);
    }
    expect(reads).toBe(before);
  });
});

describe("search_meetings", () => {
  it("finds hits in titles, summaries and transcripts, and says where", async () => {
    const out = data((await call(await connect(await mint("alice")), "search_meetings", { query: "budget" })).text);
    const byId = Object.fromEntries(out.hits.map((h: any) => [h.meeting_id, h.where]));
    expect(byId.a1).toBeDefined();
    const wheres = out.hits.filter((h: any) => h.meeting_id === "a1").map((h: any) => h.where);
    expect(wheres).toEqual(expect.arrayContaining(["title", "transcript"]));
    expect(out.hits.every((h: any) => h.snippet.toLowerCase().includes("budget"))).toBe(true);
  });
  it("reports how much of the transcript archive it actually looked at", async () => {
    const out = data((await call(await connect(await mint("alice")), "search_meetings", { query: "kickoff" })).text);
    // a1 and a2 were searched; a4's file is gone from Drive, which is reported, not hidden.
    expect(out.transcript_coverage).toEqual({ searched: 2, total: 3, unavailable: 1, truncated: false });
    expect(out.hits.map((h: any) => h.meeting_id)).toContain("a2");
  });
  it("never searches other users' transcripts", async () => {
    const out = data((await call(await connect(await mint("alice")), "search_meetings", { query: "hunter2" })).text);
    expect(out.hits).toEqual([]);
  });
  it("reads each transcript only once while it stays unchanged", async () => {
    const client = await connect(await mint("alice"));
    await call(client, "search_meetings", { query: "willkommen" });
    const first = reads;
    await call(client, "search_meetings", { query: "zeitplan" });
    expect(reads).toBe(first);
    entries.alice[1] = { ...entries.alice[1], updatedAt: "2030-05-21T00:00:00.000Z" };
    await call(client, "search_meetings", { query: "willkommen" });
    expect(reads).toBe(first + 1);
  });
  it("refuses a query that is too short", async () => {
    const result = await call(await connect(await mint("alice")), "search_meetings", { query: "a" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/validation|invalid|Input/i);
  });
});

describe("live tools", () => {
  const liveDoc = (extra: Partial<LiveDoc> = {}): LiveDoc => ({
    seq: 3, startedAt: "2030-06-01T11:50:00.000Z", languages: ["de"], state: "recording", speakerNames: { "mic:0:A": "Anna" },
    updatedAt: clock, turns: [
      { id: "1", startMs: 0, endMs: 900, speaker: "mic:0:A", text: "Guten Morgen", final: true },
      { id: "2", startMs: 5000, endMs: 5900, speaker: "mic:0:A", text: "wir starten", final: false },
    ], ...extra,
  });
  const put = (uid: string, reportId: string, doc: LiveDoc) =>
    live.mutate(`${uid}:${reportId}`, () => ({ ...doc, reportId }), { ownerKey: uid, expireAt: new Date(clock + 3_600_000) });

  it("lists only the caller's active meetings", async () => {
    await put("alice", "m1", liveDoc());
    await put("bob", "m2", liveDoc());
    const out = data((await call(await connect(await mint("alice")), "list_live_meetings")).text);
    expect(out.meetings).toHaveLength(1);
    expect(out.meetings[0]).toMatchObject({ meeting_id: "m1", state: "recording", stale: false, turns: 2 });
  });
  it("reads the live transcript in the same format as a saved one, flags the open tail and gives a cursor", async () => {
    await put("alice", "m1", liveDoc());
    const out = data((await call(await connect(await mint("alice")), "get_live_transcript")).text);
    expect(out.meeting_id).toBe("m1");
    expect(out.text).toContain("[0:00] (Mikrofon · Anna) Guten Morgen");
    expect(out.partial_tail).toBe(true);
    expect(out.cursor_ms).toBeLessThan(5000);
    const later = data((await call(await connect(await mint("alice")), "get_live_transcript", { since_ms: out.cursor_ms })).text);
    expect(later.text).toContain("wir starten");
  });
  it("needs a meeting id when two are running, and names them", async () => {
    await put("alice", "m1", liveDoc());
    await put("alice", "m2", liveDoc());
    const { isError, text } = await call(await connect(await mint("alice")), "get_live_transcript");
    expect(isError).toBe(true);
    expect(text).toContain("m1");
    expect(text).toContain("m2");
  });
  it("says so plainly when nothing is being recorded, and never reads another user's meeting", async () => {
    const client = await connect(await mint("alice"));
    expect((await call(client, "get_live_transcript")).text).toMatch(/kein Meeting.*aufgenommen/i);
    await put("bob", "bobs", liveDoc());
    const denied = await call(client, "get_live_transcript", { meeting_id: "bobs" });
    expect(denied.isError).toBe(true);
    expect(denied.text).not.toContain("Guten Morgen");
  });
  it("marks a meeting stale when the recording tab went quiet", async () => {
    await put("alice", "m1", liveDoc({ updatedAt: clock - 120_000 }));
    const out = data((await call(await connect(await mint("alice")), "get_live_transcript", { meeting_id: "m1" })).text);
    expect(out.stale).toBe(true);
  });
});
