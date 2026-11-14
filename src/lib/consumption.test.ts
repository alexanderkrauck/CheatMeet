import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageEvent, UsagePageData } from "../../shared/usage";
import { usageRange } from "./usage";

const h = vi.hoisted(() => ({ user: null as null | { uid: string; getIdToken: () => Promise<string> }, slots: [] as any[], cursor: 0, effects: [] as (() => unknown)[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: any) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [h.slots[index], (next: any) => { h.slots[index] = typeof next === "function" ? next(h.slots[index]) : next; }];
  },
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = h.cursor++;
    const previous = h.slots[index];
    if (!previous || deps.some((value, at) => value !== previous[at])) { h.slots[index] = deps; h.effects.push(effect); }
  },
  useCallback: (fn: unknown) => fn,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("./firebase", () => ({ auth: { get currentUser() { return h.user; } } }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: vi.fn(() => () => {}) }));
import { aggregateConsumption, loadConsumption, useConsumption } from "./consumption";

const range = usageRange("month", "2026-11-14");
const event = (id: string, patch: Partial<UsageEvent> = {}): UsageEvent => ({
  id, owner: "alice", operation: "summary", provider: "gemini", kind: "tokens", model: "gemini-test",
  startedAt: "2026-11-14T09:00:00Z", updatedAt: "2026-11-14T09:01:00Z",
  state: "completed", evidence: "provider", cost: { usd: null, currency: "USD" }, ...patch,
});
const page = (events: UsageEvent[], nextCursor: string | null = null): UsagePageData => ({
  events, nextCursor, scope: "mine", canViewAll: false, trackingSince: "2026-11-14T00:00:00Z", historyComplete: false,
});
const response = (body: UsagePageData) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(() => { vi.clearAllMocks(); h.user = null; h.slots = []; h.cursor = 0; h.effects = []; });
afterEach(() => vi.unstubAllGlobals());

describe("loadConsumption", () => {
  it("retains only explicitly partial pages on a later network failure", async () => {
    const user = { uid: "alice", getIdToken: vi.fn(async () => "alice-token") };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(page([event("one")], "next"))).mockRejectedValueOnce(new Error("offline"));
    await expect(loadConsumption({ owner: "alice", range, scope: "mine", currentUser: () => user, fetchImpl }))
      .rejects.toMatchObject({ code: "load", snapshot: { events: [event("one")], nextCursor: "next", pagesLoaded: 1 } });
  });

  it.each([401, 403])("erases even previously loaded operator rows when a later page returns %s", async (status) => {
    const user = { uid: "alice", getIdToken: vi.fn(async () => "alice-token") };
    const first = { ...page([event("foreign", { owner: "bob" })], "next"), scope: "all" as const, canViewAll: true };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce({ ok: false, status });
    await expect(loadConsumption({ owner: "alice", range, scope: "all", currentUser: () => user, fetchImpl }))
      .rejects.toMatchObject({ code: status === 403 ? "forbidden" : "unauthorized", snapshot: null });
  });

  it.each([
    ["foreign mine owner", { ...page([event("foreign", { owner: "bob" })]) }],
    ["wrong scope", { ...page([event("one")]), scope: "all" }],
    ["unbounded cursor", { ...page([event("one")]), nextCursor: undefined }],
    ["missing start", { ...page([event("one", { startedAt: null as unknown as string })]) }],
    ["invalid operation", { ...page([event("one", { operation: "unsupported" as UsageEvent["operation"] })]) }],
    ["invalid metadata", { ...page([event("one", { model: {} as string })]) }],
  ])("rejects an invalid response (%s) without publishing it", async (_label, body) => {
    const user = { uid: "alice", getIdToken: vi.fn(async () => "alice-token") };
    const onPage = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(body as UsagePageData)).mockRejectedValue(new Error("invalid response guard"));
    await expect(loadConsumption({ owner: "alice", range, scope: "mine", currentUser: () => user, fetchImpl, onPage }))
      .rejects.toMatchObject({ code: "load", snapshot: null });
    expect(onPage).not.toHaveBeenCalled();
  });

  it("stops a repeated cursor instead of silently completing or looping", async () => {
    const user = { uid: "alice", getIdToken: vi.fn(async () => "alice-token") };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(page([event("one")], "same")))
      .mockResolvedValueOnce(response(page([event("one")], "same"))).mockRejectedValue(new Error("loop guard"));
    await expect(loadConsumption({ owner: "alice", range, scope: "mine", currentUser: () => user, fetchImpl }))
      .rejects.toMatchObject({ code: "load", snapshot: { pagesLoaded: 1 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["token", "fetch", "json"])("discards data when the account switches during %s", async (stage) => {
    let release: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const user = { uid: "alice", getIdToken: vi.fn(async () => { if (stage === "token") await waiting; return "alice-token"; }) };
    let current = user;
    const fetchImpl = vi.fn(async () => {
      if (stage === "fetch") await waiting;
      return { ok: true, status: 200, json: async () => { if (stage === "json") await waiting; return page([event("private")]); } } as Response;
    });
    const onPage = vi.fn();
    const pending = loadConsumption({ owner: "alice", range, scope: "mine", currentUser: () => current, fetchImpl, onPage });
    // Move to the await under test without timers or real I/O.
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    current = { uid: "bob", getIdToken: vi.fn(async () => "bob-token") };
    release();
    await expect(pending).rejects.toMatchObject({ code: "cancelled", snapshot: null });
    expect(onPage).not.toHaveBeenCalled();
    if (stage === "token") expect(fetchImpl).not.toHaveBeenCalled();
    expect(current.getIdToken).not.toHaveBeenCalled();
  });

  it("follows every cursor with the pinned token, dedupes by owner/id and keeps the newest receipt", async () => {
    const user = { uid: "alice", getIdToken: vi.fn(async () => "alice-token") };
    const newer = event("one", { updatedAt: "2026-11-14T10:00:00Z", cost: { usd: 0.12, currency: "USD" } });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(page([event("one")], "opaque cursor/1")))
      .mockResolvedValueOnce(response(page([newer, event("two")], "opaque cursor/2")))
      .mockResolvedValueOnce(response(page([event("one"), event("three")])));
    const progress = vi.fn();
    const result = await loadConsumption({ owner: "alice", range, scope: "mine", currentUser: () => user, fetchImpl, onPage: progress });
    expect(result.events).toEqual([newer, event("two"), event("three")]);
    expect(result.pagesLoaded).toBe(3);
    expect(progress.mock.calls.map(([value]) => value.events.length)).toEqual([1, 2, 3]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const urls = fetchImpl.mock.calls.map(([url]) => new URL(url, "https://fixture.invalid"));
    expect(urls[0].pathname).toBe("/api/usage");
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ start: "2026-11-01", end: "2026-12-01", scope: "mine" });
    expect(urls[1].searchParams.get("cursor")).toBe("opaque cursor/1");
    expect(urls[2].searchParams.get("cursor")).toBe("opaque cursor/2");
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.method).toBe("GET");
      expect(init.headers.Authorization).toBe("Bearer alice-token");
      expect(init.cache).toBe("no-store");
    }
  });
});

describe("aggregateConsumption", () => {
  it("keeps null, absent, negative and non-finite measurements unknown while retaining an explicitly measured zero", () => {
    const result = aggregateConsumption([
      event("zero", { tokens: { input: 0, output: 0, thinking: 0, cached: 0, total: 0 }, cost: { usd: 0, currency: "USD" } }),
      event("missing", { tokens: undefined, cost: { usd: null, currency: "USD" } }),
      event("invalid", { tokens: { input: -2, output: NaN, thinking: Infinity, cached: null, total: null }, cost: { usd: -1, currency: "USD" } }),
    ], range);
    for (const value of Object.values(result.tokens)) expect(value).toEqual({ value: 0, known: 1, total: 3 });
    expect(result.cost).toEqual({ value: 0, known: 1, total: 3 });
    const empty = aggregateConsumption([], range);
    expect(empty.cost).toEqual({ value: null, known: 0, total: 0 });
    expect(empty.streaming.sessionSeconds.value).toBeNull();
    expect(empty.batch.audioSeconds.value).toBeNull();
  });

  it("groups by Vienna operation-start day, model, operation, account and provider-qualified meeting, deduping before totals", () => {
    const daily = usageRange("day", "2026-11-14");
    const result = aggregateConsumption([
      event("same", { meetingId: "same-meeting", storage: "google", startedAt: "2026-11-13T23:30:00Z", tokens: { input: 10, output: 1, thinking: 0, cached: 0, total: 11 } }),
      event("same", { meetingId: "same-meeting", storage: "google", startedAt: "2026-11-13T23:30:00Z", updatedAt: "2026-11-14T11:00:00Z", tokens: { input: 20, output: 1, thinking: 0, cached: 0, total: 21 } }),
      event("other-storage", { meetingId: "same-meeting", storage: "microsoft", operation: "ask" }),
      event("other-owner", { owner: "bob", ownerLabel: "Bob Example", meetingId: "same-meeting", storage: "google", model: "second-model" }),
      event("unassigned"),
      event("end-exclusive", { startedAt: "2026-11-14T23:00:00Z" }),
      event("too-early", { startedAt: "2026-11-13T22:59:59Z" }),
      event("invalid", { startedAt: "not-a-date" }),
    ], daily);
    expect(result.requests).toBe(4);
    expect(result.tokens.input.value).toBe(20);
    expect(result.excludedInvalidDates).toBe(1);
    expect(result.days.map(({ key, requests }) => [key, requests])).toEqual([["2026-11-14", 4]]);
    expect(result.models.map(({ model, requests }) => [model, requests])).toEqual([["gemini-test", 3], ["second-model", 1]]);
    expect(result.operations.map(({ operation, requests }) => [operation, requests])).toEqual([["summary", 3], ["ask", 1]]);
    expect(result.accounts.map(({ owner, requests }) => [owner, requests])).toEqual([["alice", 3], ["bob", 1]]);
    expect(result.accounts.find(({ owner }) => owner === "bob")?.ownerLabel).toBe("Bob Example");
    expect(result.meetings).toHaveLength(4);
    expect(result.meetings.map(({ owner, meetingId, storage }) => [owner, meetingId, storage])).toEqual(expect.arrayContaining([
      ["alice", "same-meeting", "google"], ["alice", "same-meeting", "microsoft"], ["bob", "same-meeting", "google"], ["alice", undefined, undefined],
    ]));
  });

  it("sums measured tokens, separate stream connection durations and batch seconds without inventing missing counts or costs", () => {
    const result = aggregateConsumption([
      event("tokens", { tokens: { input: 100, output: 30, thinking: 12, cached: 40, total: 142 }, cost: { usd: 0.0003, currency: "USD" } }),
      event("missing", { state: "unknown", evidence: "unknown", tokens: { input: 20, output: null, thinking: null, cached: null, total: null } }),
      event("mic", { operation: "live-transcription", provider: "assemblyai", kind: "streaming", source: "mic", session: 1, sessionSeconds: 70, audioSeconds: 60, evidence: "browser" }),
      event("system", { operation: "live-transcription", provider: "assemblyai", kind: "streaming", source: "system", session: 1, sessionSeconds: 68, audioSeconds: 59, evidence: "browser" }),
      event("reconnect", { operation: "live-transcription", provider: "assemblyai", kind: "streaming", source: "mic", session: 2, state: "pending", evidence: "unknown" }),
      event("batch", { operation: "batch-transcription", provider: "assemblyai", kind: "batch", audioSeconds: 60, cost: { usd: 0.001, currency: "USD" } }),
    ], range);
    expect(result.requests).toBe(6);
    expect(result.tokens.input).toEqual({ value: 120, known: 2, total: 2 });
    expect(result.tokens.output).toEqual({ value: 30, known: 1, total: 2 });
    expect(result.tokens.thinking.value).toBe(12);
    expect(result.tokens.cached.value).toBe(40);
    expect(result.tokens.total.value).toBe(142);
    expect(result.streaming.connections).toBe(3);
    expect(result.streaming.sessionSeconds).toEqual({ value: 138, known: 2, total: 3 });
    expect(result.streaming.audioSeconds).toEqual({ value: 119, known: 2, total: 3 });
    expect(result.batch.audioSeconds).toEqual({ value: 60, known: 1, total: 1 });
    expect(result.cost.value).toBeCloseTo(0.0013);
    expect(result.cost).toMatchObject({ known: 2, total: 6 });
    expect(result.states).toEqual({ completed: 4, failed: 0, pending: 1, unknown: 1 });
    expect(result.evidence).toEqual({ provider: 2, browser: 2, unknown: 2 });
  });
});

describe("useConsumption", () => {
  const render = (scope: "mine" | "all" = "mine", dates = range) => { h.cursor = 0; return useConsumption(dates, scope); };
  const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };

  it("masks old rows and owner privileges in the first render of an account, range or scope switch", async () => {
    h.user = { uid: "alice", getIdToken: async () => "alice-token" };
    const fetchImpl = vi.fn(async () => response({ ...page([event("private")]), canViewAll: true }));
    vi.stubGlobal("fetch", fetchImpl);
    expect(render().loading).toBe(true);
    h.effects.splice(0).forEach((effect) => effect());
    await settle();
    expect(render()).toMatchObject({ owner: "alice", events: [event("private")], canViewAll: true, loading: false });
    expect(render("all").events).toEqual([]);
    expect(render("mine", usageRange("day", "2026-11-13")).events).toEqual([]);
    h.user = { uid: "bob", getIdToken: async () => "bob-token" };
    expect(render()).toMatchObject({ owner: "bob", events: [], canViewAll: false, loading: true });
    h.user = null;
    expect(render()).toMatchObject({ owner: null, events: [], canViewAll: false, loading: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps all-page failures partial but destroys all rows and permission after a later 403", async () => {
    h.user = { uid: "alice", getIdToken: async () => "alice-token" };
    const foreign = event("foreign", { owner: "bob" });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ ...page([foreign], "next"), scope: "all", canViewAll: true }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchImpl);
    render("all"); h.effects.splice(0).forEach((effect) => effect()); await settle();
    expect(render("all")).toMatchObject({ events: [foreign], partial: true, loading: false, canViewAll: true, pagesLoaded: 1 });
    fetchImpl.mockResolvedValueOnce(response({ ...page([foreign], "next"), scope: "all", canViewAll: true }))
      .mockResolvedValueOnce({ ok: false, status: 403 });
    render("all").reload();
    expect(render("all").events).toEqual([]);
    h.effects.splice(0).forEach((effect) => effect()); await settle();
    expect(render("all")).toMatchObject({ events: [], partial: false, loaded: false, canViewAll: false, forbidden: true, loading: false });
  });

  it("aborts obsolete work on cleanup and refuses a late response even if fetch ignores AbortSignal", async () => {
    h.user = { uid: "alice", getIdToken: async () => "alice-token" };
    let release: (value: Response) => void;
    const waiting = new Promise<Response>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn((_url: string, _init: RequestInit) => waiting);
    vi.stubGlobal("fetch", fetchImpl);
    render();
    const cleanups = h.effects.splice(0).map((effect) => effect() as () => void);
    await settle();
    cleanups.forEach((cleanup) => cleanup());
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    release(response(page([event("late")])));
    await settle();
    expect(render().events).toEqual([]);
  });
});
