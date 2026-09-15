import { beforeEach, describe, expect, it, vi } from "vitest";

const db = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: async (k: string) => db.get(k),
  set: async (k: string, v: unknown) => void db.set(k, v),
  del: async (k: string) => void db.delete(k),
  update: async (k: string, fn: (v: unknown) => unknown) =>
    void db.set(k, fn(db.get(k))),
  setMany: async (entries: [string, unknown][]) =>
    entries.forEach(([k, v]) => db.set(k, v)),
  delMany: async (ks: string[]) => ks.forEach((k) => db.delete(k)),
  keys: async () => [...db.keys()],
  getMany: async (ks: string[]) => ks.map((k) => db.get(k)),
}));

const { inspectStorage, releaseSyncedAudio } = await import("./local");

const put = (key: string, report: Record<string, unknown>, dirty = false) =>
  db.set(key, { report: { todos: [], takeaways: [], ...report }, dirty });

beforeEach(() => {
  db.clear();
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: 4_000, quota: 8_000 }) } });
});

const safe = { driveSyncedAt: "2026-09-14", rawAudioUrl: "drive-file" };

describe("inspectStorage", () => {
  it("counts reports, held recordings and the ones already safe in Drive", async () => {
    put("u1:report:a", { id: "a", ...safe });
    put("u1:report:b", { id: "b" });
    db.set("u1:draft:a", {});
    db.set("u1:draft:b", {});
    put("u2:report:z", { id: "z", ...safe });
    db.set("u2:draft:z", {});

    expect(await inspectStorage("u1")).toMatchObject({
      reports: 2,
      drafts: 2,
      // Only "a" has its audio in Drive; "b" holds the only copy.
      releasable: 1,
      usageBytes: 4_000,
      quotaBytes: 8_000,
    });
  });
  it("still reports counts where the browser gives no estimate", async () => {
    vi.stubGlobal("navigator", {});
    put("u1:report:a", { id: "a" });
    const result = await inspectStorage("u1");
    expect(result.usageBytes).toBeUndefined();
    expect(result.reports).toBe(1);
  });
});

describe("releaseSyncedAudio", () => {
  it("frees the audio of recordings Drive already holds, and nothing else", async () => {
    put("u1:report:a", { id: "a", ...safe });
    put("u1:report:b", { id: "b", driveSyncedAt: "2026-09-14" }); // no audio in Drive
    db.set("u1:draft:a", {});
    db.set("u1:capture-progress:a", {});
    db.set("u1:audio-chunk:a:0", {});
    db.set("u1:audio-chunk:a:1", {});
    db.set("u1:draft:b", {});
    db.set("u1:audio-chunk:b:0", {});

    expect(await releaseSyncedAudio("u1")).toBe(1);
    expect(db.has("u1:draft:a")).toBe(false);
    expect(db.has("u1:capture-progress:a")).toBe(false);
    expect(db.has("u1:audio-chunk:a:0")).toBe(false);
    expect(db.has("u1:audio-chunk:a:1")).toBe(false);
    // The report document stays: Firestore would re-insert it anyway.
    expect(db.has("u1:report:a")).toBe(true);
    // b holds the only copy of its audio and is untouched.
    expect(db.has("u1:draft:b")).toBe(true);
    expect(db.has("u1:audio-chunk:b:0")).toBe(true);
  });
  it("never releases audio that exists nowhere else", async () => {
    put("u1:report:a", { id: "a" });
    db.set("u1:draft:a", {});
    expect(await releaseSyncedAudio("u1")).toBe(0);
    expect(db.has("u1:draft:a")).toBe(true);
  });
  it("never touches another account", async () => {
    put("u2:report:z", { id: "z", ...safe });
    db.set("u2:draft:z", {});
    expect(await releaseSyncedAudio("u1")).toBe(0);
    expect(db.has("u2:draft:z")).toBe(true);
  });
});

describe("putDraft does not duplicate journalled audio", () => {
  const draft = (id: string, audio?: unknown) => ({
    report: { id, title: "", date: "2026-09-16", todos: [], takeaways: [] },
    audio,
  });

  it("drops the inline blob when the chunk journal holds the audio", async () => {
    const { putDraft } = await import("./local");
    db.set("u1:audio-chunk:a:0", { sequence: 0, blob: { size: 10 }, durationMs: 1 });
    await putDraft("u1", draft("a", { size: 10 }) as never);
    expect((db.get("u1:draft:a") as { audio?: unknown }).audio).toBeUndefined();
  });

  it("keeps the inline blob for an import, where it is the only copy", async () => {
    const { putDraft } = await import("./local");
    await putDraft("u1", draft("b", { size: 10 }) as never);
    expect((db.get("u1:draft:b") as { audio?: unknown }).audio).toBeDefined();
  });

  it("does not confuse one recording's journal with another's", async () => {
    const { putDraft } = await import("./local");
    db.set("u1:audio-chunk:a:0", { sequence: 0, blob: { size: 10 }, durationMs: 1 });
    await putDraft("u1", draft("c", { size: 10 }) as never);
    expect((db.get("u1:draft:c") as { audio?: unknown }).audio).toBeDefined();
  });
});
