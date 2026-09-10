import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAnalysisRouter } from "../server/analysis";

const report = {
  title: "Begehung",
  summary: "Baustelle",
  rooms: [
    {
      name: "Keller",
      transcription: "Wir sind im Keller.",
      summary: "Trocken",
      photoIds: ["photo-1.jpg"],
      tags: ["Fortschritt"],
    },
  ],
};
describe("authenticated analysis endpoint", () => {
  let server: Server;
  let base: string;
  let root: string;
  let client: any;
  const verifyToken = vi.fn();
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "baudoku-test-"));
    verifyToken.mockReset().mockImplementation(async (token) => {
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
        processingAttempts: 2,
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
  function body({
    photo = true,
    metadata = JSON.stringify([{ id: "photo-1.jpg", relativeTimeMs: 3000 }]),
    audio = true,
    size = 8,
    mime = "audio/webm",
  } = {}) {
    const form = new FormData();
    if (audio)
      form.append(
        "audio",
        new Blob([new Uint8Array(size)], { type: mime }),
        "recording.webm",
      );
    if (photo)
      form.append(
        "photos",
        new Blob(["image"], { type: "image/jpeg" }),
        "photo-1.jpg",
      );
    form.append("photoTimestamps", photo ? metadata : "[]");
    return form;
  }
  const send = (form: FormData, token = "valid-token") =>
    fetch(`${base}/api/analyze`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });

  it("authenticates, passes MIME config and exact photo IDs, returns a report, cleans all files", async () => {
    const response = await send(body());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(verifyToken).toHaveBeenCalledWith("valid-token");
    expect(client.files.upload).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ config: { mimeType: "audio/webm" } }),
    );
    expect(client.files.upload).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ config: { mimeType: "image/jpeg" } }),
    );
    const request = client.models.generateContent.mock.calls[0][0];
    expect(request.config.responseJsonSchema).toBeDefined();
    expect(request.contents[0].parts[1].text).toContain("photo-1.jpg");
    expect(request.contents[0].parts[1].text).toContain("3 Sekunden");
    await vi.waitFor(() =>
      expect(client.files.delete).toHaveBeenCalledTimes(2),
    );
  });
  it.each(["", "expired-token"])(
    "rejects missing or invalid identity before uploading (%s)",
    async (token) => {
      const response = await send(body(), token);
      expect(response.status).toBe(401);
      expect(client.files.upload).not.toHaveBeenCalled();
    },
  );
  it.each([
    "{broken",
    '[{"id":"wrong.jpg","relativeTimeMs":3000}]',
    '[{"id":"photo-1.jpg","relativeTimeMs":-1}]',
  ])(
    "rejects malformed timestamp metadata and cleans local uploads",
    async (metadata) => {
      const response = await send(body({ metadata }));
      expect(response.status).toBe(400);
      expect(client.files.upload).not.toHaveBeenCalled();
    },
  );
  it("rejects missing audio and cleans uploaded photos", async () => {
    expect((await send(body({ audio: false }))).status).toBe(400);
  });
  it.each([
    { options: { size: 1025 }, status: 413 },
    { options: { mime: "text/html" }, status: 415 },
  ])("enforces upload restrictions ($status)", async ({ options, status }) => {
    // Each case has its own router. A response may arrive before asynchronous
    // cleanup releases the per-user concurrency guard.
    expect((await send(body(options))).status).toBe(status);
    expect(client.files.upload).not.toHaveBeenCalled();
  });
  it("accepts the full supported photo count and rejects one extra", async () => {
    for (const count of [30, 31]) {
      const form = new FormData();
      form.append(
        "audio",
        new Blob(["audio"], { type: "audio/webm" }),
        "audio.webm",
      );
      const metadata = Array.from({ length: count }, (_, index) => ({
        id: `photo-${index}.jpg`,
        relativeTimeMs: index * 1000,
      }));
      for (const photo of metadata)
        form.append(
          "photos",
          new Blob(["image"], { type: "image/jpeg" }),
          photo.id,
        );
      form.append("photoTimestamps", JSON.stringify(metadata));
      const response = await send(form);
      expect(response.status).toBe(count === 30 ? 200 : 400);
      await vi.waitFor(async () => expect(await readdir(root)).toEqual([]));
    }
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
    expect((await send(body({ photo: false }))).status).toBe(200);
    expect(client.files.get).toHaveBeenCalledTimes(2);
    expect(client.files.delete).toHaveBeenCalledWith({ name: "files/pending" });
  });
  it("labels legacy unknown photo timestamps explicitly without fabricating time", async () => {
    const response = await send(
      body({
        metadata: JSON.stringify([{ id: "photo-1.jpg", relativeTimeMs: null }]),
      }),
    );
    expect(response.status).toBe(200);
    expect(
      client.models.generateContent.mock.calls[0][0].contents[0].parts[1].text,
    ).toContain("Aufnahmezeit unbekannt");
  });
  it("filters unknown tags and keeps valid grounded room timing", async () => {
    client.models.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        ...report,
        rooms: [
          {
            ...report.rooms[0],
            tags: ["Mangel", "invented", "Mangel"],
            startTimeMs: 1000,
            endTimeMs: 3000,
          },
        ],
      }),
    });
    const response = await send(body());
    expect((await response.json()).rooms[0]).toMatchObject({
      tags: ["Mangel"],
      startTimeMs: 1000,
      endTimeMs: 3000,
    });
  });
  it("rejects failed media and still removes remote and local files", async () => {
    client.files.upload.mockResolvedValueOnce({
      name: "files/failed",
      state: "FAILED",
    });
    expect((await send(body())).status).toBe(502);
    expect(client.models.generateContent).not.toHaveBeenCalled();
    expect(client.files.delete).toHaveBeenCalledWith({ name: "files/failed" });
  });
  it("cleans earlier remote uploads when a later upload fails", async () => {
    client.files.upload
      .mockResolvedValueOnce({
        name: "files/audio",
        state: "ACTIVE",
        uri: "https://example.test/audio",
      })
      .mockRejectedValueOnce(new Error("Provider down"));
    const response = await send(body());
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(
      "Provider down",
    );
    expect(client.files.delete).toHaveBeenCalledWith({ name: "files/audio" });
  });
  it.each([
    "invalid json",
    "{}",
    '{"title":"Empty","summary":"No content","rooms":[]}',
  ])(
    "rejects invalid model output instead of saving an error report",
    async (text) => {
      client.models.generateContent.mockResolvedValueOnce({ text });
      expect((await send(body())).status).toBe(502);
      await vi.waitFor(() =>
        expect(client.files.delete).toHaveBeenCalledTimes(2),
      );
    },
  );
  it("removes unknown and duplicate model photo assignments", async () => {
    client.models.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        ...report,
        rooms: [
          {
            ...report.rooms[0],
            photoIds: ["photo-1.jpg", "invented.jpg", "photo-1.jpg"],
          },
        ],
      }),
    });
    const response = await send(body());
    expect((await response.json()).rooms[0].photoIds).toEqual(["photo-1.jpg"]);
  });
  it("prevents concurrent analyses for one user", async () => {
    let finish!: (value: { text: string }) => void;
    client.models.generateContent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = send(body());
    await vi.waitFor(() =>
      expect(client.models.generateContent).toHaveBeenCalledOnce(),
    );
    expect((await send(body())).status).toBe(429);
    finish({ text: JSON.stringify(report) });
    expect((await first).status).toBe(200);
  });
});
