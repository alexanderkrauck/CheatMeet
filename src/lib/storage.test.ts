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

const { inspectStorage, releaseSyncedAudio, acceptRemoteReport } = await import("./local");

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

describe("acceptRemoteReport", () => {
  const full = {
    id: "r1",
    date: "2026-09-15T12:00:00.000Z",
    updatedAt: "2026-09-15T12:00:00.000Z",
    title: "Weekly Sync",
    summary: "Roadmap besprochen.",
    transcription: "Alles Gesagte",
    speech: { provider: "assemblyai", phase: "final", languages: ["de"], speakerNames: {}, turns: [] },
    todos: [],
    takeaways: [],
  };

  it("does not let the cloud echo erase the transcript it just wrote", async () => {
    put("u1:report:r1", full);
    // The projection comes back at the SAME revision, so neither staleness
    // guard rejects it — only the merge stops it.
    await acceptRemoteReport("u1", {
      ...full,
      transcription: "",
      speech: undefined,
      transcriptChars: 13,
    } as never);

    const stored = db.get("u1:report:r1") as { report: Record<string, unknown> };
    expect(stored.report.transcription).toBe("Alles Gesagte");
    expect(stored.report.speech).toBeTruthy();
    // The rest of the remote document still wins.
    expect(stored.report.transcriptChars).toBe(13);
  });

  it("accepts a full remote copy on a device that has none", async () => {
    await acceptRemoteReport("u1", full as never);

    const stored = db.get("u1:report:r1") as { report: Record<string, unknown> };
    expect(stored.report.transcription).toBe("Alles Gesagte");
  });

  it("reconciles a stale failed processing stub with a completed cloud report", async () => {
    put("u1:report:r1", { ...full, summary: "", status: "error", error: "Load failed" }, true);
    await acceptRemoteReport("u1", { ...full, updatedAt: "2026-11-13T12:00:00Z", status: "completed" } as never);
    const stored = db.get("u1:report:r1") as { report: typeof full & { status: string; error?: string }; dirty: boolean };
    expect(stored.report.summary).toBe(full.summary);
    expect(stored.report.status).toBe("completed");
    expect(stored.report.error).toBeUndefined();
    expect(stored.report.transcription).toBe(full.transcription);
    expect(stored.dirty).toBe(false);
  });

  it.each([
    { summary: "Meine eigene Zusammenfassung" },
    { title: "Mein geänderter Titel" },
    { todos: [{ id: "todo", text: "Meine Aufgabe", done: false }] },
    { transcription: "Zusätzliche ungesicherte Worte" },
  ])("preserves real unsynced edits when reconciling failures: %j", async (edit) => {
    const local = { ...full, summary: "", status: "error", ...edit };
    put("u1:report:r1", local, true);
    await acceptRemoteReport("u1", { ...full, updatedAt: "2026-11-13T12:00:00Z", status: "completed", transcription: "", speech: undefined, transcriptChars: full.transcription.length } as never);
    expect((db.get("u1:report:r1") as { report: unknown; dirty: boolean })).toMatchObject({ report: local, dirty: true });
  });

  it("requires actual transcript equality, not just the projected character count", async () => {
    const local = { ...full, summary: "", status: "error", transcription: full.transcription.replace("Alles", "Neues") };
    put("u1:report:r1", local, true);
    await acceptRemoteReport("u1", { ...full, updatedAt: "2026-11-13T12:00:00Z", status: "completed", transcription: "", speech: undefined, transcriptChars: full.transcription.length } as never);
    expect(db.get("u1:report:r1")).toMatchObject({ report: local, dirty: true });
  });
});

describe("recording draft discovery", () => {
  it("does not call a title-only setup an unfinished recording", async () => {
    const { listDrafts } = await import("./local");
    db.set("u1:draft:empty", { report: { id: "empty", title: "Planned meeting", date: "2026-10-01", todos: [], takeaways: [], transcription: "" } });
    expect(await listDrafts("u1", { includeAudio: false })).toEqual([]);
    expect(db.has("u1:draft:empty")).toBe(true);
  });

  it("keeps interrupted audio visible even when the draft has no inline blob", async () => {
    const { listDrafts } = await import("./local");
    db.set("u1:draft:audio", { report: { id: "audio", title: "", date: "2026-10-01", todos: [], takeaways: [], transcription: "" } });
    db.set("u1:capture-progress:audio", { durationMs: 3000 });
    expect((await listDrafts("u1", { includeAudio: false })).map(d => d.report.id)).toEqual(["audio"]);
  });

  it("recognizes a verified saved duplicate without deleting its local recording", async () => {
    const { listDrafts } = await import("./local");
    const report = { id: "saved", title: "Interview", date: "2026-10-01", durationMs: 3000, rawAudioUrl: "audio-id", driveReportId: "json-id", driveSyncedAt: "2026-10-02", status: "completed", summary: "Saved", transcription: "Text", todos: [], takeaways: [] };
    put("u1:report:saved", report);
    db.set("u1:draft:saved", { report: { ...report, title: "Original calendar title", status: "analyzing", summary: "", captureState: "stopped" } });
    db.set("u1:capture-progress:saved", { durationMs: 3000 });
    expect(await listDrafts("u1", { includeAudio: false })).toEqual([]);
    expect(db.has("u1:draft:saved")).toBe(true);
    expect(db.has("u1:capture-progress:saved")).toBe(true);
    db.set("u1:capture-progress:saved", { durationMs: 4000 });
    expect((await listDrafts("u1", { includeAudio: false })).map(d => d.report.id)).toEqual(["saved"]);
  });

  it("notifies the dashboard when a draft is removed without changing the active-job count", async () => {
    const { putDraft, deleteDraft, watchDrafts } = await import("./local");
    const change = vi.fn();
    const stop = watchDrafts("u1", change);
    await putDraft("u1", { report: { id: "a", title: "", date: "2026-10-01", todos: [], takeaways: [], summary: "", transcription: "" }, audio: new Blob(["audio"]) });
    change.mockClear();
    await deleteDraft("u1", "a");
    expect(change).toHaveBeenCalledOnce();
    stop();
  });
});
