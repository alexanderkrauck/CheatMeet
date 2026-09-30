import {
  speakerLabeler,
  transcriptLine,
  type MeetingTranscript,
  type SpeechTurn,
} from "./transcription";

/**
 * Shared, dependency-free pieces of the MCP access feature: scopes, transcript
 * paging and search snippets, and the live document a recording tab pushes.
 * Server and browser both import this, so it stays isomorphic.
 */

export const SCOPES = ["meetings:read", "meetings:live"] as const;
export type Scope = (typeof SCOPES)[number];

/** Scopes named in a space separated string, limited to the ones this server offers. */
export function parseScopes(value: string | undefined): Scope[] {
  const asked = (value || "").split(/\s+/).filter(Boolean);
  const known = SCOPES.filter((scope) => asked.includes(scope));
  // A client that asks for nothing we know (for example only `openid`) gets the
  // full set the user can then narrow on the consent screen.
  return known.length ? known : [...SCOPES];
}
/** A later request can shrink a grant, never widen it. */
export const narrowScopes = (granted: readonly Scope[], asked: readonly Scope[]): Scope[] =>
  granted.filter((scope) => asked.includes(scope));

export interface Slice {
  text: string;
  /** Where to continue, or null at the end. */
  nextOffset: number | null;
  total: number;
}
/** A window of `text` that ends on a line boundary whenever it can. */
export function sliceText(text: string, offset: number, maxChars: number): Slice {
  const total = text.length;
  const start = Math.max(0, Math.min(offset, total));
  if (start >= total) return { text: "", nextOffset: null, total };
  if (total - start <= maxChars) return { text: text.slice(start), nextOffset: null, total };
  const window = text.slice(start, start + maxChars);
  const lastBreak = window.lastIndexOf("\n");
  // A single line longer than the budget is cut hard; otherwise paging would never advance.
  const end = lastBreak >= 0 ? start + lastBreak + 1 : start + maxChars;
  return { text: text.slice(start, end), nextOffset: end, total };
}

/** Up to three short excerpts around the query, trimmed at word boundaries. */
export function findSnippets(text: string, query: string, radius = 60): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const found: string[] = [];
  let from = 0;
  while (found.length < 3) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    let start = Math.max(0, at - radius);
    let end = Math.min(text.length, at + needle.length + radius);
    if (start > 0) start = wordStart(text, start, at);
    if (end < text.length) end = wordEnd(text, end, at + needle.length);
    found.push(`${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`);
    from = end;
  }
  return found;
}
const wordStart = (text: string, from: number, limit: number) => {
  const space = text.indexOf(" ", from);
  return space >= 0 && space < limit ? space + 1 : from;
};
const wordEnd = (text: string, to: number, floor: number) => {
  const space = text.lastIndexOf(" ", to);
  return space > floor ? space : to;
};

/** `transkript.md` starts with a YAML block; tools return the transcript itself. */
export function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

// ---- Live ---------------------------------------------------------------

export type LiveState = "recording" | "paused" | "ended";
/** What one push from the recording tab carries; the server keeps the merged result. */
export interface LivePush {
  /** Strictly increasing per meeting, starting at 1. */
  seq: number;
  /** Replace everything: the first push, or after the server asked for a resync. */
  reset?: boolean;
  startedAt: string;
  languages: string[];
  state: LiveState;
  upsert: SpeechTurn[];
  remove: string[];
  speakerNames: Record<string, string>;
}
export interface LiveDoc {
  /** The meeting this belongs to; set by the server from the URL, never trusted from the body. */
  reportId?: string;
  seq: number;
  startedAt: string;
  languages: string[];
  state: LiveState;
  turns: SpeechTurn[];
  speakerNames: Record<string, string>;
  /** Epoch ms of the last push; drives `stale`. */
  updatedAt: number;
  /** Set when the oldest finished turns were dropped to stay under the cap. */
  droppedBeforeMs?: number;
}

export const LIVE_MAX_DOC_BYTES = 900_000;
export const LIVE_STALE_MS = 60_000;
export const LIVE_MAX_PUSH_BYTES = 1_000_000;

/** What changed between two snapshots of the turn list, order-insensitive. */
export function diffTurns(
  before: readonly SpeechTurn[],
  after: readonly SpeechTurn[],
): { upsert: SpeechTurn[]; remove: string[] } {
  const known = new Map(before.map((t) => [t.id, t]));
  const upsert = after.filter((t) => {
    const old = known.get(t.id);
    return !old || old.text !== t.text || old.final !== t.final || old.speaker !== t.speaker
      || old.startMs !== t.startMs || old.endMs !== t.endMs;
  });
  const present = new Set(after.map((t) => t.id));
  return { upsert, remove: before.filter((t) => !present.has(t.id)).map((t) => t.id) };
}

export type PushStatus = "ok" | "noop" | "resync";
export function applyPush(
  doc: LiveDoc | null,
  push: LivePush,
  now: number,
): { status: PushStatus; doc: LiveDoc | null } {
  if (doc && !push.reset && push.seq <= doc.seq) return { status: "noop", doc };
  if (!push.reset && (!doc || push.seq !== doc.seq + 1)) return { status: "resync", doc };
  const turns = new Map<string, SpeechTurn>(push.reset || !doc ? [] : doc.turns.map((t) => [t.id, t]));
  for (const id of push.remove) turns.delete(id);
  for (const t of push.upsert) turns.set(t.id, t);
  let ordered = [...turns.values()].sort((a, b) => a.startMs - b.startMs);
  let droppedBeforeMs = push.reset ? undefined : doc?.droppedBeforeMs;
  // Keep the document inside the store's limit: the oldest finished turns go
  // first, and the unfinished tail is never dropped.
  let size = JSON.stringify(ordered).length;
  while (size > LIVE_MAX_DOC_BYTES && ordered.length > 1) {
    const oldest = ordered.findIndex((t) => t.final);
    if (oldest < 0) break;
    size -= JSON.stringify(ordered[oldest]).length + 1;
    droppedBeforeMs = Math.max(droppedBeforeMs ?? 0, ordered[oldest].endMs);
    ordered = ordered.filter((_, index) => index !== oldest);
  }
  return {
    status: "ok",
    doc: {
      seq: push.seq,
      startedAt: push.startedAt,
      languages: push.languages,
      state: push.state,
      turns: ordered,
      speakerNames: push.speakerNames,
      updatedAt: now,
      ...(droppedBeforeMs !== undefined ? { droppedBeforeMs } : {}),
    },
  };
}

export interface LiveRead {
  text: string;
  state: LiveState;
  stale: boolean;
  /** Pass back as `since_ms` to receive only what is new. */
  cursorMs: number;
  /** The newest entry is still being spoken and may change. */
  partialTail: boolean;
  /** Older text was cut to fit `maxChars`. */
  truncated: boolean;
  turns: number;
}
export function readLive(
  doc: LiveDoc,
  options: { lastMinutes?: number; sinceMs?: number; maxChars?: number },
  now: number,
): LiveRead {
  const speech: MeetingTranscript = {
    provider: "assemblyai", phase: "live", languages: doc.languages, turns: doc.turns, speakerNames: doc.speakerNames,
  };
  // Numbering unnamed speakers from the whole meeting keeps "Sprecher 2" the
  // same person whatever window is asked for.
  const label = speakerLabeler(speech);
  let picked = [...doc.turns].sort((a, b) => a.startMs - b.startMs);
  if (options.lastMinutes !== undefined && picked.length) {
    const newest = Math.max(...picked.map((t) => t.endMs));
    picked = picked.filter((t) => t.endMs >= newest - options.lastMinutes * 60_000);
  }
  if (options.sinceMs !== undefined) picked = picked.filter((t) => t.endMs > options.sinceMs!);
  const firstOpen = picked.find((t) => !t.final);
  const finals = picked.filter((t) => t.final);
  const cursorMs = firstOpen
    ? Math.max(0, firstOpen.startMs - 1)
    : finals.length ? Math.max(...finals.map((t) => t.endMs)) : options.sinceMs ?? 0;
  let text = picked.map((t) => transcriptLine(t, label)).join("\n\n");
  let truncated = false;
  const max = options.maxChars ?? 40_000;
  if (text.length > max) {
    truncated = true;
    const tail = text.slice(text.length - max);
    const cut = tail.indexOf("\n\n");
    text = cut >= 0 && cut < tail.length - 2 ? tail.slice(cut + 2) : tail;
  }
  return {
    text,
    state: doc.state,
    stale: doc.state !== "ended" && now - doc.updatedAt > LIVE_STALE_MS,
    cursorMs,
    partialTail: Boolean(picked.at(-1) && !picked.at(-1)!.final),
    truncated,
    turns: picked.length,
  };
}
