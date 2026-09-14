import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTranscriptionRouter } from "../server/transcription";
import { fileSubmissionStore } from "../server/transcriptionStore";

let server: Server, base: string, root: string;
const provider = vi.fn();
const listen = async () => {
  const app = express();
  app.use(
    "/api",
    createTranscriptionRouter({
      apiKey: "test-key",
      store: fileSubmissionStore(path.join(root, "jobs")),
      uploadRoot: root,
      maxFileBytes: 100,
      fetchImpl: provider,
      verifyToken: async (token) => {
        if (!["alice", "bob"].includes(token)) throw new Error();
        return token;
      },
    }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/transcription`;
};
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cheatmeet-assembly-"));
  provider
    .mockReset()
    .mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/upload")) {
        for await (const _chunk of init.body as any) {
          /* consume temp file */
        }
        return Response.json({ upload_url: "https://upload.test/our-audio" });
      }
      if (url.endsWith("/transcript"))
        return Response.json({ id: "provider-1" });
      if (url.includes("/transcript/"))
        return Response.json({
          status: "completed",
          speech_model_used: "universal-3-5-pro",
          text: "Keine Zusage.",
          utterances: [
            { start: 0, end: 1000, speaker: "A", text: "Keine Zusage." },
          ],
        });
      return Response.json({ token: "temporary-test-token" });
    });
  await listen();
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await vi.waitFor(async () =>
    expect((await readdir(root)).filter((v) => v !== "jobs")).toEqual([]),
  );
  await rm(root, { recursive: true, force: true });
});
const submit = (token = "alice", size = 10) => {
  const body = new FormData();
  body.append(
    "audio",
    new Blob([new Uint8Array(size)], { type: "audio/webm" }),
    "meeting.webm",
  );
  body.append("languages", '["de","en"]');
  return fetch(`${base}/final/meeting-1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
};
it("authenticates before accepting audio or using the provider", async () => {
  expect((await submit("invalid")).status).toBe(401);
  expect(provider).not.toHaveBeenCalled();
});
it("reserves atomically across simultaneous submissions and polls the same job after server restart", async () => {
  const results = await Promise.all([submit(), submit()]);
  expect(results.map((r) => r.status)).toEqual([202, 202]);
  expect(
    provider.mock.calls.filter(([url]) => url.endsWith("/transcript")),
  ).toHaveLength(1);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await listen();
  expect((await submit()).status).toBe(202);
  const response = await fetch(`${base}/final/meeting-1`, {
    headers: { Authorization: "Bearer alice" },
  });
  expect(await response.json()).toMatchObject({
    state: "completed",
    speech: { phase: "final", turns: [{ text: "Keine Zusage." }] },
  });
  expect(
    provider.mock.calls.filter(([url]) => url.endsWith("/transcript")),
  ).toHaveLength(1);
});
it("does not expose another account's job", async () => {
  await submit();
  expect(
    (
      await fetch(`${base}/final/meeting-1`, {
        headers: { Authorization: "Bearer bob" },
      })
    ).status,
  ).toBe(404);
});
it("never repeats a final submission after an uncertain provider POST", async () => {
  const original = provider.getMockImplementation()!;
  provider.mockImplementation(async (url, init) => {
    if (url.endsWith("/transcript"))
      throw new Error("connection lost after acceptance");
    return original(url, init);
  });
  expect((await submit()).status).toBe(503);
  expect((await submit()).status).toBe(202);
  expect(
    (
      await fetch(`${base}/final/meeting-1`, {
        headers: { Authorization: "Bearer alice" },
      })
    ).status,
  ).toBe(409);
  expect(
    provider.mock.calls.filter(([url]) => url.endsWith("/transcript")),
  ).toHaveLength(1);
});
it("rejects oversize uploads and removes temporary files", async () => {
  expect((await submit("alice", 101)).status).toBe(413);
  expect(provider).not.toHaveBeenCalled();
});
it("issues a single token per recording/source/session without leaking the long-lived key", async () => {
  const req = () =>
    fetch(`${base}/token`, {
      method: "POST",
      headers: {
        Authorization: "Bearer alice",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reportId: "meeting-1",
        source: "mic",
        session: 0,
        languages: ["de", "en"],
      }),
    });
  const first = await req();
  expect(await first.json()).toEqual({ token: "temporary-test-token" });
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect((await req()).status).toBe(409);
  expect(provider).toHaveBeenCalledOnce();
});
it("streams private Drive audio without passing the Drive credential to AssemblyAI", async () => {
  const original = provider.getMockImplementation()!;
  provider.mockImplementation(async (url, init) => {
    if (url.startsWith("https://www.googleapis.com/drive/")) {
      expect(init.headers.Authorization).toBe("Bearer drive-only-secret");
      return new Response(new Uint8Array(80));
    }
    expect(JSON.stringify(init.headers)).not.toContain("drive-only-secret");
    if (typeof init.body === "string")
      expect(init.body).not.toContain("drive-only-secret");
    return original(url, init);
  });
  const response = await fetch(`${base}/final/meeting-1`, {
    method: "POST",
    headers: {
      Authorization: "Bearer alice",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      driveFileId: "private-file",
      driveAccessToken: "drive-only-secret",
      languages: ["de", "en"],
    }),
  });
  expect(response.status).toBe(202);
  expect(provider.mock.calls.map((c) => c[0])).toEqual([
    "https://www.googleapis.com/drive/v3/files/private-file?alt=media",
    "https://api.eu.assemblyai.com/v2/upload",
    "https://api.eu.assemblyai.com/v2/transcript",
  ]);
});
it("a rejected Drive grant does not consume the final transcription reservation", async () => {
  provider.mockResolvedValue(new Response(null, { status: 403 }));
  const response = await fetch(`${base}/final/meeting-1`, {
    method: "POST",
    headers: {
      Authorization: "Bearer alice",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      driveFileId: "private-file",
      driveAccessToken: "expired",
      languages: ["de"],
    }),
  });
  expect(response.status).toBe(502);
  expect(
    (
      await fetch(`${base}/final/meeting-1`, {
        headers: { Authorization: "Bearer alice" },
      })
    ).status,
  ).toBe(404);
  expect(provider).toHaveBeenCalledOnce();
});

it("uses Pro native language detection without the incompatible language_codes parameter", async () => {
  expect((await submit()).status).toBe(202);
  const params = JSON.parse(provider.mock.calls.find(([url]) => url.endsWith('/transcript'))![1].body);
  expect(params.language_detection).toBe(true);
  expect(params.language_codes).toBeUndefined();
});
it("allows one atomic retry after explicit provider rejection, including across restart", async () => {
  const original = provider.getMockImplementation()!;
  let reject = true;
  provider.mockImplementation(async (url, init) => {
    if (url.endsWith('/transcript') && reject) return Response.json({ error: 'invalid settings' }, { status: 400 });
    return original(url, init);
  });
  expect((await submit()).status).toBe(502);
  const state = await fetch(`${base}/final/meeting-1`, { headers: { Authorization: 'Bearer alice' } });
  expect(await state.json()).toEqual({ state: 'retryable' });
  await new Promise<void>(resolve => server.close(() => resolve())); await listen();
  reject = false;
  expect((await Promise.all([submit(), submit()])).map(r => r.status)).toEqual([202, 202]);
  expect(provider.mock.calls.filter(([url]) => url.endsWith('/transcript'))).toHaveLength(2);
});
it("allows upload failure recovery without consuming a transcription pass", async () => {
  const original = provider.getMockImplementation()!;
  provider.mockImplementation(async (url, init) => {
    if (url.endsWith('/upload')) throw new Error('upload disconnected');
    return original(url, init);
  });
  expect((await submit()).status).toBe(503);
  expect(provider.mock.calls.filter(([url]) => url.endsWith('/transcript'))).toHaveLength(0);
  provider.mockImplementation(original);
  expect((await submit()).status).toBe(202);
});
it("keeps a 5xx submission outcome blocked and logs only stage/status, not provider bodies", async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (url, init) => url.endsWith('/transcript')
      ? Response.json({ error: 'private-url-and-secret' }, { status: 500 }) : original(url, init));
    expect((await submit()).status).toBe(502);
    expect((await fetch(`${base}/final/meeting-1`, { headers: { Authorization: 'Bearer alice' } })).status).toBe(409);
    expect(log.mock.calls.map(c => c[0]).join(' ')).toContain('"stage":"submit"');
    expect(log.mock.calls.map(c => c[0]).join(' ')).not.toContain('private-url-and-secret');
  } finally { log.mockRestore(); }
});
