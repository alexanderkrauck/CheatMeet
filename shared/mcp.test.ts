import { describe, expect, it } from "vitest";
import { renderTranscript, type MeetingTranscript, type SpeechTurn } from "./transcription";
import {
  LIVE_MAX_DOC_BYTES,
  SCOPES,
  applyPush,
  diffTurns,
  findSnippets,
  narrowScopes,
  parseScopes,
  readLive,
  sliceText,
  stripFrontmatter,
  type LiveDoc,
  type LivePush,
} from "./mcp";

const turn = (id: string, startMs: number, text: string, extra: Partial<SpeechTurn> = {}): SpeechTurn => ({
  id, startMs, endMs: startMs + 900, speaker: "mic:0:A", text, final: true, ...extra,
});
const push = (seq: number, extra: Partial<LivePush> = {}): LivePush => ({
  seq, startedAt: "2026-09-30T09:00:00.000Z", languages: ["de"], state: "recording",
  upsert: [], remove: [], speakerNames: {}, ...extra,
});
const NOW = 1_000_000;

describe("scopes", () => {
  it("parses a space separated scope string and drops what the server does not offer", () => {
    expect(parseScopes("meetings:read openid offline_access meetings:live")).toEqual(["meetings:read", "meetings:live"]);
    expect(parseScopes(undefined)).toEqual([...SCOPES]);
    expect(parseScopes("openid")).toEqual([...SCOPES]);
  });
  it("only ever narrows", () => {
    expect(narrowScopes(["meetings:read"], ["meetings:read", "meetings:live"])).toEqual(["meetings:read"]);
    expect(narrowScopes(["meetings:read", "meetings:live"], ["meetings:read"])).toEqual(["meetings:read"]);
  });
});

describe("sliceText", () => {
  const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
  it("cuts at a line boundary and says where to continue", () => {
    const first = sliceText(text, 0, 10);
    expect(first).toEqual({ text: "aaaa\nbbbb\n", nextOffset: 10, total: 19 });
    const second = sliceText(text, first.nextOffset!, 10);
    expect(second.text).toBe("cccc\ndddd");
    expect(second.nextOffset).toBeNull();
  });
  it("returns everything when it fits, and nothing past the end", () => {
    expect(sliceText(text, 0, 1000)).toEqual({ text, nextOffset: null, total: 19 });
    expect(sliceText(text, 500, 10)).toEqual({ text: "", nextOffset: null, total: 19 });
  });
  it("hard-cuts a single line longer than the budget instead of looping forever", () => {
    const long = "x".repeat(50);
    const cut = sliceText(long, 0, 20);
    expect(cut.text).toHaveLength(20);
    expect(cut.nextOffset).toBe(20);
  });
});

describe("findSnippets", () => {
  it("finds case-insensitively, at most three per text, trimmed at words", () => {
    const text = "Wir besprechen das Budget. Danach das BUDGET erneut. Noch ein budget hier. Und ein viertes Budget.";
    const found = findSnippets(text, "budget", 20);
    expect(found).toHaveLength(3);
    expect(found[0].toLowerCase()).toContain("budget");
    expect(found.every((s) => s.length <= 60)).toBe(true);
  });
  it("returns nothing for no match or a blank query", () => {
    expect(findSnippets("abc", "zzz")).toEqual([]);
    expect(findSnippets("abc", "  ")).toEqual([]);
  });
});

describe("stripFrontmatter", () => {
  it("removes a leading YAML block only", () => {
    expect(stripFrontmatter("---\ntitle: x\n---\n[0:00] hi")).toBe("[0:00] hi");
    expect(stripFrontmatter("[0:00] ---\nnot front matter")).toBe("[0:00] ---\nnot front matter");
  });
});

describe("diffTurns", () => {
  it("is empty when nothing changed, whatever the order", () => {
    const a = [turn("1", 0, "a"), turn("2", 1000, "b")];
    expect(diffTurns(a, [a[1], a[0]])).toEqual({ upsert: [], remove: [] });
  });
  it("reports changed and new turns as upserts and vanished ids as removals", () => {
    const before = [turn("1", 0, "a"), turn("2", 1000, "b")];
    const after = [turn("1", 0, "a!"), turn("3", 2000, "c")];
    const diff = diffTurns(before, after);
    expect(diff.upsert.map((t) => t.id).sort()).toEqual(["1", "3"]);
    expect(diff.remove).toEqual(["2"]);
  });
});

describe("applyPush", () => {
  it("creates the document from a reset push", () => {
    const result = applyPush(null, push(1, { reset: true, upsert: [turn("1", 0, "Hallo")] }), NOW);
    expect(result.status).toBe("ok");
    expect(result.doc?.turns).toHaveLength(1);
    expect(result.doc?.seq).toBe(1);
    expect(result.doc?.updatedAt).toBe(NOW);
  });
  it("asks for a resync when there is no document and no reset, or a sequence gap", () => {
    expect(applyPush(null, push(2), NOW).status).toBe("resync");
    const doc = applyPush(null, push(1, { reset: true }), NOW).doc!;
    expect(applyPush(doc, push(3), NOW).status).toBe("resync");
  });
  it("treats an already-seen sequence as a harmless replay", () => {
    const doc = applyPush(null, push(1, { reset: true, upsert: [turn("1", 0, "a")] }), NOW).doc!;
    const replay = applyPush(doc, push(1, { upsert: [turn("9", 5, "zzz")] }), NOW + 5);
    expect(replay.status).toBe("noop");
    expect(replay.doc).toBe(doc);
  });
  it("merges upserts and removals and keeps turns in time order", () => {
    let doc = applyPush(null, push(1, { reset: true, upsert: [turn("1", 0, "a"), turn("2", 5000, "b")] }), NOW).doc!;
    doc = applyPush(doc, push(2, { upsert: [turn("2", 5000, "b!"), turn("3", 2000, "c")], remove: ["1"] }), NOW + 1).doc!;
    expect(doc.turns.map((t) => [t.id, t.text])).toEqual([["3", "c"], ["2", "b!"]]);
  });
  it("replaces everything on reset", () => {
    let doc = applyPush(null, push(1, { reset: true, upsert: [turn("1", 0, "a")] }), NOW).doc!;
    doc = applyPush(doc, push(5, { reset: true, upsert: [turn("7", 0, "neu")] }), NOW + 1).doc!;
    expect(doc.turns.map((t) => t.id)).toEqual(["7"]);
  });
  it("stays under the size cap by dropping the oldest final turns, never the unfinished tail", () => {
    const big = "x".repeat(20_000);
    const turns = Array.from({ length: 80 }, (_, i) => turn(`t${i}`, i * 1000, big));
    turns.push(turn("open", 90_000, "läuft noch", { final: false }));
    const { doc } = applyPush(null, push(1, { reset: true, upsert: turns }), NOW);
    expect(JSON.stringify(doc!.turns).length).toBeLessThanOrEqual(LIVE_MAX_DOC_BYTES);
    expect(doc!.turns.at(-1)!.id).toBe("open");
    expect(doc!.droppedBeforeMs).toBeGreaterThan(0);
    expect(doc!.turns[0].id).not.toBe("t0");
  });
  it("records the state, so an ended meeting reads as ended", () => {
    const doc = applyPush(null, push(1, { reset: true, state: "ended" }), NOW).doc!;
    expect(doc.state).toBe("ended");
  });
});

describe("readLive", () => {
  const build = (turns: SpeechTurn[], extra: Partial<LiveDoc> = {}): LiveDoc => ({
    seq: 1, startedAt: "2026-09-30T09:00:00.000Z", languages: ["de"], state: "recording",
    turns, speakerNames: { "mic:0:A": "Anna" }, updatedAt: NOW, ...extra,
  });
  const sample = [
    turn("1", 0, "Erster"), turn("2", 60_000, "Zweiter"), turn("3", 300_000, "Dritter"),
    turn("4", 400_000, "läuft", { final: false }),
  ];

  it("uses exactly the line format of a saved transcript", () => {
    const doc = build(sample);
    const speech: MeetingTranscript = {
      provider: "assemblyai", phase: "live", languages: ["de"], turns: sample, speakerNames: doc.speakerNames,
    };
    expect(readLive(doc, {}, NOW).text).toBe(renderTranscript(speech));
  });
  it("windows by minutes counted back from the newest speech", () => {
    const result = readLive(build(sample), { lastMinutes: 2 }, NOW);
    expect(result.text).toContain("Dritter");
    expect(result.text).toContain("läuft");
    expect(result.text).not.toContain("Zweiter");
  });
  it("returns only what ended after sinceMs, with a cursor that never skips", () => {
    const first = readLive(build(sample), { sinceMs: 0 }, NOW);
    expect(first.text).toContain("Erster");
    // The unfinished turn will change, so the cursor must stay before it.
    expect(first.cursorMs).toBeLessThan(400_000);
    const later = readLive(build(sample), { sinceMs: first.cursorMs }, NOW);
    expect(later.text).toContain("läuft");
  });
  it("marks the unfinished tail", () => {
    expect(readLive(build(sample), {}, NOW).partialTail).toBe(true);
    expect(readLive(build(sample.slice(0, 3)), {}, NOW).partialTail).toBe(false);
  });
  it("goes stale after a minute without a push, unless it ended", () => {
    expect(readLive(build(sample), {}, NOW + 61_000).stale).toBe(true);
    expect(readLive(build(sample), {}, NOW + 30_000).stale).toBe(false);
    expect(readLive(build(sample, { state: "ended" }), {}, NOW + 3_600_000).stale).toBe(false);
  });
  it("keeps the newest text when it has to cut, and says so", () => {
    const many = Array.from({ length: 50 }, (_, i) => turn(`t${i}`, i * 1000, `Satz ${i} `.repeat(20)));
    const result = readLive(build(many), { maxChars: 500 }, NOW);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(500);
    expect(result.text).toContain("Satz 49");
    expect(result.text).not.toContain("Satz 0 ");
  });
});
