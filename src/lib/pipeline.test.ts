import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ currentUser: { uid: "user-1" } }));
const remote = vi.hoisted(() => ({ available: vi.fn(), submit: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock("./serverProcessing", () => ({ processingAvailable: remote.available, submitServerProcessing: remote.submit, listServerProcessing: remote.list, getServerProcessing: remote.get }));
vi.mock("./firebase", () => ({ auth: account }));
const finalTranscript = vi.hoisted(() => vi.fn());
vi.mock("./prepareTranscript", () => ({ prepareTranscript: finalTranscript }));
const backupDraft = vi.fn();
const syncReport = vi.fn();
const analyzeDraft = vi.fn();
const saveReport = vi.fn();
const putLocal = vi.fn();
const deleteDraft = vi.fn();
const acceptRemoteReport = vi.fn();

vi.mock("./workflow", () => ({
  backupDraft: (...args: unknown[]) => backupDraft(...args),
  syncReport: (...args: unknown[]) => syncReport(...args),
  analyzeDraft: (...args: unknown[]) => analyzeDraft(...args),
}));
vi.mock("./reports", () => ({
  saveReport: (...args: unknown[]) => saveReport(...args),
}));
vi.mock("./local", () => ({
  putLocal: (...args: unknown[]) => putLocal(...args),
  deleteDraft: (...args: unknown[]) => deleteDraft(...args),
  acceptRemoteReport: (...args: unknown[]) => acceptRemoteReport(...args),
}));
vi.mock("./session", () => ({
  hasCalendarGrant: () => false,
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "Fehler",
}));

const { startProcessing, jobFor, activeJobs, clearJob, subscribeJobs, pollServerProcessing } =
  await import("./pipeline");

const report = {
  id: "report-1",
  date: "2026-09-10T10:00:00.000Z",
  title: "Weekly Sync",
  summary: "",
  transcription: "Gesprächstext",
  todos: [],
  takeaways: [],
};
const draft = { report, audio: new Blob(["a"]) } as any;
const run = (analyze = true) =>
  startProcessing({ owner: "user-1", draft, token: "drive-token", analyze });

describe("processing pipeline", () => {
  beforeEach(() => {
    account.currentUser = { uid: "user-1" };
    remote.available.mockReset().mockResolvedValue(false);
    remote.submit.mockReset().mockResolvedValue({ job: { reportId: "report-1", state: "queued", attempts: 0, message: "Wartet auf Server", updatedAt: "2026-11-13T10:00:00Z" } });
    remote.list.mockReset().mockResolvedValue({ jobs: [] });
    remote.get.mockReset();
    finalTranscript.mockReset().mockResolvedValue(undefined);
    for (const spy of [
      backupDraft,
      syncReport,
      analyzeDraft,
      saveReport,
      putLocal,
      deleteDraft,
      acceptRemoteReport,
    ])
      spy.mockReset();
    saveReport.mockResolvedValue(null);
    backupDraft.mockResolvedValue(report);
    analyzeDraft.mockResolvedValue({ ...report, status: "completed" });
    syncReport.mockResolvedValue({ report, warning: null });
    putLocal.mockResolvedValue(undefined);
    deleteDraft.mockResolvedValue(undefined);
  });
  afterEach(() => clearJob(report.id));

  it("restores a server-completed report after reopening without starting another AI call", async () => {
    remote.available.mockResolvedValue(true);
    const job = { reportId: report.id, state: "done", attempts: 1, message: "Fertig", updatedAt: "2026-11-13T12:00:00Z" };
    const finished = { ...report, status: "completed", summary: "Vom Server erstellt" };
    remote.list.mockResolvedValue({ jobs: [job] });
    remote.get.mockResolvedValue({ job, report: finished });
    await pollServerProcessing("user-1");
    expect(acceptRemoteReport).toHaveBeenCalledWith("user-1", finished);
    expect(jobFor(report.id)).toMatchObject({ stage: "done", serverOwned: true });
    expect(remote.submit).not.toHaveBeenCalled();
    expect(analyzeDraft).not.toHaveBeenCalled();
    await pollServerProcessing("user-1");
    expect(remote.get).toHaveBeenCalledOnce();
  });

  it("hydrates an already-finished idempotent handoff instead of leaving a local analyzing stub", async () => {
    const job = { reportId: report.id, state: "done", attempts: 4, message: "Fertig", updatedAt: "2026-11-13T13:00:00Z" };
    const finished = { ...report, status: "completed", summary: "Bereits erstellt" };
    remote.available.mockResolvedValueOnce(true);
    remote.submit.mockResolvedValueOnce({ job });
    remote.get.mockResolvedValueOnce({ job, report: finished });
    await run();
    expect(remote.get).toHaveBeenCalledWith(report.id);
    expect(acceptRemoteReport).toHaveBeenCalledWith("user-1", finished);
    expect(analyzeDraft).not.toHaveBeenCalled();
  });

  it("hands a durably uploaded meeting to the server without local AI work", async () => {
    remote.available.mockResolvedValueOnce(true);
    await run();
    expect(backupDraft).toHaveBeenCalledBefore(syncReport);
    expect(syncReport).toHaveBeenCalledBefore(remote.submit);
    expect(finalTranscript).toHaveBeenCalledWith(draft, "drive-token", { batch: false });
    expect(analyzeDraft).not.toHaveBeenCalled();
    expect(remote.submit).toHaveBeenCalledWith(expect.objectContaining({ id: report.id }), expect.objectContaining({ analyze: true }));
    expect(jobFor(report.id)).toMatchObject({ serverOwned: true, stage: "analyzing" });
    expect(deleteDraft).toHaveBeenCalledWith("user-1", report.id);
  });

  it("does not silently switch to browser AI after an uncertain server handoff", async () => {
    remote.available.mockResolvedValueOnce(true);
    remote.submit.mockRejectedValueOnce(new Error("Verbindung unterbrochen"));
    await run();
    expect(analyzeDraft).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(jobFor(report.id)?.stage).toBe("error");
  });

  it("runs save, backup, analysis and export in order and finishes", async () => {
    const stages: string[] = [];
    const stop = subscribeJobs(() => {
      const stage = jobFor(report.id)?.stage;
      if (stage && stages.at(-1) !== stage) stages.push(stage);
    });
    await run();
    stop();

    expect(stages).toEqual(["saving", "uploading", "analyzing", "exporting", "done"]);
    expect(saveReport).toHaveBeenCalledBefore(backupDraft);
    expect(backupDraft).toHaveBeenCalledBefore(analyzeDraft);
    expect(analyzeDraft).toHaveBeenCalledBefore(syncReport);
    expect(deleteDraft).toHaveBeenCalledWith("user-1", report.id);
  });

  it("skips analysis when only a Drive backup was requested", async () => {
    await run(false);
    expect(analyzeDraft).not.toHaveBeenCalled();
    expect(syncReport).toHaveBeenCalledOnce();
    expect(jobFor(report.id)?.stage).toBe("done");
  });

  it("keeps a failed analysis retryable and still exports the error state", async () => {
    analyzeDraft.mockRejectedValueOnce(new Error("KI nicht erreichbar"));
    await run();

    const stored = putLocal.mock.calls.at(-1)?.[1];
    expect(stored).toMatchObject({
      status: "error",
      error: "KI nicht erreichbar",
    });
    expect(syncReport).toHaveBeenCalled();
    expect(jobFor(report.id)).toMatchObject({
      stage: "error",
      error: "KI nicht erreichbar",
    });
    // A failed run must not delete the draft that still holds the audio.
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it("surfaces a cloud-index warning without failing the job", async () => {
    saveReport.mockResolvedValueOnce("Firebase antwortet nicht.");
    await run(false);
    expect(jobFor(report.id)).toMatchObject({
      stage: "done",
      warning: "Firebase antwortet nicht.",
    });
  });

  it("reports upload progress messages from the backup step", async () => {
    backupDraft.mockImplementationOnce(async (_d: unknown, _t: unknown, progress: (m: string) => void) => {
      progress("Audio in Google Drive sichern …");
      return report;
    });
    const seen: string[] = [];
    const stop = subscribeJobs(() => {
      const message = jobFor(report.id)?.message;
      if (message && seen.at(-1) !== message) seen.push(message);
    });
    await run(false);
    stop();
    expect(seen).toContain("Audio in Google Drive sichern …");
  });

  it("exposes a stable active-job snapshot that empties when finished", async () => {
    const snapshots: unknown[] = [];
    const stop = subscribeJobs(() => snapshots.push(activeJobs()));
    const pending = run(false);
    expect(activeJobs()).toHaveLength(1);
    await pending;
    stop();

    expect(activeJobs()).toHaveLength(0);
    // Identity must change per update, otherwise subscribers never re-render.
    expect(new Set(snapshots).size).toBe(snapshots.length);
  });
  it("never summarizes or exports a provisional transcript after finalization fails", async () => {
    finalTranscript.mockRejectedValueOnce(new Error("Finaler Auftrag unbestätigt"));
    await run();
    expect(analyzeDraft).not.toHaveBeenCalled();
    expect(syncReport).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(jobFor(report.id)?.stage).toBe("error");
  });
  it("does not start cloud work under a changed account", async () => {
    saveReport.mockImplementationOnce(async () => { account.currentUser = { uid: "user-2" }; return null; });
    await run();
    expect(backupDraft).not.toHaveBeenCalled();
    expect(finalTranscript).not.toHaveBeenCalled();
    expect(syncReport).not.toHaveBeenCalled();
  });

it("exports final text for review and pauses before summary generation without deleting the draft", async () => {
  account.currentUser = { uid: "user-1" };
  analyzeDraft.mockClear(); deleteDraft.mockClear();
  finalTranscript.mockResolvedValue(undefined);
  const reviewDraft = { ...draft, report: { ...report, speech: {
    provider: "assemblyai", phase: "final", speakerReview: "pending", languages: ["de"], speakerNames: {},
    turns: [{ id: "batch:0", speaker: "batch:A", startMs: 0, endMs: 1000, text: "Frage", final: true }],
  } } };
  syncReport.mockResolvedValue({ report: reviewDraft.report });
  await startProcessing({ owner: "user-1", draft: reviewDraft as any, token: "drive-token", analyze: true });
  expect(analyzeDraft).not.toHaveBeenCalled(); expect(deleteDraft).not.toHaveBeenCalled();
  expect(jobFor(report.id)?.stage).toBe("review"); expect(activeJobs()).toEqual([]);
  clearJob(report.id);
});

});
