import { z } from "zod";
import { McpServer, type AuthInfo, type CallToolResult } from "@modelcontextprotocol/server";
import { LIVE_STALE_MS, findSnippets, readLive, sliceText, stripFrontmatter, type LiveDoc, type Scope } from "../../shared/mcp";
import { TranscriptError, type IndexEntry, type MeetingIndex, type TranscriptReader } from "./meetings";
import type { DocStore } from "./docStore";

export interface ToolDeps {
  index: MeetingIndex;
  transcripts: TranscriptReader;
  live: DocStore<LiveDoc>;
  now: () => number;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

const time = (entry: IndexEntry) => {
  const parsed = Date.parse(entry.date);
  return Number.isFinite(parsed) ? parsed : -Infinity;
};
/** Newest first; a meeting with an unreadable date sorts last but is never lost. */
const newestFirst = (entries: IndexEntry[]) =>
  [...entries].sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));

const hasTranscript = (entry: IndexEntry) => (entry.transcriptChars ?? 0) > 0;

const NOT_FOUND = "Meeting nicht gefunden.";
const DRIVE_REVOKED = "Der Google-Drive-Zugriff von CheatMeet wurde entzogen. Bitte in CheatMeet neu anmelden.";
const DRIVE_DOWN = "Google Drive ist gerade nicht erreichbar. Bitte später erneut versuchen.";
const INDEX_DOWN = "Die Meeting-Liste ist gerade nicht erreichbar. Bitte später erneut versuchen.";

function transcriptFailure(error: unknown): CallToolResult {
  if (error instanceof TranscriptError) {
    if (error.reason === "drive_revoked") return fail(DRIVE_REVOKED);
    if (error.reason === "drive_unavailable") return fail(DRIVE_DOWN);
    return fail("Das Transkript ist nicht mehr in Google Drive vorhanden.");
  }
  return fail(DRIVE_DOWN);
}

/** Transcripts rarely change once written, so they are kept until the index says otherwise. */
class TranscriptCache {
  /** `null` remembers a file that is gone, so a broken index entry costs one Drive call, not one per search. */
  private readonly items = new Map<string, { text: string | null }>();
  private bytes = 0;
  constructor(private readonly limit = 20 * 1024 * 1024) {}
  get(key: string): string | null | undefined {
    const hit = this.items.get(key);
    if (hit) {
      this.items.delete(key);
      this.items.set(key, hit);
    }
    return hit === undefined ? undefined : hit.text;
  }
  set(key: string, text: string | null) {
    if ((text?.length ?? 0) > this.limit) return;
    this.items.set(key, { text });
    this.bytes += text?.length ?? 0;
    for (const [oldest, value] of this.items) {
      if (this.bytes <= this.limit || oldest === key) break;
      this.items.delete(oldest);
      this.bytes -= value.text?.length ?? 0;
    }
  }
}
const cache = new TranscriptCache();

const requires = (auth: AuthInfo | undefined, scope: Scope) => Boolean(auth?.scopes.includes(scope));

/**
 * One server instance per request, built for the caller: the tool list depends
 * on the scopes they granted, and every handler reads the account from the
 * verified token - no tool takes a user argument, so there is nothing to spoof.
 */
export function buildServer(deps: ToolDeps, auth: AuthInfo | undefined): McpServer {
  const server = new McpServer(
    { name: "cheatmeet", version: "1.0.0" },
    {
      instructions:
        "CheatMeet gibt Lesezugriff auf die Meetings des angemeldeten Nutzers: Zusammenfassungen, Aufgaben, Transkripte und, während einer Aufnahme, das bisherige Live-Transkript. Nur lesen, nichts wird verändert.",
    },
  );
  const who = (auth?.extra ?? {}) as { uid?: string; googleSub?: string };
  const uid = who.uid ?? "";
  const googleSub = who.googleSub ?? "";

  const load = async (): Promise<IndexEntry[] | CallToolResult> => {
    try {
      return await deps.index.list(uid);
    } catch {
      return fail(INDEX_DOWN);
    }
  };
  const isFailure = (value: IndexEntry[] | CallToolResult): value is CallToolResult => !Array.isArray(value);

  if (requires(auth, "meetings:read")) {
    server.registerTool("list_meetings", {
      title: "Meetings auflisten",
      description:
        "Lists the user's recorded meetings, newest first: id, date, title, participants, whether a transcript exists, and a short summary. Use the id with get_meeting, get_transcript. Filter by ISO date (from/to, inclusive) and page with the returned cursor. Meetings whose index entry failed to sync may be missing.",
      inputSchema: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().describe("Earliest day, YYYY-MM-DD"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().describe("Latest day, YYYY-MM-DD"),
        limit: z.number().int().min(1).max(100).optional().describe("Default 30"),
        cursor: z.string().max(100).optional().describe("From a previous result's next_cursor"),
      }),
      annotations: READ_ONLY,
    }, async ({ from, to, limit = 30, cursor }) => {
      const entries = await load();
      if (isFailure(entries)) return entries;
      const start = from ? Date.parse(from) : -Infinity;
      const end = to ? Date.parse(to.slice(0, 10)) + 86_400_000 : Infinity;
      const filtered = newestFirst(entries).filter((entry) => {
        const at = time(entry);
        // A meeting with an unreadable date has no place on a calendar, so a
        // date filter excludes it; without a filter it is listed.
        return at === -Infinity ? !from && !to : at >= start && at < end;
      });
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      if (!Number.isInteger(offset) || offset < 0) return fail("Ungültiger Cursor.");
      const page = filtered.slice(offset, offset + limit);
      return ok({
        meetings: page.map((entry) => ({
          id: entry.id,
          date: entry.date,
          title: entry.title,
          duration_minutes: entry.durationMs ? Math.round(entry.durationMs / 60000) : null,
          participants: entry.participants,
          project: entry.projectName ?? null,
          status: entry.status ?? null,
          has_transcript: hasTranscript(entry),
          summary: entry.summary.length > 400 ? `${entry.summary.slice(0, 397)}…` : entry.summary,
          todo_count: entry.todos.length,
        })),
        next_cursor: offset + limit < filtered.length ? String(offset + limit) : null,
        total: filtered.length,
      });
    });

    server.registerTool("get_meeting", {
      title: "Meeting lesen",
      description:
        "Returns the full summary, to-dos (with owner and due date when stated), takeaways and participants of one meeting. The transcript is separate: use get_transcript.",
      inputSchema: z.object({ meeting_id: z.string().min(1).max(128) }),
      annotations: READ_ONLY,
    }, async ({ meeting_id }) => {
      const entries = await load();
      if (isFailure(entries)) return entries;
      const entry = entries.find((candidate) => candidate.id === meeting_id);
      if (!entry) return fail(NOT_FOUND);
      return ok({
        id: entry.id, date: entry.date, title: entry.title, project: entry.projectName ?? null,
        duration_minutes: entry.durationMs ? Math.round(entry.durationMs / 60000) : null,
        participants: entry.participants, status: entry.status ?? null, summary: entry.summary,
        todos: entry.todos, takeaways: entry.takeaways,
        has_transcript: hasTranscript(entry), transcript_chars: entry.transcriptChars ?? 0,
      });
    });

    server.registerTool("get_transcript", {
      title: "Transkript lesen",
      description:
        "Returns the transcript of one past meeting as timestamped lines '[m:ss] (Speaker) text' ('[h:mm:ss]' after the first hour). Long transcripts are paged: pass next_offset back as offset until it is null. max_chars defaults to 40000.",
      inputSchema: z.object({
        meeting_id: z.string().min(1).max(128),
        offset: z.number().int().min(0).optional(),
        max_chars: z.number().int().min(1000).max(100_000).optional(),
      }),
      annotations: READ_ONLY,
    }, async ({ meeting_id, offset = 0, max_chars = 40_000 }) => {
      const entries = await load();
      if (isFailure(entries)) return entries;
      const entry = entries.find((candidate) => candidate.id === meeting_id);
      if (!entry) return fail(NOT_FOUND);
      if (!entry.driveTranscriptId)
        return fail(hasTranscript(entry)
          ? "Das Transkript dieses Meetings ist noch nicht in Google Drive gesichert."
          : "Zu diesem Meeting gibt es kein Transkript.");
      let raw: string;
      try {
        raw = await deps.transcripts.read(googleSub, entry.driveTranscriptId);
      } catch (error) {
        return transcriptFailure(error);
      }
      const slice = sliceText(stripFrontmatter(raw), offset, max_chars);
      return ok({ meeting_id: entry.id, title: entry.title, text: slice.text, offset, next_offset: slice.nextOffset, total_chars: slice.total });
    });

    server.registerTool("search_meetings", {
      title: "Meetings durchsuchen",
      description:
        "Searches titles, summaries, to-dos and the transcripts of the user's past meetings (case-insensitive substring). Each hit says where it matched and shows a snippet. transcript_coverage tells how many transcripts were actually searched: when 'truncated' is true, older transcripts were skipped for time; 'unavailable' counts transcripts that could not be read, so an empty result is not proof that nothing was said.",
      inputSchema: z.object({
        query: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
      }),
      annotations: READ_ONLY,
    }, async ({ query, limit = 20 }) => {
      const entries = await load();
      if (isFailure(entries)) return entries;
      const needle = query.trim().toLowerCase();
      const hits: { meeting_id: string; title: string; date: string; where: string; snippet: string }[] = [];
      const add = (entry: IndexEntry, where: string, text: string) => {
        for (const snippet of findSnippets(text, query).slice(0, 2))
          hits.push({ meeting_id: entry.id, title: entry.title, date: entry.date, where, snippet });
      };
      const ordered = newestFirst(entries);
      for (const entry of ordered) {
        if (entry.title.toLowerCase().includes(needle)) add(entry, "title", entry.title);
        if (entry.summary.toLowerCase().includes(needle)) add(entry, "summary", entry.summary);
        const todos = entry.todos.map((todo) => todo.text).join("\n");
        if (todos.toLowerCase().includes(needle)) add(entry, "todos", todos);
      }
      const withTranscript = ordered.filter((entry) => entry.driveTranscriptId);
      const deadline = deps.now() + 20_000;
      const budget = withTranscript.slice(0, 60);
      let searched = 0;
      let missing = 0;
      let queue = [...budget];
      const worker = async () => {
        for (let entry = queue.shift(); entry; entry = queue.shift()) {
          if (deps.now() > deadline) return;
          const key = `${googleSub}:${entry.driveTranscriptId}:${entry.updatedAt ?? ""}`;
          let text = cache.get(key);
          if (text === undefined) {
            try {
              text = stripFrontmatter(await deps.transcripts.read(googleSub, entry.driveTranscriptId!));
              cache.set(key, text);
            } catch (error) {
              if (error instanceof TranscriptError && error.reason !== "not_found") throw error;
              cache.set(key, null);
              text = null;
            }
          }
          if (text === null) {
            missing++;
            continue;
          }
          searched++;
          if (text.toLowerCase().includes(needle)) add(entry, "transcript", text);
        }
      };
      try {
        await Promise.all(Array.from({ length: 6 }, worker));
      } catch (error) {
        return transcriptFailure(error);
      }
      queue = [];
      const order = new Map(ordered.map((entry, index) => [entry.id, index]));
      hits.sort((a, b) => (order.get(a.meeting_id)! - order.get(b.meeting_id)!));
      return ok({
        query,
        hits: hits.slice(0, limit),
        more_hits: hits.length > limit,
        transcript_coverage: {
          searched,
          total: withTranscript.length,
          // In the index but no longer readable in Drive.
          unavailable: missing,
          // Skipped for the time or count budget: older meetings may hold more hits.
          truncated: searched + missing < withTranscript.length,
        },
      });
    });
  }

  if (requires(auth, "meetings:live")) {
    const mine = async () => (await deps.live.listByOwner(uid)).filter((doc) => doc.reportId);
    server.registerTool("list_live_meetings", {
      title: "Laufende Meetings",
      description:
        "Lists the meetings that are being recorded right now (or ended within the last half hour): id, start time, state (recording, paused, ended), whether the recording tab has gone quiet (stale), and how many transcript entries exist so far. Use the id with get_live_transcript.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    }, async () => {
      const docs = await mine();
      const at = deps.now();
      return ok({
        meetings: docs.map((doc) => {
          const stale = doc.state !== "ended" && at - doc.updatedAt > LIVE_STALE_MS;
          return { meeting_id: doc.reportId, started_at: doc.startedAt, state: doc.state, stale, updated_seconds_ago: Math.max(0, Math.round((at - doc.updatedAt) / 1000)), turns: doc.turns.length };
        }),
      });
    });

    server.registerTool("get_live_transcript", {
      title: "Live-Transkript lesen",
      description:
        "Returns what has been said so far in a meeting that is being recorded now, in the same timestamped format as get_transcript. Without meeting_id it uses the only running meeting. To follow along, pass the returned cursor_ms as since_ms on the next call to receive only new text. partial_tail=true means the last entry is still being spoken and may change; stale=true means the recording tab has not reported for over a minute. last_minutes limits the window; max_chars defaults to 40000 and keeps the newest text.",
      inputSchema: z.object({
        meeting_id: z.string().min(1).max(128).optional(),
        last_minutes: z.number().min(1).max(600).optional(),
        since_ms: z.number().int().min(0).optional(),
        max_chars: z.number().int().min(1000).max(100_000).optional(),
      }),
      annotations: READ_ONLY,
    }, async ({ meeting_id, last_minutes, since_ms, max_chars }) => {
      const docs = await mine();
      let doc: LiveDoc | undefined;
      if (meeting_id) doc = docs.find((candidate) => candidate.reportId === meeting_id);
      else if (docs.length === 1) doc = docs[0];
      else if (docs.length > 1)
        return fail(`Es laufen mehrere Meetings: ${docs.map((d) => d.reportId).join(", ")}. Bitte meeting_id angeben.`);
      if (!doc)
        return fail(meeting_id ? NOT_FOUND : "Es wird gerade kein Meeting aufgenommen.");
      const view = readLive(doc, { lastMinutes: last_minutes, sinceMs: since_ms, maxChars: max_chars }, deps.now());
      return ok({
        meeting_id: doc.reportId, started_at: doc.startedAt, state: view.state, stale: view.stale,
        text: view.text, cursor_ms: view.cursorMs, partial_tail: view.partialTail, truncated: view.truncated,
        dropped_before_ms: doc.droppedBeforeMs ?? null,
      });
    });
  }
  return server;
}
