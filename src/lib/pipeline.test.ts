import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ReportConflictError = vi.hoisted(() => class extends Error {
  constructor() { super("Neuere Fassung laden"); this.name = "ReportConflictError"; }
});
const account = vi.hoisted(() => ({ currentUser: { uid: "user-1" } }));
const remote = vi.hoisted(() => ({ available: vi.fn(), submit: vi.fn(), list: vi.fn(), get: vi.fn() }));
const microsoftToken = vi.hoisted(() => vi.fn(async () => ({accessToken:"microsoft",connectionId:"c"})));
const calendar = vi.hoisted(() => ({grant:vi.fn(),sync:vi.fn()}));
vi.mock('./calendar',()=>({hasAnyCalendarGrant:calendar.grant}));
vi.mock('./calendarSync',()=>({syncReportToCalendar:calendar.sync}));
vi.mock('./meetingDefaults',()=>({calendarSyncEnabled:()=>true}));
vi.mock("./microsoft",()=>({ensureMicrosoftToken:microsoftToken}));
vi.mock("./serverProcessing", () => ({ processingAvailable: remote.available, submitServerProcessing: remote.submit, listServerProcessing: remote.list, getServerProcessing: remote.get, discoverServerProcessing: (job:any)=>remote.get(job.reportId) }));
vi.mock("./firebase", () => ({ auth: account }));
const captureState = vi.hoisted(() => ({ active: false, busy: "" }));
vi.mock("./capture", () => ({ isCapturing: () => captureState.active, captureSnapshot: () => ({ busy: captureState.busy }) }));
const finalTranscript = vi.hoisted(() => vi.fn());
vi.mock("./prepareTranscript", () => ({ prepareTranscript: finalTranscript }));
const backupDraft = vi.fn();
const syncReport = vi.fn();
const analyzeDraft = vi.fn();
const saveReport = vi.fn();
const putLocal = vi.fn();
const deleteDraft = vi.fn();
const acceptRemoteReport = vi.fn();
const putDraft = vi.fn();
const getDraft = vi.fn();
const listDrafts = vi.fn();
const getLocal = vi.fn();
const ensureDriveToken = vi.fn();

vi.mock("./workflow", () => ({
  backupDraft: (...args: unknown[]) => backupDraft(...args),
  syncReport: (...args: unknown[]) => syncReport(...args),
  analyzeDraft: (...args: unknown[]) => analyzeDraft(...args),
}));
vi.mock("./reports", () => ({
  saveReport: (...args: unknown[]) => saveReport(...args),
}));
vi.mock("./local", () => ({
  ReportConflictError,
  putDraft: (...args: unknown[]) => putDraft(...args),
  getDraft: (...args: unknown[]) => getDraft(...args),
  listDrafts: (...args: unknown[]) => listDrafts(...args),
  getLocal: (...args: unknown[]) => getLocal(...args),
  putLocal: (...args: unknown[]) => putLocal(...args),
  deleteDraft: (...args: unknown[]) => deleteDraft(...args),
  acceptRemoteReport: (...args: unknown[]) => acceptRemoteReport(...args),
}));
vi.mock("./session", () => ({
  hasCalendarGrant: () => false,
  ensureDriveToken: (...args: unknown[]) => ensureDriveToken(...args),
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "Fehler",
}));

const { startProcessing, jobFor, activeJobs, clearJob, subscribeJobs, pollServerProcessing, observeServerProcessing, handoffServerProcessing } =
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
    calendar.grant.mockReset().mockReturnValue(false);
    calendar.sync.mockReset().mockResolvedValue({calendarSyncedAt:'new-success'});
    vi.stubGlobal("navigator", { locks: { request: async (_key: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } });
    captureState.active = false;
    captureState.busy = "";
    putDraft.mockReset().mockResolvedValue(undefined);
    let pendingDraft:any;
    putDraft.mockImplementation(async (_owner,next)=>{pendingDraft=next;});
    getDraft.mockReset().mockImplementation(async()=>pendingDraft);
    listDrafts.mockReset().mockResolvedValue([]);
    getLocal.mockReset().mockResolvedValue(undefined);
    ensureDriveToken.mockReset().mockResolvedValue("drive-token");
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
    let stored: any;
    getLocal.mockReset().mockImplementation(async () => stored && structuredClone(stored));
    putLocal.mockImplementation(async (_owner, next, dirty = true, expected) => {
      if (expected !== undefined && expected !== (stored?.report.updatedAt ?? null)) throw new ReportConflictError();
      stored = { report: structuredClone(next), dirty };
    });
    saveReport.mockImplementation(async (next, options) => {
      await putLocal("user-1", { ...next, updatedAt: new Date(Math.max(Date.now(), (Date.parse(next.updatedAt || "") || 0) + 1)).toISOString() }, true, options?.expectedUpdatedAt);
      return null;
    });
    backupDraft.mockResolvedValue(report);
    analyzeDraft.mockImplementation(async d => ({ ...d.report, status: "completed" }));
    syncReport.mockImplementation(async next => ({ report: next, warning: null }));
    deleteDraft.mockResolvedValue(undefined);
  });
  afterEach(() => { account.currentUser = {uid:'user-1'}; clearJob(report.id); });

  it.each(['source-ready','fresh','browser'].flatMap(gate=>[true,false].map(connected=>({gate,connected}))))('uses linked A, never default B, at the $gate calendar gate (A=$connected)',async ({gate,connected})=>{
    remote.available.mockResolvedValue(gate!=='browser');
    calendar.grant.mockImplementation((_provider,connection)=>connection==='A'?connected:!connected);
    const linked={...report,calendarEventId:'event',calendarProvider:'microsoft' as const,calendarConnectionId:'A'};
    await startProcessing({owner:'user-1',draft:{...draft,report:linked,processing:{analyze:true,sourceReady:gate==='source-ready'}},token:'t',analyze:true});
    expect(calendar.grant).toHaveBeenCalledWith('microsoft','A');
    if(gate==='browser') {
      if(connected)expect(calendar.sync).toHaveBeenCalledWith(expect.objectContaining({calendarConnectionId:'A'}),{create:false});
      else expect(calendar.sync).not.toHaveBeenCalled();
    } else expect(remote.submit).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({calendarSync:connected}));
  });
  it('does not reuse or clean a distinct same-ID namespace from list metadata',async()=>{
    remote.available.mockResolvedValue(true);
    remote.list.mockResolvedValue({jobs:[{reportId:report.id,state:'done',storage:'google',updatedAt:'sibling'}]});
    const ms={...report,home:{provider:'microsoft' as const,connectionId:'c',driveId:'d',rootId:'r',rootName:'Meetings',folderId:'f',reportId:'j'}};
    await startProcessing({owner:'user-1',draft:{...draft,report:ms},analyze:true});
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(remote.submit).not.toHaveBeenCalled();
    expect(jobFor(report.id,ms)).toMatchObject({stage:'error'});
    expect(jobFor(report.id,report)).toBeUndefined();
    clearJob(report.id,report);
    expect(jobFor(report.id,ms)).toBeDefined();
    clearJob(report.id,ms);
  });
  it('hydrates Google discovery without consuming a Microsoft sibling draft',async()=>{
    remote.available.mockResolvedValue(true);
    const done={reportId:report.id,state:'done',storage:'google',updatedAt:'source-bound-cleanup'};
    remote.list.mockResolvedValue({jobs:[done]});remote.get.mockResolvedValue({job:done,report});
    getDraft.mockResolvedValue({...draft,report:{...report,home:{provider:'microsoft',connectionId:'c',driveId:'d',rootId:'r',rootName:'Meetings'}}});
    await pollServerProcessing('user-1');
    expect(acceptRemoteReport).toHaveBeenCalledWith('user-1',report);
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(getLocal).toHaveBeenCalledWith('user-1',report.id,{index:'reports'});
  });
  it.each([false,true])('cleans terminal drafts only for the exact same pinned source (same=%s)',async same=>{
    remote.available.mockResolvedValue(true);
    const pinned={...report,driveFolderId:'folder',driveReportId:'json'};
    const done={reportId:report.id,state:'done',storage:'google',updatedAt:`cleanup-${same}`};
    remote.list.mockResolvedValue({jobs:[done]});remote.get.mockResolvedValue({job:done,report:pinned});
    getDraft.mockResolvedValue({...draft,report:{...pinned,driveFolderId:same?'folder':'sibling',rawAudioUrl:'consumed-audio'}});
    await pollServerProcessing('user-1');
    if(same)expect(deleteDraft).toHaveBeenCalledWith('user-1',report.id,{index:'reports'});
    else expect(deleteDraft).not.toHaveBeenCalled();
  });

  it('refuses a different pinned local source even at an equal revision before journaling',async()=>{
    const pinned={...report,driveFolderId:'folder',driveReportId:'json',updatedAt:'2026-11-01T00:00:00Z'};
    getLocal.mockResolvedValue({report:{...pinned,driveFolderId:'sibling'},dirty:false});
    await startProcessing({owner:'user-1',draft:{...draft,report:pinned},token:'t',analyze:true});
    expect(putDraft).not.toHaveBeenCalled();expect(putLocal).not.toHaveBeenCalled();
    expect(remote.submit).not.toHaveBeenCalled();
  });
  it.each([false, true])("retains human work after late browser analysis (failure=%s)", async (fail) => {
    let stored: any;
    getLocal.mockImplementation(async () => stored && structuredClone(stored));
    putLocal.mockImplementation(async (_owner, next, dirty = true, expected) => {
      if (expected !== undefined && expected !== (stored?.report.updatedAt ?? null)) throw new ReportConflictError();
      stored = { report: structuredClone(next), dirty };
    });
    saveReport.mockImplementation(async (next, options) => {
      await putLocal("user-1", { ...next, updatedAt: "2026-11-01T00:00:00.000Z" }, true, options?.expectedUpdatedAt);
      return null;
    });
    let release!: (value?: unknown) => void;
    analyzeDraft.mockImplementationOnce(() => {
      const snapshot = structuredClone(stored.report);
      return new Promise((resolve, reject) => { release = fail ? () => reject(new Error("KI ausgefallen")) : () => resolve({ ...snapshot, summary: "Spätes Modell", status: "completed" }); });
    });
    const raceId = `browser-race-${fail}`;
    const pending = startProcessing({ owner: "user-1", draft: { ...draft, report: { ...report, id: raceId } }, token: "drive-token", analyze: true });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const newer = { ...stored.report, title: "Mensch gewinnt", transcription: "Manuell korrigiert", updatedAt: "2099-01-01T00:00:00.000Z" };
    stored = { report: newer, dirty: true };
    release();
    await pending;
    expect(stored).toEqual({ report: newer, dirty: true });
    expect(syncReport).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(jobFor(raceId)).toMatchObject({ stage: "error", error: expect.stringMatching(/Fassung|geändert/) });
    clearJob(raceId);
  });

  it.each(["submission", "terminal hydration"])("keeps later human edits dirty after server %s", async (phase) => {
    const submitted = { ...report, updatedAt: "2026-11-01T00:00:00.000Z" };
    let stored = { report: submitted, dirty: true };
    getLocal.mockImplementation(async () => structuredClone(stored));
    putLocal.mockImplementation(async (_owner, next, dirty = true, expected) => {
      if (expected !== undefined && expected !== stored.report.updatedAt) throw new ReportConflictError();
      stored = { report: structuredClone(next), dirty };
    });
    let release!: (value: unknown) => void;
    if (phase === "submission") {
      remote.submit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    } else {
      remote.submit.mockResolvedValueOnce({ job: { reportId: report.id, state: "done" } });
      remote.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    }
    const pending = handoffServerProcessing("user-1", submitted, { analyze: true });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const newer = { ...submitted, title: "Menschliche Korrektur", transcription: "Korrigiertes Transkript", updatedAt: "2026-11-02T00:00:00.000Z" };
    stored = { report: newer, dirty: true };
    release({ job: { reportId: report.id, state: "queued", message: "Akzeptiert" } });
    await expect(pending).rejects.toMatchObject({ name: "ReportConflictError" });
    expect(stored).toEqual({ report: newer, dirty: true });
    expect(acceptRemoteReport).not.toHaveBeenCalled();
  });

  it.each(['newer', 'dirty', 'removed', 'audio', 'unsynced'])("does not submit paid replacement after the confirmed local report becomes %s", async (change) => {
    const confirmed = { ...report, updatedAt: 'confirmed', summary: 'Keep this summary', driveFolderId: 'folder', driveReportId: 'json', rawAudioUrl: 'audio', driveSyncedAt: 'synced' };
    getLocal.mockResolvedValue(change === 'removed' ? undefined : {
      report: { ...confirmed,
        ...(change === 'newer' ? { updatedAt: 'later-human-edit', summary: 'New local summary' } : {}),
        ...(change === 'audio' ? { rawAudioUrl: 'replacement-audio' } : {}),
        ...(change === 'unsynced' ? { driveSyncedAt: undefined } : {}),
      }, dirty: change === 'dirty',
    });
    await expect(handoffServerProcessing('user-1', confirmed, { analyze: true, retranscribe: true, regenerate: true })).rejects.toMatchObject({ name: 'ReportConflictError' });
    expect(remote.submit).not.toHaveBeenCalled();
    expect(putLocal).not.toHaveBeenCalled();
  });

  it("observes the durable final-save revision rather than a stale workflow return revision", async () => {
    const input = { ...report, updatedAt: "2026-11-01T00:00:00.000Z" };
    getLocal.mockResolvedValue({ report: { ...input, updatedAt: "2026-11-01T00:00:00.001Z" }, dirty: true });
    putLocal.mockResolvedValue(undefined);
    await handoffServerProcessing("user-1", input, { analyze: true });
    expect(putLocal).toHaveBeenCalledWith("user-1", expect.objectContaining({ updatedAt: "2026-11-01T00:00:00.001Z" }), true, "2026-11-01T00:00:00.001Z");
  });

  it("carries meeting identity and backup-only intent into job progress without an extra listener", async () => {
    remote.available.mockResolvedValue(true);
    await handoffServerProcessing("user-1", report, { analyze: false });
    expect(jobFor(report.id)).toMatchObject({ title: "Weekly Sync", date: report.date, analyze: false });
  });

  it("discards terminal hydration already in flight when the meeting's recovery job is cleared", async () => {
    remote.available.mockResolvedValue(true);
    const done = { reportId: report.id, state: "done", message: "Fertig", updatedAt: "deleted-in-flight" };
    remote.list.mockResolvedValue({ jobs: [done] });
    let release!: (value: unknown) => void;
    remote.get.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const polling = pollServerProcessing("user-1");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    clearJob(report.id);
    release({ job: done, report });
    await polling;
    expect(acceptRemoteReport).not.toHaveBeenCalled();
    expect(jobFor(report.id)).toBeUndefined();
  });

  it("invalidates a delayed terminal response when exact-source deletion clears an unbound discovery", async () => {
    remote.available.mockResolvedValue(true);
    const pinned = { ...report, driveFolderId: "folder", driveReportId: "json" };
    const queued = { reportId: report.id, state: "queued", message: "Server", updatedAt: "unbound-discovery" };
    remote.list.mockResolvedValue({ jobs: [queued] });
    await pollServerProcessing("user-1");
    expect(jobFor(report.id)).toMatchObject({ serverOwned: true });
    expect(jobFor(report.id, pinned)).toBeUndefined();
    getLocal.mockResolvedValue({ report: pinned, dirty: false });
    const done = { ...queued, state: "done", updatedAt: "unbound-terminal" };
    remote.list.mockResolvedValue({ jobs: [done] });
    let release!: (value: unknown) => void;
    remote.get.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const polling = pollServerProcessing("user-1");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // The exact-source server forget has succeeded; deleteReport uses this
    // clear before removing the index/local entry. Delivery is still pending.
    clearJob(report.id, pinned);
    getLocal.mockResolvedValue(undefined);
    release({ job: done, report: pinned });
    await polling;
    expect(acceptRemoteReport).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(jobFor(report.id, pinned)).toBeUndefined();
  });

  it("retains a bound sibling source while permitting exact-source job removal", async () => {
    const pinned = { ...report, driveFolderId: "folder", driveReportId: "json" };
    await handoffServerProcessing("user-1", pinned, { analyze: true });
    clearJob(report.id, { ...pinned, driveFolderId: "sibling" });
    expect(jobFor(report.id, pinned)).toBeDefined();
    clearJob(report.id, pinned);
    expect(jobFor(report.id, pinned)).toBeUndefined();
  });

  it("continues past a forgotten job from an instance's briefly stale list", async () => {
    remote.available.mockResolvedValue(true);
    remote.list.mockResolvedValue({ jobs: [{ reportId: report.id, state: "done", updatedAt: "forgotten" }] });
    remote.get.mockRejectedValue(Object.assign(new Error("Auftrag nicht gefunden"), { status: 404 }));
    await expect(pollServerProcessing("user-1")).resolves.toBe(false);
    expect(acceptRemoteReport).not.toHaveBeenCalled();
  });

  it("observes idle every five minutes and wakes on accepted work without publish recursion", async () => {
    vi.useFakeTimers();
    const doc=Object.assign(new EventTarget(),{hidden:false,hasFocus:()=>true});
    vi.stubGlobal('document',doc);vi.stubGlobal('window',new EventTarget());
    remote.available.mockResolvedValue(true);
    const stop=observeServerProcessing('user-1');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(remote.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(299999);
      expect(remote.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(remote.list).toHaveBeenCalledTimes(2);
      // Another router instance may still serve an idle snapshot after acceptance.
      await handoffServerProcessing('user-1',report,{analyze:true});
      await vi.advanceTimersByTimeAsync(0);
      expect(remote.list).toHaveBeenCalledTimes(3);
      const queued={reportId:report.id,state:'queued',message:'Server',updatedAt:'observer-active'};
      remote.list.mockResolvedValue({jobs:[queued]});remote.get.mockResolvedValue({job:queued});
      await vi.advanceTimersByTimeAsync(4999);
      expect(remote.list).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(remote.list).toHaveBeenCalledTimes(4);
      const done={reportId:report.id,state:'done',message:'Fertig',updatedAt:'observer-done'};
      remote.list.mockResolvedValue({jobs:[done]});remote.get.mockResolvedValue({job:done});
      await vi.advanceTimersByTimeAsync(5000);
      expect(remote.list).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(299999);
      expect(remote.list).toHaveBeenCalledTimes(5);
    } finally {stop();vi.useRealTimers();vi.unstubAllGlobals();}
  });

  it("pauses background observation, resumes explicit drafts after authority, and backs off failures", async () => {
    vi.useFakeTimers();
    const doc=Object.assign(new EventTarget(),{hidden:true,hasFocus:()=>true});
    const win=new EventTarget();vi.stubGlobal('document',doc);vi.stubGlobal('window',win);
    remote.available.mockResolvedValue(true);
    const stop=observeServerProcessing('user-1');
    try {
      await vi.advanceTimersByTimeAsync(300000);
      expect(remote.list).not.toHaveBeenCalled();
      doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(remote.list).toHaveBeenCalledTimes(1);
      win.dispatchEvent(new Event('blur'));
      await vi.advanceTimersByTimeAsync(300000);
      expect(remote.list).toHaveBeenCalledTimes(1);
      const pending={...draft,processing:{analyze:false}};
      listDrafts.mockResolvedValue([pending]);getDraft.mockResolvedValue(pending);
      remote.list.mockRejectedValueOnce(Error('quota'));
      win.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(0);
      expect(remote.list).toHaveBeenCalledTimes(2);expect(backupDraft).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(29999);
      expect(remote.list).toHaveBeenCalledTimes(2);
      remote.list.mockRejectedValueOnce(Error('quota'));
      await vi.advanceTimersByTimeAsync(1);expect(remote.list).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(59999);expect(remote.list).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(backupDraft).toHaveBeenCalledOnce();expect(remote.list).toHaveBeenCalledBefore(backupDraft);
      stop();await vi.advanceTimersByTimeAsync(300000);
      const count=remote.list.mock.calls.length;
      win.dispatchEvent(new Event('focus'));doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);expect(remote.list).toHaveBeenCalledTimes(count);
    } finally {stop();vi.useRealTimers();vi.unstubAllGlobals();}
  });

  it("pins the Microsoft source and never asks Google for its credential", async () => {
    remote.available.mockResolvedValue(true);
    const ms = {...report, home:{provider:"microsoft" as const,connectionId:"c",driveId:"d",rootId:"root",rootName:"Meetings",folderId:"f",audioId:"a",reportId:"j"}};
    remote.submit.mockResolvedValue({job:{reportId:report.id,state:'queued',storage:'microsoft'}});
    syncReport.mockResolvedValue({report:ms,warning:null});
    await startProcessing({owner:"user-1",draft:{...draft,report:ms},analyze:false});
    expect(ensureDriveToken).not.toHaveBeenCalled();expect(microsoftToken).toHaveBeenCalledWith("c");
    expect(remote.submit).toHaveBeenCalledWith(expect.objectContaining({home:ms.home}),expect.objectContaining({analyze:false}));
    clearJob(report.id,ms);
  });

  it("persists explicit intent before any network work", async () => {
    saveReport.mockImplementationOnce(async (next, options) => {
      expect(putDraft).toHaveBeenCalledWith("user-1", expect.objectContaining({ processing: { analyze: false } }));
      await putLocal("user-1", { ...next, updatedAt: "2026-11-01T00:00:00.000Z" }, true, options?.expectedUpdatedAt);
      return null;
    });
    await run(false);
    expect(putDraft).toHaveBeenCalledBefore(saveReport);
  });

  it("resumes only an explicit backup-only choice after observing server jobs", async () => {
    remote.available.mockResolvedValue(true);
    const pending = { ...draft, processing: { analyze: false } };
    listDrafts.mockResolvedValue([pending, { report: { ...report, id: "undecided" } }]);
    getDraft.mockResolvedValue(pending);
    await pollServerProcessing("user-1");
    expect(remote.list).toHaveBeenCalledBefore(backupDraft);
    expect(ensureDriveToken).toHaveBeenCalledOnce();
    expect(remote.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ analyze: false, retranscribe: false }));
    expect(backupDraft).toHaveBeenCalledOnce();
    expect(analyzeDraft).not.toHaveBeenCalled();
  });

  it("does not automatically process an undecided draft", async () => {
    remote.available.mockResolvedValue(true);
    listDrafts.mockResolvedValue([draft]);
    await pollServerProcessing("user-1");
    expect(getDraft).not.toHaveBeenCalled();
    expect(ensureDriveToken).not.toHaveBeenCalled();
    expect(backupDraft).not.toHaveBeenCalled();
  });

  it("repairs a late local failure even when the final server revision was already observed", async () => {
    remote.available.mockResolvedValue(true);
    const job = { reportId: "late-shadow", state: "done", attempts: 4, message: "Fertig", updatedAt: "2026-11-13T16:00:00Z" };
    const completed = { ...report, id: job.reportId, status: "completed", summary: "Fertig" };
    remote.list.mockResolvedValue({ jobs: [job] });
    remote.get.mockResolvedValue({ job, report: completed });
    await pollServerProcessing("user-1");
    getLocal.mockResolvedValue({ dirty: true, report: { ...report, id: job.reportId, status: "error" } });
    await pollServerProcessing("user-1");
    expect(remote.get).toHaveBeenCalledTimes(2);
    expect(acceptRemoteReport).toHaveBeenLastCalledWith("user-1", completed);
    clearJob(job.reportId);
  });

  it("does not retry uploads when authoritative job observation fails", async () => {
    remote.available.mockResolvedValue(true);
    remote.list.mockRejectedValue(new Error("offline"));
    await expect(pollServerProcessing("user-1")).rejects.toThrow("offline");
    expect(listDrafts).not.toHaveBeenCalled();
    expect(backupDraft).not.toHaveBeenCalled();
  });

  it("does not upload again for an accepted job, even on an explicit retry", async () => {
    remote.available.mockResolvedValue(true);
    const job={ reportId: report.id, state: "queued", message: "Server", updatedAt: "accepted" };
    remote.list.mockResolvedValue({ jobs: [job] });
    remote.get.mockResolvedValue({job});
    listDrafts.mockResolvedValue([{ ...draft, processing: { analyze: true } }]);
    await pollServerProcessing("user-1");
    await run();
    expect(backupDraft).not.toHaveBeenCalled();
    expect(syncReport).not.toHaveBeenCalled();
    expect(remote.submit).not.toHaveBeenCalled();
    expect(analyzeDraft).not.toHaveBeenCalled();
  });

  it("stops after an account switch during automatic token renewal", async () => {
    remote.available.mockResolvedValue(true);
    const pending = { ...draft, processing: { analyze: false } };
    listDrafts.mockResolvedValue([pending]);
    getDraft.mockResolvedValue(pending);
    ensureDriveToken.mockImplementationOnce(async () => { account.currentUser = { uid: "user-2" }; return "other-token"; });
    await pollServerProcessing("user-1");
    expect(ensureDriveToken).toHaveBeenCalledOnce();
    expect(saveReport).not.toHaveBeenCalled();
    expect(backupDraft).not.toHaveBeenCalled();
    expect(putLocal).not.toHaveBeenCalled();
  });

  it("resumes an uncertain handoff without rewriting the durable source", async () => {
    remote.available.mockResolvedValue(true);
    const pending = { ...draft, report: { ...report, id: "uncertain-resume", driveReportId: "source" }, processing: { analyze: true, sourceReady: true } };
    listDrafts.mockResolvedValue([pending]);
    getDraft.mockResolvedValue(pending);
    await pollServerProcessing("user-1");
    expect(remote.submit).toHaveBeenCalledOnce();
    expect(backupDraft).not.toHaveBeenCalled();
    expect(syncReport).not.toHaveBeenCalled();
    expect(finalTranscript).not.toHaveBeenCalled();
    expect(analyzeDraft).not.toHaveBeenCalled();
    clearJob("uncertain-resume");
  });

  it("backs off failed automatic uploads rather than retrying every poll", async () => {
    remote.available.mockResolvedValue(true);
    const pending = { ...draft, report: { ...report, id: "backoff" }, processing: { analyze: false } };
    listDrafts.mockResolvedValue([pending]);
    getDraft.mockResolvedValue(pending);
    backupDraft.mockRejectedValue(new Error("offline"));
    await pollServerProcessing("user-1");
    await pollServerProcessing("user-1");
    expect(backupDraft).toHaveBeenCalledOnce();
    clearJob("backoff");
  });

  it("does not observe another account after configuration lookup changes the user", async () => {
    remote.available.mockImplementationOnce(async () => { account.currentUser = { uid: "user-2" }; return true; });
    await pollServerProcessing("user-1");
    expect(remote.list).not.toHaveBeenCalled();
  });

  it("does not race the recording screen while it finishes and saves a draft", async () => {
    remote.available.mockResolvedValue(true);
    captureState.busy = "Transkription abschließen …";
    listDrafts.mockResolvedValue([{ ...draft, processing: { analyze: true } }]);
    getDraft.mockResolvedValue({ ...draft, processing: { analyze: true } });
    await pollServerProcessing("user-1");
    expect(backupDraft).not.toHaveBeenCalled();
  });

  it("skips an upload held by another tab", async () => {
    vi.stubGlobal("navigator", { locks: { request: async (_key: string, _options: unknown, callback: (lock: null) => unknown) => callback(null) } });
    await run();
    expect(backupDraft).not.toHaveBeenCalled();
    expect(remote.submit).not.toHaveBeenCalled();
  });

  it("checkpoints source references before an uncertain handoff", async () => {
    remote.available.mockResolvedValue(true);
    const source = { ...report, driveReportId: "source-json", driveFolderId: "folder" };
    syncReport.mockResolvedValue({ report: source });
    remote.submit.mockImplementationOnce(async () => {
      expect(putDraft).toHaveBeenLastCalledWith("user-1", expect.objectContaining({ report: source, processing: { analyze: true, sourceReady: true } }));
      throw new Error("uncertain");
    });
    await run();
    expect(putDraft.mock.calls.at(-1)?.[1].processing.sourceReady).toBe(true);
    expect(analyzeDraft).not.toHaveBeenCalled();
  });

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
    expect(remote.get).toHaveBeenCalledWith(report.id, expect.objectContaining({id:report.id}));
    expect(acceptRemoteReport).toHaveBeenCalledWith("user-1", finished);
    expect(analyzeDraft).not.toHaveBeenCalled();
  });

  it("hands a durably uploaded meeting to the server without local AI work", async () => {
    remote.available.mockResolvedValueOnce(true);
    await run();
    expect(backupDraft).toHaveBeenCalledBefore(syncReport);
    expect(syncReport).toHaveBeenCalledBefore(remote.submit);
    expect(finalTranscript).toHaveBeenCalledWith(expect.objectContaining({ report: expect.objectContaining({ id: report.id }) }), "drive-token", { batch: false, expectedUpdatedAt: expect.any(String) });
    expect(analyzeDraft).not.toHaveBeenCalled();
    expect(remote.submit).toHaveBeenCalledWith(expect.objectContaining({ id: report.id }), expect.objectContaining({ analyze: true }));
    expect(jobFor(report.id)).toMatchObject({ serverOwned: true, stage: "analyzing" });
    expect(deleteDraft).toHaveBeenCalledWith("user-1", report.id, { index: "reports" });
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
    expect(deleteDraft).toHaveBeenCalledWith("user-1", report.id, { index: "reports" });
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
    saveReport.mockImplementationOnce(async (next, options) => {
      await putLocal("user-1", { ...next, updatedAt: "2026-11-01T00:00:00.000Z" }, true, options?.expectedUpdatedAt);
      return "Firebase antwortet nicht.";
    });
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

it("finishes analysis with unresolved speakers instead of creating a mandatory review stop", async () => {
  account.currentUser = { uid: "user-1" };
  analyzeDraft.mockClear(); deleteDraft.mockClear();
  finalTranscript.mockResolvedValue(undefined);
  const reviewDraft = { ...draft, report: { ...report, speech: {
    provider: "assemblyai", phase: "final", speakerReview: "pending", languages: ["de"], speakerNames: {},
    turns: [{ id: "batch:0", speaker: "batch:A", startMs: 0, endMs: 1000, text: "Frage", final: true }],
  } } };
  await startProcessing({ owner: "user-1", draft: reviewDraft as any, token: "drive-token", analyze: true });
  expect(analyzeDraft).toHaveBeenCalledOnce();
  expect(analyzeDraft.mock.calls[0][0].report.speech.speakerReview).toBe("pending");
  expect(deleteDraft).toHaveBeenCalledOnce();
  expect(jobFor(report.id)?.stage).toBe("done"); expect(activeJobs()).toEqual([]);
  clearJob(report.id);
});

});
