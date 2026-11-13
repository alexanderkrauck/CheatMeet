import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    currentUser: { uid: "alice", getIdToken: async () => "identity" } as any,
  },
  fetch: vi.fn(),
}));
vi.mock("./firebase", () => ({ auth: mocks.auth }));
import {
  processingAvailable,
  submitServerProcessing,
  getServerProcessing,
  listServerProcessing,
  resetProcessingConfig,
} from "./serverProcessing";

beforeEach(() => {
  mocks.auth.currentUser = { uid: "alice", getIdToken: async () => "identity" };
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  resetProcessingConfig();
});
it("only caches a successful configuration response", async () => {
  mocks.fetch.mockRejectedValueOnce(new TypeError("offline"));
  await expect(processingAvailable()).rejects.toThrow();
  mocks.fetch.mockResolvedValueOnce(Response.json({ enabled: true }));
  expect(await processingAvailable()).toBe(true);
  expect(await processingAvailable()).toBe(true);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
it("submits durable references, not transcript/audio or Google credentials", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json(
      { job: { reportId: "m1", state: "queued" } },
      { status: 202 },
    ),
  );
  const report = {
    id: "m1",
    date: "2026-11-13",
    title: "Meeting",
    transcription: "private words",
    speech: { speakerNames: {}, turns: [{ speaker: "mic:A", text: "words" }] },
    summary: "",
    todos: [],
    takeaways: [],
    driveReportId: "json",
    driveFolderId: "folder",
    rawAudioUrl: "audio",
  } as any;
  await submitServerProcessing(report, { analyze: true, retranscribe: true });
  const [url, init] = mocks.fetch.mock.calls[0];
  expect(url).toBe("/api/processing/m1");
  expect(init.headers.Authorization).toBe("Bearer identity");
  expect(JSON.parse(init.body)).toMatchObject({
    analyze: true,
    retranscribe: true,
    report: { id: "m1", driveReportId: "json" },
  });
  expect(init.body).not.toContain("private words");
  expect(init.body).not.toContain('"speech"');
});
it("submits Microsoft home refs with the new-consumer header, never legacy Google IDs", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json(
      { job: { reportId: "ms", state: "queued" } },
      { status: 202 },
    ),
  );
  const home = {
    provider: "microsoft" as const,
    connectionId: "c",
    driveId: "d",
    rootId: "root",
    rootName: "Meetings",
    folderId: "f",
    reportId: "json",
    audioId: "audio",
  };
  await submitServerProcessing(
    {
      id: "ms",
      home,
      date: "2026-11-13",
      title: "Meeting",
      summary: "",
      transcription: "private",
      todos: [],
      takeaways: [],
    },
    { analyze: false },
  );
  const init = mocks.fetch.mock.calls[0][1];
  expect(init.headers["X-CheatMeet-Storage"]).toBe("microsoft");
  expect(JSON.parse(init.body).report.home).toEqual(home);
  expect(init.body).not.toContain("rawAudioUrl");
  expect(init.body).not.toContain("private");
});
it("refuses an account switch before dispatch", async () => {
  mocks.auth.currentUser.getIdToken = async () => {
    mocks.auth.currentUser = { uid: "bob" };
    return "identity";
  };
  await expect(getServerProcessing("m1")).rejects.toThrow("Konto");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("does not accept another account's response", async () => {
  mocks.fetch.mockImplementation(async () => {
    mocks.auth.currentUser = { uid: "bob" };
    return Response.json({ jobs: [] });
  });
  await expect(listServerProcessing()).rejects.toThrow("Konto");
});
it("surfaces a rejected handoff instead of claiming server ownership", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({ error: "Warteschlange nicht erreichbar" }, { status: 503 }),
  );
  await expect(
    submitServerProcessing({ id: "m1" } as any, { analyze: true }),
  ).rejects.toThrow("Warteschlange");
});
