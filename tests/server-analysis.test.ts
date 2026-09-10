import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAnalysisRouter } from "../server/analysis";

const report = {
  title: "Weekly Sync",
  summary: "Roadmap besprochen.",
  transcription: "Wir starten mit dem Roadmap-Update.",
  todos: ["Angebot senden"],
  takeaways: ["Launch verschiebt sich"],
};

describe("analysis endpoints", () => {
  let server: Server;
  let base: string;
  let root: string;
  let client: any;
  const verifyToken = vi.fn();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cheatmeet-test-"));
    verifyToken.mockReset().mockImplementation(async (token: string) => {
      if (token !== "valid-token") throw new Error("Invalid");
      return "user-1";
    });
    let index = 0;
    client = {
      files: {
        upload: vi.fn(async () => ({
          name: `files/${++index}`,
          uri: `https://example.test/${index}`,
          state: "ACTIVE",
          mimeType: "audio/webm",
        })),
        get: vi.fn(),
        delete: vi.fn(async () => ({})),
      },
      models: {
        generateContent: vi.fn(async () => ({ text: JSON.stringify(report) })),
      },
    };
    const app = express();
    app.use(
      "/api",
      createAnalysisRouter({
        createClient: () => client,
        verifyToken,
        uploadRoot: root,
        maxFileBytes: 1024,
        maxSegmentBytes: 1024,
        processingAttempts: 2,
        retryAttempts: 3,
        sleep: async () => {},
      }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    // The response can finish before the asynchronous finally cleanup.
    await vi.waitFor(async () => expect(await readdir(root)).toEqual([]));
    await rm(root, { recursive: true, force: true });
  });

  const audioBlob = (size = 8, mime = "audio/webm") =>
    new Blob([new Uint8Array(size)], { type: mime });

  const post = (route: string, form: FormData, token = "valid-token") =>
    fetch(`${base}/api/${route}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });

  function analyzeBody({
    transcription,
    audio,
    preferences,
    size = 8,
    mime = "audio/webm",
  }: {
    transcription?: string;
    audio?: boolean;
    preferences?: string;
    size?: number;
    mime?: string;
  }) {
    const form = new FormData();
    if (transcription !== undefined)
      form.append("transcription", transcription);
    if (audio) form.append("audio", audioBlob(size, mime), "recording.webm");
    if (preferences) form.append("preferences", preferences);
    return form;
  }

  function segmentBody({
    audio = true,
    previous,
    size = 8,
    mime = "audio/webm",
  }: {
    audio?: boolean;
    previous?: string;
    size?: number;
    mime?: string;
  } = {}) {
    const form = new FormData();
    if (audio) form.append("audio", audioBlob(size, mime), "segment.webm");
    if (previous !== undefined) form.append("previousTranscript", previous);
    return form;
  }

  describe("POST /analyze", () => {
    it.each(["", "expired-token"])(
      "rejects missing or invalid identity before any model call (%s)",
      async (token) => {
        const response = await post(
          "analyze",
          analyzeBody({ audio: true }),
          token,
        );
        expect(response.status).toBe(401);
        expect(client.models.generateContent).not.toHaveBeenCalled();
        expect(client.files.upload).not.toHaveBeenCalled();
      },
    );

    it("summarises a supplied transcript without uploading any audio", async () => {
      const response = await post(
        "analyze",
        analyzeBody({ transcription: "Wir starten mit dem Roadmap-Update." }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(report);
      expect(client.files.upload).not.toHaveBeenCalled();
      const request = client.models.generateContent.mock.calls[0][0];
      expect(request.contents[0].parts).toEqual([
        { text: "Wir starten mit dem Roadmap-Update." },
      ]);
      expect(request.config.responseJsonSchema).toBeDefined();
    });

    it("never sets temperature, which Gemini 3 ignores and warns can cause looping", async () => {
      await post("analyze", analyzeBody({ transcription: "Text" }));
      client.models.generateContent.mockResolvedValueOnce({
        text: "Abschnitt",
      });
      await post("transcribe-segment", segmentBody());
      for (const [request] of client.models.generateContent.mock.calls) {
        expect(request.config).not.toHaveProperty("temperature");
        expect(request.config).not.toHaveProperty("topP");
        expect(request.config).not.toHaveProperty("topK");
      }
    });

    it("keeps the supplied transcript instead of a shortened echo", async () => {
      client.models.generateContent.mockResolvedValueOnce({
        text: JSON.stringify({ ...report, transcription: "gekürzt" }),
      });
      const response = await post(
        "analyze",
        analyzeBody({ transcription: "Das vollständige Transkript." }),
      );
      expect((await response.json()).transcription).toBe(
        "Das vollständige Transkript.",
      );
    });

    it("uploads audio only when no transcript exists and cleans both copies", async () => {
      const response = await post("analyze", analyzeBody({ audio: true }));
      expect(response.status).toBe(200);
      expect(client.files.upload).toHaveBeenCalledWith(
        expect.objectContaining({ config: { mimeType: "audio/webm" } }),
      );
      expect(
        client.models.generateContent.mock.calls[0][0].contents[0].parts[0],
      ).toHaveProperty("fileData.fileUri", "https://example.test/1");
      await vi.waitFor(() =>
        expect(client.files.delete).toHaveBeenCalledWith({ name: "files/1" }),
      );
    });

    it("forwards the user's summary preferences to the model", async () => {
      await post(
        "analyze",
        analyzeBody({ transcription: "Text", preferences: "Immer auf Englisch" }),
      );
      expect(
        client.models.generateContent.mock.calls[0][0].config.systemInstruction,
      ).toContain("Immer auf Englisch");
    });

    it("rejects a request with neither transcript nor audio", async () => {
      expect((await post("analyze", analyzeBody({}))).status).toBe(400);
      expect(client.models.generateContent).not.toHaveBeenCalled();
    });

    it.each([
      { options: { audio: true, size: 1025 }, status: 413 },
      { options: { audio: true, mime: "text/html" }, status: 415 },
    ])("enforces upload restrictions ($status)", async ({ options, status }) => {
      expect((await post("analyze", analyzeBody(options))).status).toBe(status);
      expect(client.files.upload).not.toHaveBeenCalled();
    });

    it("waits for processing media to become active", async () => {
      client.files.upload.mockResolvedValueOnce({
        name: "files/pending",
        state: "PROCESSING",
      });
      client.files.get
        .mockResolvedValueOnce({ name: "files/pending", state: "PROCESSING" })
        .mockResolvedValueOnce({
          name: "files/pending",
          state: "ACTIVE",
          uri: "https://example.test/active",
        });
      expect((await post("analyze", analyzeBody({ audio: true }))).status).toBe(
        200,
      );
      expect(client.files.get).toHaveBeenCalledTimes(2);
      await vi.waitFor(() =>
        expect(client.files.delete).toHaveBeenCalledWith({
          name: "files/pending",
        }),
      );
    });

    it("rejects media the provider could not process and still cleans up", async () => {
      client.files.upload.mockResolvedValueOnce({
        name: "files/failed",
        state: "FAILED",
      });
      expect((await post("analyze", analyzeBody({ audio: true }))).status).toBe(
        502,
      );
      expect(client.models.generateContent).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(client.files.delete).toHaveBeenCalledWith({
          name: "files/failed",
        }),
      );
    });

    it.each(["invalid json", "{}", '{"title":"","summary":"x"}'])(
      "rejects unusable model output instead of saving an empty report",
      async (text) => {
        client.models.generateContent.mockResolvedValueOnce({ text });
        expect(
          (await post("analyze", analyzeBody({ transcription: "Text" })))
            .status,
        ).toBe(502);
      },
    );

    it("does not leak provider error details to the client", async () => {
      client.models.generateContent.mockRejectedValueOnce(
        new Error("Provider down: key sk-secret"),
      );
      const response = await post(
        "analyze",
        analyzeBody({ transcription: "Text" }),
      );
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("sk-secret");
    });

    it("prevents concurrent analyses for one user and frees the slot afterwards", async () => {
      let finish!: (value: { text: string }) => void;
      client.models.generateContent.mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      const first = post("analyze", analyzeBody({ transcription: "Erst" }));
      await vi.waitFor(() =>
        expect(client.models.generateContent).toHaveBeenCalledOnce(),
      );
      expect(
        (await post("analyze", analyzeBody({ transcription: "Zweit" }))).status,
      ).toBe(429);
      finish({ text: JSON.stringify(report) });
      expect((await first).status).toBe(200);
      expect(
        (await post("analyze", analyzeBody({ transcription: "Danach" })))
          .status,
      ).toBe(200);
    });

    it("keeps the slot of a running analysis when a rejected request fails", async () => {
      let finish!: (value: { text: string }) => void;
      client.models.generateContent.mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      const first = post("analyze", analyzeBody({ transcription: "Erst" }));
      await vi.waitFor(() =>
        expect(client.models.generateContent).toHaveBeenCalledOnce(),
      );
      // An oversized request must not release the running analysis's slot.
      expect(
        (await post("analyze", analyzeBody({ audio: true, size: 1025 })))
          .status,
      ).toBe(413);
      expect(
        (await post("analyze", analyzeBody({ transcription: "Zweit" }))).status,
      ).toBe(429);
      finish({ text: JSON.stringify(report) });
      expect((await first).status).toBe(200);
    });
  });

  describe("POST /transcribe-segment", () => {
    const transcript = (text: string) => ({ text });

    it.each(["", "expired-token"])(
      "rejects missing or invalid identity (%s)",
      async (token) => {
        expect((await post("transcribe-segment", segmentBody(), token)).status).toBe(
          401,
        );
        expect(client.files.upload).not.toHaveBeenCalled();
      },
    );

    it("returns the first segment verbatim without a glue call", async () => {
      client.models.generateContent.mockResolvedValueOnce(
        transcript("Guten Morgen zusammen."),
      );
      const response = await post("transcribe-segment", segmentBody());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "Guten Morgen zusammen." });
      expect(client.models.generateContent).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(client.files.delete).toHaveBeenCalledWith({ name: "files/1" }),
      );
    });

    it("uses shallow thinking for verbatim transcription and stitching", async () => {
      client.models.generateContent
        .mockResolvedValueOnce(transcript("Abschnitt"))
        .mockResolvedValueOnce(
          transcript(JSON.stringify({ continuation: "Abschnitt" })),
        );
      await post("transcribe-segment", segmentBody({ previous: "vorher" }));
      for (const [request] of client.models.generateContent.mock.calls)
        expect(request.config.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    });

    it("returns only the continuation when the segment overlaps the previous one", async () => {
      client.models.generateContent
        .mockResolvedValueOnce(transcript("bis später. Neuer Punkt: Budget."))
        .mockResolvedValueOnce(
          transcript(JSON.stringify({ continuation: "Neuer Punkt: Budget." })),
        );
      const response = await post(
        "transcribe-segment",
        segmentBody({ previous: "Wir machen Pause bis später." }),
      );
      expect(await response.json()).toEqual({ text: "Neuer Punkt: Budget." });
      const glue = client.models.generateContent.mock.calls[1][0];
      expect(glue.contents[0].parts[0].text).toContain(
        "Wir machen Pause bis später.",
      );
      expect(glue.contents[0].parts[0].text).toContain("Neuer Punkt: Budget.");
    });

    it("sends only the tail of a long transcript as glue context", async () => {
      const previous = "x".repeat(9000);
      client.models.generateContent
        .mockResolvedValueOnce(transcript("neuer Text"))
        .mockResolvedValueOnce(
          transcript(JSON.stringify({ continuation: "neuer Text" })),
        );
      await post("transcribe-segment", segmentBody({ previous }));
      const context =
        client.models.generateContent.mock.calls[1][0].contents[0].parts[0].text;
      expect(context.length).toBeLessThan(previous.length);
    });

    it("keeps the raw segment rather than losing speech when glue output is unusable", async () => {
      client.models.generateContent
        .mockResolvedValueOnce(transcript("vollständiger Abschnitt"))
        .mockResolvedValueOnce(transcript("not json at all"));
      const response = await post(
        "transcribe-segment",
        segmentBody({ previous: "vorher" }),
      );
      expect(await response.json()).toEqual({ text: "vollständiger Abschnitt" });
    });

    it("accepts an empty continuation when the segment adds nothing new", async () => {
      client.models.generateContent
        .mockResolvedValueOnce(transcript("schon bekannt"))
        .mockResolvedValueOnce(
          transcript(JSON.stringify({ continuation: "" })),
        );
      const response = await post(
        "transcribe-segment",
        segmentBody({ previous: "schon bekannt" }),
      );
      expect(await response.json()).toEqual({ text: "" });
    });

    it("returns empty text for silence without calling the glue step", async () => {
      client.models.generateContent.mockResolvedValueOnce(transcript("   "));
      const response = await post(
        "transcribe-segment",
        segmentBody({ previous: "vorher" }),
      );
      expect(await response.json()).toEqual({ text: "" });
      expect(client.models.generateContent).toHaveBeenCalledOnce();
    });

    it.each([
      { options: { size: 1025 }, status: 413 },
      { options: { mime: "text/html" }, status: 415 },
      { options: { audio: false }, status: 400 },
    ])("enforces segment upload restrictions ($status)", async ({ options, status }) => {
      expect(
        (await post("transcribe-segment", segmentBody(options))).status,
      ).toBe(status);
      expect(client.files.upload).not.toHaveBeenCalled();
    });

    it("retries a segment through a transient provider overload", async () => {
      const overloaded = Object.assign(new Error("UNAVAILABLE"), { status: 503 });
      client.models.generateContent
        .mockRejectedValueOnce(overloaded)
        .mockResolvedValueOnce(transcript("endlich da"));
      const response = await post("transcribe-segment", segmentBody());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "endlich da" });
      expect(client.models.generateContent).toHaveBeenCalledTimes(2);
    });

    it("reports exhausted quota as retryable rather than a generic failure", async () => {
      client.models.generateContent.mockRejectedValue(
        Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }),
      );
      const response = await post("transcribe-segment", segmentBody());
      expect(response.status).toBe(503);
      expect((await response.json()).error).toMatch(/überlastet|Kontingent/);
    });

    it("gives up after the retry budget instead of retrying forever", async () => {
      client.models.generateContent.mockRejectedValue(
        Object.assign(new Error("UNAVAILABLE"), { status: 503 }),
      );
      expect((await post("transcribe-segment", segmentBody())).status).toBe(503);
      expect(client.models.generateContent).toHaveBeenCalledTimes(3);
    });

    it("does not retry a request the provider rejected as invalid", async () => {
      client.models.generateContent.mockRejectedValue(
        Object.assign(new Error("INVALID_ARGUMENT"), { status: 400 }),
      );
      await post("transcribe-segment", segmentBody());
      expect(client.models.generateContent).toHaveBeenCalledOnce();
    });

    it("retries a segment through a transient provider overload", async () => {
      client.models.generateContent
        .mockRejectedValueOnce(
          Object.assign(new Error("UNAVAILABLE"), { status: 503 }),
        )
        .mockResolvedValueOnce(transcript("endlich da"));
      const response = await post("transcribe-segment", segmentBody());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "endlich da" });
      expect(client.models.generateContent).toHaveBeenCalledTimes(2);
    });

    it("reports exhausted quota as retryable rather than a generic failure", async () => {
      client.models.generateContent.mockRejectedValue(
        Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }),
      );
      const response = await post("transcribe-segment", segmentBody());
      expect(response.status).toBe(503);
      expect((await response.json()).error).toMatch(/überlastet|Kontingent/);
    });

    it("gives up after the retry budget instead of retrying forever", async () => {
      client.models.generateContent.mockRejectedValue(
        Object.assign(new Error("UNAVAILABLE"), { status: 503 }),
      );
      expect((await post("transcribe-segment", segmentBody())).status).toBe(503);
      expect(client.models.generateContent).toHaveBeenCalledTimes(3);
    });

    it("does not retry a request the provider rejected as invalid", async () => {
      client.models.generateContent.mockRejectedValue(
        Object.assign(new Error("INVALID_ARGUMENT"), { status: 400 }),
      );
      await post("transcribe-segment", segmentBody());
      expect(client.models.generateContent).toHaveBeenCalledOnce();
    });

    it("runs alongside a busy analysis instead of competing for its slot", async () => {
      let finish!: (value: { text: string }) => void;
      client.models.generateContent.mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      const analysis = post("analyze", analyzeBody({ transcription: "Text" }));
      await vi.waitFor(() =>
        expect(client.models.generateContent).toHaveBeenCalledOnce(),
      );
      client.models.generateContent.mockResolvedValueOnce(
        transcript("Segmenttext"),
      );
      expect((await post("transcribe-segment", segmentBody())).status).toBe(200);
      finish({ text: JSON.stringify(report) });
      expect((await analysis).status).toBe(200);
    });
  });
});
