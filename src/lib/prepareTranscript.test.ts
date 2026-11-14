import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "../types";

const mocks = vi.hoisted(() => ({
  auth: {
    currentUser: { uid: "alice", getIdToken: async () => "identity" } as any,
  },
  putDraft: vi.fn(),
  getDraft: vi.fn(),
  putLocal: vi.fn(),
  getLocal: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("./firebase", () => ({ auth: mocks.auth, db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn(),
  getDoc: async () => ({ exists: () => false }),
}));
vi.mock("./local", () => ({
  ReportConflictError: class extends Error { constructor() { super("Neuere Fassung laden"); this.name = "ReportConflictError"; } },
  getLocal: mocks.getLocal,
  putDraft: mocks.putDraft,
  getDraft: mocks.getDraft,
  putLocal: mocks.putLocal,
}));
vi.mock("./reports", () => ({ uid: () => mocks.auth.currentUser.uid }));
vi.mock("./webmDuration", () => ({
  withWebmDuration: async (blob: Blob) => blob,
}));
import { analyzeDraft } from "./workflow";
import { prepareTranscript } from "./prepareTranscript";

const draft = (): Draft => ({
  audio: new Blob(["test"], { type: "audio/webm" }),
  report: {
    id: "meeting",
    date: "2026-09-14",
    title: "Test",
    transcription: "",
    transcriptionOrigin: "import",
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
  mocks.getDraft.mockReset();
  let stored: any;
  mocks.putLocal.mockReset().mockImplementation(async (_owner, next, _dirty = true, expected) => {
    if (expected !== undefined && expected !== (stored?.report.updatedAt ?? null)) throw Object.assign(new Error("Neuere Fassung laden"), { name: "ReportConflictError" });
    stored = { report: structuredClone(next), dirty: true };
  });
  mocks.getLocal.mockReset().mockImplementation(async () => stored && structuredClone(stored));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not replace a human transcript with a late ASR checkpoint", async () => {
  const d = draft();
  d.retranscribe = true;
  d.report.updatedAt = "2026-11-01T00:00:00.000Z";
  let stored = structuredClone(d.report);
  mocks.getLocal.mockImplementation(async () => ({ report: structuredClone(stored), dirty: true }));
  mocks.putLocal.mockImplementation(async (_owner, next, _dirty, expected) => {
    if (expected !== undefined && expected !== stored.updatedAt) throw Object.assign(new Error("Neuere Fassung laden"), { name: "ReportConflictError" });
    stored = structuredClone(next);
  });
  mocks.fetch.mockImplementation(async () => {
    stored = { ...stored, title: "Menschliche Korrektur", transcription: "Exakt korrigiert", updatedAt: "2026-11-02T00:00:00.000Z" };
    return Response.json(final());
  });
  await expect(prepareTranscript(d)).rejects.toMatchObject({ name: "ReportConflictError" });
  expect(stored).toMatchObject({ title: "Menschliche Korrektur", transcription: "Exakt korrigiert" });
  expect(mocks.putDraft).not.toHaveBeenCalled();
  expect(d.retranscribe).toBe(true);
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
  const running = prepareTranscript(d);
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
  await expect(prepareTranscript(draft())).rejects.toThrow("unbestätigt");
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
  const running = prepareTranscript(d, "short-drive-grant");
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
  mocks.fetch
    .mockResolvedValueOnce(Response.json({ state: "retryable" }))
    .mockResolvedValueOnce(
      Response.json({ state: "processing" }, { status: 202 }),
    )
    .mockResolvedValueOnce(Response.json(final()));
  const d = draft();
  const running = prepareTranscript(d);
  await vi.runAllTimersAsync();
  await running;
  expect(mocks.fetch.mock.calls.map((c) => c[1].method || "GET")).toEqual([
    "GET",
    "POST",
    "GET",
  ]);
  expect(d.report.speech?.speakerReview).toBe("skipped");
});
it("a deliberate skipped review permits the final text summary without any new ASR call", async () => {
  const d = draft();
  d.report.speech = { ...final().speech, speakerReview: "skipped" } as any;
  d.report.transcription = "Finaler Text";
  mocks.fetch.mockResolvedValue(
    Response.json({
      title: "Test",
      summary: "Zusammenfassung",
      transcription: "Echo",
      todos: [],
      takeaways: [],
    }),
  );
  await analyzeDraft(d);
  expect(mocks.fetch.mock.calls.map((c) => c[0])).toEqual(["/api/analyze"]);
});

it("uses the live transcript and maintained names directly, without any ASR request", async () => {
  const d = draft();
  const text =
    "Wir haben heute den Vertrag gemeinsam geprüft und noch keine Zusage erteilt";
  d.report.transcriptionOrigin = "live";
  d.report.speech!.turns = [
    {
      id: "mic:0:0",
      speaker: "mic:0:A",
      startMs: 0,
      endMs: 1000,
      text,
      final: true,
    },
  ];
  d.report.speech!.speakerNames = { "mic:0:A": "Alex" };
  d.report.speech!.speakerAliases = { "mic:0:A": "Alex" };
  mocks.fetch.mockImplementation(async (url, init) => {
    if (url === "/api/analyze") {
      expect(init.body.get("audio")).toBeNull();
      expect(init.body.get("transcription")).toContain("Mikrofon · Alex");
      return Response.json({
        title: "Test",
        summary: "Alex prüft den Vertrag.",
        transcription: "Echo",
        todos: [],
        takeaways: [],
      });
    }
    const response = final();
    response.speech.turns[0].text = text;
    return Response.json(response);
  });
  const result = await analyzeDraft(d);
  expect(result.speech?.speakerReview).toBe("skipped");
  expect(result.transcription).toContain("Mikrofon · Alex");
  expect(mocks.putDraft).toHaveBeenCalled();
  expect(mocks.fetch.mock.calls.map((c) => c[0])).toEqual(["/api/analyze"]);
});

it("matches against the user-maintained reference before late provider label revisions", async () => {
  const d = draft();
  d.report.transcriptionOrigin = "live";
  const text =
    "Wir haben heute den Vertrag gemeinsam geprüft und noch keine Zusage erteilt";
  d.speakerReference = {
    ...d.report.speech!,
    turns: [
      {
        id: "mic:0:0",
        speaker: "mic:0:A",
        text,
        startMs: 0,
        endMs: 1000,
        final: true,
      },
    ],
    speakerNames: { "mic:0:A": "Alex" },
    speakerAliases: { "mic:0:A": "Alex" },
  };
  d.report.speech = {
    ...d.speakerReference,
    turns: d.speakerReference.turns.map((t) => ({ ...t, speaker: "mic:0:B" })),
    speakerNames: { "mic:0:B": "Nina" },
  };
  const response = final();
  response.speech.turns[0].text = text;
  mocks.fetch.mockResolvedValue(Response.json(response));
  await prepareTranscript(d);
  expect(d.report.speech?.turns[0].speaker).toBe("mic:0:A");
  expect(d.report.speech?.speakerAliases?.["mic:0:A"]).toBe("Alex");
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("does not retranscribe an empty or failed live recording, including when analysis is retried", async () => {
  const d = draft();
  d.report.transcriptionOrigin = "live";
  d.report.speech!.liveWarning = "Verbindung fehlgeschlagen";
  await expect(analyzeDraft(d)).rejects.toThrow("Kein Live-Transkript");
  await expect(analyzeDraft(d)).rejects.toThrow("Kein Live-Transkript");
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(d.audio).toBeDefined();
});
it("keeps visible unconfirmed words and microphone/system labels in the saved transcript", async () => {
  const d = draft();
  d.report.transcriptionOrigin = "live";
  d.report.speech!.speakerNames = {
    "mic:0:A": "Alex",
    "system:1:A": "Fireship",
  };
  d.report.speech!.turns = [
    {
      id: "mic:0:0",
      speaker: "mic:0:A",
      text: "Ich prüfe das",
      startMs: 0,
      endMs: 500,
      final: true,
    },
    {
      id: "system:1:0",
      speaker: "system:1:A",
      text: "We will send",
      startMs: 1000,
      endMs: 1500,
      final: false,
    },
  ];
  const before = structuredClone(d.report.speech!.turns);
  await prepareTranscript(d);
  expect(d.report.speech!.turns).toEqual(before);
  expect(d.report.transcription).toContain("Mikrofon · Alex");
  expect(d.report.transcription).toContain("Systemaudio · Fireship");
  expect(d.report.transcription).toContain("We will send");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("recognizes older captured drafts without the new origin marker", async () => {
  const d = draft();
  delete d.report.transcriptionOrigin;
  d.report.captureSources = ["mic"];
  await prepareTranscript(d);
  expect(d.report.transcriptionOrigin).toBe("live");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("never falls back to audio when a legacy captured draft lacks structured speech", async () => {
  const d = draft();
  delete d.report.speech;
  delete d.report.transcriptionOrigin;
  d.report.captureState = "stopped";
  await expect(analyzeDraft(d)).rejects.toThrow("Kein Live-Transkript");
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("shares a locally finalized live transcript with concurrent callers without an audio fallback", async () => {
  const first = draft();
  first.report.transcriptionOrigin = "live";
  const second = structuredClone(first);
  let release!: () => void;
  mocks.putDraft.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  mocks.getDraft.mockImplementation(async () => first);
  const one = prepareTranscript(first);
  const two = prepareTranscript(second);
  await vi.advanceTimersByTimeAsync(0);
  release();
  await Promise.all([one, two]);
  expect(second.report.speech?.phase).toBe("final");
  expect(second.report.transcriptionOrigin).toBe("live");
  expect(second.report.updatedAt).toBe(first.report.updatedAt);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("optionally retranscribes a finished live recording once, preserving matched names", async () => {
  const d = draft();
  d.report.transcriptionOrigin = "live";
  d.report.rawAudioUrl = "saved-recording";
  d.report.speech!.phase = "final";
  const text = "Wir haben heute den gesamten Vertrag gemeinsam im Detail geprüft und noch keine verbindliche Zusage erteilt";
  d.report.speech!.turns = [{ id: "mic:0:0", speaker: "mic:0:A", startMs: 0, endMs: 1000, text, final: true }];
  d.report.speech!.speakerNames = { "mic:0:A": "Alex" };
  d.report.speech!.speakerAliases = { "mic:0:A": "Alex" };
  Object.assign(d, { retranscribe: true });
  const response = final();
  response.speech.turns[0].text = text;
  mocks.fetch
    .mockResolvedValueOnce(Response.json({ state: "missing" }, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ state: "processing" }, { status: 202 }))
    .mockResolvedValueOnce(Response.json(response));
  const running = prepareTranscript(d, "drive-token");
  await vi.runAllTimersAsync();
  await running;
  expect(mocks.fetch.mock.calls.map(([url, init]) => [url, init.method || "GET"])).toEqual([
    ["/api/transcription/import/meeting", "GET"],
    ["/api/transcription/import/meeting", "POST"],
    ["/api/transcription/import/meeting", "GET"],
  ]);
  expect(d.report.speech?.turns[0].id).toBe("batch:0");
  expect(d.report.transcription).toContain("Alex");
  expect(d.report.transcriptionOrigin).toBe("live");
  expect(d).toMatchObject({ retranscribe: false });
  await prepareTranscript(d, "drive-token");
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
});

it("keeps the live text and opt-in on an uncertain batch failure, then resumes the existing job", async () => {
  const d = draft();
  d.report.transcriptionOrigin = "live";
  d.report.transcription = "Vorhandener Live-Text";
  d.report.speech!.phase = "final";
  d.retranscribe = true;
  mocks.fetch.mockResolvedValueOnce(Response.json({ error: "Auftrag unbestätigt" }, { status: 409 }));
  await expect(prepareTranscript(d, "token")).rejects.toThrow("unbestätigt");
  expect(d.report.transcription).toBe("Vorhandener Live-Text");
  expect(d.retranscribe).toBe(true);
  mocks.fetch.mockResolvedValueOnce(Response.json(final()));
  await prepareTranscript(d, "token");
  expect(mocks.fetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
  expect(d.report.transcription).toContain("Keine Zusage.");
  expect(d.report.speech?.speakerReview).toBe("pending");
  expect(d.retranscribe).toBe(false);
});

it("only-backing-up a live recording never spends a batch pass despite the opt-in", async () => {
  const d = draft();
  d.report.transcriptionOrigin = "live";
  d.retranscribe = true;
  await prepareTranscript(d, "token", { batch: false });
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(d.report.speech?.phase).toBe("final");
});

describe("declining the analysis", () => {
  it("does not submit a paid transcription for an import", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const draft = {
      report: {
        id: "r1",
        date: "2026-09-16T08:00:00.000Z",
        title: "",
        summary: "",
        transcription: "",
        todos: [],
        takeaways: [],
        transcriptionOrigin: "import" as const,
        // importAudio always leaves a pending speech document behind.
        speech: {
          provider: "assemblyai",
          phase: "pending",
          languages: ["de"],
          turns: [],
          speakerNames: {},
        },
      },
    } as never;
    await expect(
      prepareTranscript(draft, "token", { batch: false }),
    ).rejects.toThrow("Sichern & Zusammenfassen");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
