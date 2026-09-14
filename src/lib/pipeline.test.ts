import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ currentUser: { uid: "user-1" } }));
vi.mock("./firebase", () => ({ auth: account }));
const finalTranscript = vi.hoisted(() => vi.fn());
vi.mock("./prepareTranscript", () => ({ prepareTranscript: finalTranscript }));
const backupDraft = vi.fn();
const syncReport = vi.fn();
const analyzeDraft = vi.fn();
const saveReport = vi.fn();
const putLocal = vi.fn();
const deleteDraft = vi.fn();

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
}));
vi.mock("./session", () => ({
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "Fehler",
}));

const { startProcessing, jobFor, activeJobs, clearJob, subscribeJobs } =
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
    finalTranscript.mockReset().mockResolvedValue(undefined);
    for (const spy of [
      backupDraft,
      syncReport,
      analyzeDraft,
      saveReport,
      putLocal,
      deleteDraft,
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
