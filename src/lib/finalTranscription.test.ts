import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Draft } from "../types";

const mocks = vi.hoisted(() => ({
  auth: {
    currentUser: { uid: "alice", getIdToken: async () => "identity" } as any,
  },
  putDraft: vi.fn(),
  putLocal: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("./firebase", () => ({ auth: mocks.auth, db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn(),
  getDoc: async () => ({ exists: () => false }),
}));
vi.mock("./local", () => ({
  putDraft: mocks.putDraft,
  putLocal: mocks.putLocal,
}));
vi.mock("./reports", () => ({ uid: () => mocks.auth.currentUser.uid }));
vi.mock("./webmDuration", () => ({
  withWebmDuration: async (blob: Blob) => blob,
}));
import { analyzeDraft } from "./workflow";
import { ensureFinalTranscript } from "./finalTranscription";

const draft = (): Draft => ({
  audio: new Blob(["test"], { type: "audio/webm" }),
  report: {
    id: "meeting",
    date: "2026-09-14",
    title: "Test",
    transcription: "Erfundener Live-Text",
    summary: "",
    todos: [],
    takeaways: [],
    speech: {
      provider: "assemblyai",
      phase: "pending",
      languages: ["de", "en"],
      speakerNames: {},
      turns: [],
    },
  },
});
const final = (empty = false) => ({
  state: "completed",
  speech: {
    provider: "assemblyai",
    phase: "final",
    languages: ["de", "en"],
    speakerNames: {},
    turns: empty
      ? []
      : [
          {
            id: "batch:0",
            startMs: 0,
            endMs: 1000,
            speaker: "batch:A",
            text: "Keine Zusage.",
            final: true,
          },
        ],
  },
});
beforeEach(() => {
  vi.useFakeTimers();
  mocks.auth.currentUser = { uid: "alice", getIdToken: async () => "identity" };
  mocks.fetch.mockReset();
  mocks.putDraft.mockReset();
  mocks.putLocal.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("checkpoints the final transcript before summarizing, and ignores the summary model's echoed transcript", async () => {
  let saved = false;
  mocks.putDraft.mockImplementation(async () => {
    saved = true;
  });
  mocks.fetch.mockImplementation(async (url, init) => {
    if (url === "/api/analyze") {
      expect(saved).toBe(true);
      expect(init.body.get("audio")).toBeNull();
      expect(init.body.get("transcription")).toBe(
        "[0:00] (Sprecher 1) Keine Zusage.",
      );
      return Response.json({
        title: "Test",
        summary: "Keine Zusage erteilt.",
        transcription: "Modell-Echo",
        todos: [],
        takeaways: [],
      });
    }
    return Response.json(final());
  });
  const d = draft();
  await expect(analyzeDraft(d)).rejects.toThrow("Sprecher prüfen");
  expect(mocks.fetch.mock.calls.map(c => c[0])).not.toContain("/api/analyze");
  d.report.speech!.speakerReview = "reviewed";
  const result = await analyzeDraft(d);
  expect(result.transcription).toContain("Keine Zusage.");
  expect(result.transcription).not.toContain("Modell-Echo");
  const calls = mocks.fetch.mock.calls.length;
  await analyzeDraft(d);
  expect(mocks.fetch.mock.calls.slice(calls).map((c) => c[0])).toEqual([
    "/api/analyze",
  ]);
});
it("a successful silent final transcript never sends audio to Gemini", async () => {
  mocks.fetch.mockResolvedValue(Response.json(final(true)));
  expect(await analyzeDraft(draft())).toMatchObject({
    status: "completed",
    transcription: "",
    summary: "Keine Sprache erkannt.",
  });
  expect(mocks.fetch).toHaveBeenCalledOnce();
});
it("submits a missing job once and then only polls", async () => {
  mocks.fetch
    .mockResolvedValueOnce(Response.json({ state: "missing" }, { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({ state: "processing" }, { status: 202 }),
    )
    .mockResolvedValueOnce(Response.json(final()));
  const d = draft();
  const running = ensureFinalTranscript(d);
  await vi.runAllTimersAsync();
  await running;
  expect(mocks.fetch.mock.calls.map((c) => c[1].method || "GET")).toEqual([
    "GET",
    "POST",
    "GET",
  ]);
  expect(d.report.speech?.phase).toBe("final");
});
it("does not persist or summarize another account's response", async () => {
  mocks.fetch.mockImplementation(async () => {
    mocks.auth.currentUser = { uid: "bob" };
    return Response.json(final());
  });
  await expect(analyzeDraft(draft())).rejects.toThrow("Konto");
  expect(mocks.putDraft).not.toHaveBeenCalled();
  expect(mocks.putLocal).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledOnce();
});
it("an uncertain reservation is surfaced without resubmitting audio", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({ error: "Auftrag unbestätigt" }, { status: 409 }),
  );
  await expect(ensureFinalTranscript(draft())).rejects.toThrow("unbestätigt");
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.fetch.mock.calls[0][1].method).toBeUndefined();
});
it("uses a small Drive-reference request once audio is backed up", async () => {
  mocks.fetch
    .mockResolvedValueOnce(Response.json({ state: "missing" }, { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({ state: "processing" }, { status: 202 }),
    )
    .mockResolvedValueOnce(Response.json(final()));
  const d = draft();
  d.report.rawAudioUrl = "private-drive-file";
  d.audio = undefined;
  const running = ensureFinalTranscript(d, "short-drive-grant");
  await vi.runAllTimersAsync();
  await running;
  const submitted = mocks.fetch.mock.calls[1][1];
  expect(submitted.headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(submitted.body)).toEqual({
    driveFileId: "private-drive-file",
    driveAccessToken: "short-drive-grant",
    languages: ["de", "en"],
  });
});
it("retries a server-confirmed unused pass but still performs just one accepted final submission", async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ state: "retryable" }))
    .mockResolvedValueOnce(Response.json({ state: "processing" }, { status: 202 }))
    .mockResolvedValueOnce(Response.json(final()));
  const d = draft();
  const running = ensureFinalTranscript(d);
  await vi.runAllTimersAsync(); await running;
  expect(mocks.fetch.mock.calls.map(c => c[1].method || "GET")).toEqual(["GET", "POST", "GET"]);
  expect(d.report.speech?.speakerReview).toBe("pending");
});
it("a deliberate skipped review permits the final text summary without any new ASR call", async () => {
  const d = draft(); d.report.speech = { ...final().speech, speakerReview: "skipped" } as any;
  d.report.transcription = "Finaler Text";
  mocks.fetch.mockResolvedValue(Response.json({ title: "Test", summary: "Zusammenfassung", transcription: "Echo", todos: [], takeaways: [] }));
  await analyzeDraft(d);
  expect(mocks.fetch.mock.calls.map(c => c[0])).toEqual(["/api/analyze"]);
});
