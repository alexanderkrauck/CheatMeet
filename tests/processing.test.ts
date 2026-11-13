import { Readable } from 'node:stream';
import { createBatchTranscriptionService } from '../server/transcription';
import { submissionKey, type Submission, type SubmissionStore } from '../server/transcriptionStore';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createProcessingRouter, type ProcessingJob, type ProcessingOptions } from '../server/processing';
import { memoryDocStore } from '../server/mcp/docStore';
import type { ReportData } from '../src/types';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))); });
const report: ReportData = { id:'meeting-1', date:'2026-09-30T10:00:00Z',title:'Mein Meeting',summary:'',transcription:'Das ist der gespeicherte Text.',todos:[],takeaways:[],driveFolderId:'folder',driveReportId:'json' };
async function setup(extra: Partial<ProcessingOptions> = {}) {
  const store = memoryDocStore<ProcessingJob>();
  const queue = vi.fn(async (_task: import('../server/processing').Task, _delay?: number) => {});
  const artifacts = new Map<string, ReportData>();
  const io = {
    load: vi.fn(async () => ({report:structuredClone(report),revision:'source-v1',indexRevision:'index-v1'})),
    readCheckpoint: vi.fn(async (_j: ProcessingJob, name: string) => artifacts.get(name) || null),
    checkpoint: vi.fn(async (_j: ProcessingJob, name: string, value: ReportData) => { artifacts.set(name,structuredClone(value)); }),
    export: vi.fn(async (_j: ProcessingJob, value: ReportData) => value),
    publish: vi.fn(async () => {}),
  };
  const analyze = vi.fn(async (text: string) => ({title:'KI Titel',summary:'Zusammenfassung',transcription:text,todos:[],takeaways:[]}));
  const app = express();
  app.use('/api', createProcessingRouter({enabled:()=>true,store,enqueue:queue,identify:async t=>({uid:t,googleSub:`sub-${t}`}),verifyWorker:async t=>{if(t!=='worker')throw Error('no');},io,analyze,preferences:async()=>'',...extra}));
  const server = createServer(app); servers.push(server);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const call = async (path: string, body?: unknown, token='alice', microsoft=false) => {
    const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(microsoft?{'X-CheatMeet-Storage':'microsoft'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:res.status,body:await res.json()};
  };
  return {store,queue,io,analyze,call,artifacts};
}
it('accepts Microsoft-only homes and hides their jobs from legacy Google-only clients',async()=>{
  const h=await setup({identify:async token=>({uid:token,googleSub:''})});
  const home={provider:'microsoft' as const,connectionId:'ms-account',driveId:'b!drive',rootId:'root',rootName:'Meetings',folderId:'ms-folder',reportId:'ms-json'};
  const ms={...report,driveFolderId:undefined,driveReportId:undefined,home};
  h.io.load.mockResolvedValue({report:ms,revision:'source-v1',indexRevision:'index-v1'});
  expect((await h.call('/processing/meeting-1',{report:ms,analyze:false},'alice',true)).status).toBe(202);
  expect(h.io.load).toHaveBeenCalledWith(expect.objectContaining({owner:'alice',refs:expect.objectContaining({home})}));
  expect((await h.call('/processing')).body.jobs).toEqual([]);
  expect((await h.call('/processing',undefined,'alice',true)).body.jobs).toHaveLength(1);
  expect((await h.call('/processing/meeting-1')).status).toBe(404);
  expect((await h.call('/processing/meeting-1',undefined,'alice',true)).status).toBe(200);
  expect((await h.call('/processing/meeting-1',undefined,'bob',true)).status).toBe(404);
});
it('coalesces owner lists while authenticating and filtering every request, with bounded idle caching',async()=>{
  const start=Date.now();let time=start;
  const store=memoryDocStore<ProcessingJob>();
  const query=vi.spyOn(store,'listByOwner');
  const identify=vi.fn(async(token:string)=>{if(token==='revoked')throw Error('revoked');return {uid:token,googleSub:''};});
  const h=await setup({store,identify,now:()=>time});
  const home={provider:'microsoft' as const,connectionId:'c',driveId:'d',rootId:'r',rootName:'Meetings',folderId:'f',reportId:'j'};
  const ms={...report,driveFolderId:undefined,driveReportId:undefined,home};
  h.io.load.mockResolvedValue({report:ms,revision:'source-v1',indexRevision:'index-v1'});
  await h.call('/processing/meeting-1',{report:ms,analyze:false},'alice',true);
  let release!:()=>void;
  query.mockImplementationOnce(async owner=>{await new Promise<void>(r=>{release=r;});return store.get((await import('../server/processing')).jobKey(owner,report.id)).then(j=>j?[j]:[]);});
  const first=h.call('/processing');
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const second=h.call('/processing',undefined,'alice',true);
  await vi.waitFor(()=>expect(identify).toHaveBeenCalledTimes(3));
  release();
  expect((await first).body.jobs).toEqual([]);
  expect((await second).body.jobs).toHaveLength(1);
  expect(query).toHaveBeenCalledTimes(1);
  expect((await h.call('/processing',undefined,'revoked')).status).toBe(401);
  expect((await h.call('/processing',undefined,'bob')).body.jobs).toEqual([]);
  expect(query).toHaveBeenCalledTimes(2);
  time=start+4999;await h.call('/processing');expect(query).toHaveBeenCalledTimes(2);
  time=start+5000;await h.call('/processing');expect(query).toHaveBeenCalledTimes(3);
  // Idle entries survive 60 seconds, and the map cannot retain unlimited owners.
  await h.call('/processing',undefined,'idle');
  time+=59999;await h.call('/processing',undefined,'idle');expect(query).toHaveBeenCalledTimes(4);
  time++;await h.call('/processing',undefined,'idle');expect(query).toHaveBeenCalledTimes(5);
  for(let n=0;n<128;n++)await h.call('/processing',undefined,`owner-${n}`);
  const before=query.mock.calls.length;
  await h.call('/processing',undefined,'idle');expect(query).toHaveBeenCalledTimes(before+1);
});
it('invalidates cached lists on acceptance and every worker transition including done',async()=>{
  const store=memoryDocStore<ProcessingJob>();const query=vi.spyOn(store,'listByOwner');
  const h=await setup({store});
  expect((await h.call('/processing')).body.jobs).toEqual([]);
  await h.call('/processing/meeting-1',{report,analyze:false});
  expect((await h.call('/processing')).body.jobs[0].state).toBe('queued');
  expect(query).toHaveBeenCalledTimes(2);
  for(const state of ['exporting','exporting','done']){
    await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
    expect((await h.call('/processing')).body.jobs[0].state).toBe(state);
  }
  expect(query).toHaveBeenCalledTimes(5);
  await h.call('/processing');expect(query).toHaveBeenCalledTimes(5);
});
it('rejects browser tokens at worker and never does work on GET',async()=>{
  const h=await setup();await h.call('/processing/meeting-1',{report,analyze:true});
  const task=h.queue.mock.calls[0][0];
  expect((await h.call('/processing/worker',task,'alice')).status).toBe(401);
  await h.call('/processing/meeting-1');await h.call('/processing');
  expect(h.analyze).not.toHaveBeenCalled();expect(h.io.checkpoint).not.toHaveBeenCalled();
});
it('serializes duplicate dispatch and ignores an old run after new revision',async()=>{
  const h=await setup();await h.call('/processing/meeting-1',{report,analyze:true});
  const task=h.queue.mock.calls[0][0];
  const results=await Promise.all([h.call('/processing/worker',task,'worker'),h.call('/processing/worker',task,'worker')]);
  expect(results.some(r=>r.status===200)).toBe(true);
  expect(h.io.checkpoint).toHaveBeenCalledTimes(1);
  for(let n=0;n<3;n++)await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  h.io.load.mockResolvedValue({report:{...report,transcription:'Neue Revision'},revision:'new',indexRevision:'new'});
  await h.call('/processing/meeting-1',{report,analyze:true});
  const current=h.queue.mock.calls.at(-1)![0];
  expect(current.run).not.toBe(task.run);
  await h.call('/processing/worker',task,'worker');
  expect(h.queue.mock.calls.at(-1)![0]).toEqual(current);
});
it('retries transient errors with bounds and does not repeat a Drive analysis checkpoint',async()=>{
  const h=await setup();await h.call('/processing/meeting-1',{report,analyze:true});
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  h.analyze.mockRejectedValueOnce(Object.assign(Error('private-provider-detail'),{status:429}));
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect((await h.call('/processing/meeting-1')).body.job.state).toBe('analyzing');
  expect(JSON.stringify((await h.call('/processing/meeting-1')).body)).not.toContain('private-provider-detail');
  expect(h.queue.mock.calls.at(-1)![1]).toBeGreaterThan(0);
  h.artifacts.set('analyzed',{...report,summary:'Already durable'});
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect(h.analyze).toHaveBeenCalledTimes(1);
  expect((await h.call('/processing/meeting-1')).body.job.state).toBe('exporting');
});
it('leaves a persisted acceptance retryable if enqueue fails before acknowledgment',async()=>{
  const h=await setup();h.queue.mockRejectedValueOnce(Error('network'));
  expect((await h.call('/processing/meeting-1',{report,analyze:true})).status).toBe(503);
  const run=h.queue.mock.calls[0][0].run;
  expect((await h.call('/processing/meeting-1',{report,analyze:true})).status).toBe(202);
  expect(h.queue.mock.calls[1][0].run).toBe(run);
});
it('can explicitly analyze a previously save-only job without performing ASR while saving',async()=>{
  const batch=vi.fn(async()=>null);const h=await setup({batch});
  await h.call('/processing/meeting-1',{report,analyze:false,retranscribe:true});
  for(let n=0;n<3;n++)await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect((await h.call('/processing/meeting-1')).body.job.state).toBe('done');
  expect(batch).not.toHaveBeenCalled();expect(h.analyze).not.toHaveBeenCalled();
  await h.call('/processing/meeting-1',{report,analyze:true});
  for(let n=0;n<4;n++)await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect(h.analyze).toHaveBeenCalledTimes(1);
});
it('accepts durable text-only processing, checkpoints each step and hydrates final report owner-only',async()=>{
  const h=await setup();
  const accepted=await h.call('/processing/meeting-1',{report:{...report,transcription:'UNTRUSTED'},analyze:true});
  expect(accepted.status).toBe(202);
  expect(accepted.body.job.state).toBe('queued');
  expect(h.queue).toHaveBeenCalledTimes(1);
  for(let n=0;n<5;n++) {
    const task=h.queue.mock.calls.at(-1)![0];
    expect((await h.call('/processing/worker',task,'worker')).status).toBe(200);
    if((await h.call('/processing/meeting-1')).body.job.state==='done') break;
  }
  expect(h.analyze).toHaveBeenCalledWith(report.transcription,'');
  const final=await h.call('/processing/meeting-1');
  expect(final.body.job.state).toBe('done');
  expect(final.body.report.summary).toBe('Zusammenfassung');
  expect(final.body.report.title).toBe('Mein Meeting');
  expect((await h.call('/processing/meeting-1',undefined,'bob')).status).toBe(404);
  expect((await h.call('/processing',undefined,'bob')).body.jobs).toEqual([]);
  expect(JSON.stringify(await h.store.listByOwner('alice'))).not.toContain(report.transcription);
  expect(JSON.stringify(final.body.job)).not.toContain('sub-alice');
});

it('never submits another batch pass after an uncertain paid POST even when processing is resumed',async()=>{
  const docs=new Map<string,Submission>();
  const store:SubmissionStore={get:async k=>docs.get(k)||null,set:async(k,v)=>{docs.set(k,v);},reserve:async(k,v)=>{if(docs.has(k))return false;docs.set(k,v);return true;},retry:async(k,v)=>{if(docs.get(k)?.state!=='retryable')return false;docs.set(k,v);return true;}};
  let submissions=0;
  const provider=vi.fn(async(url:any)=>{
    if(String(url).endsWith('/upload'))return new Response(JSON.stringify({upload_url:'provider-private-upload'}));
    submissions++;throw Error('socket lost after provider accepted');
  });
  const service=createBatchTranscriptionService({store,apiKey:'test-key',fetchImpl:provider as any});
  const batch=async(j:ProcessingJob,r:ReportData)=>{
    const found=await service.poll(j.owner,r.id);
    if(found.state==='completed')return found.speech;
    if(found.state==='retryable')await service.start(j.owner,r.id,['de'],Readable.from(['audio']));
    return null;
  };
  const h=await setup({batch});
  h.io.load.mockResolvedValue({report:{...report,transcription:'',transcriptionOrigin:'import'},revision:'source-v1',indexRevision:'index-v1'});
  await h.call('/processing/meeting-1',{report,analyze:true});
  for(let n=0;n<2;n++)await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect((await h.call('/processing/meeting-1')).body.job.state).toBe('blocked');
  expect(docs.get(submissionKey('alice','meeting-1:final'))?.state).toBe('reserved');
  await h.call('/processing/meeting-1',{report,analyze:true});
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect(submissions).toBe(1);expect(h.analyze).not.toHaveBeenCalled();
});
it('recovers the archived speech document when its derived transcript string is missing',async()=>{
  const h=await setup();h.io.load.mockResolvedValue({report:{...report,transcription:'',speech:{provider:'assemblyai',phase:'final',languages:['de'],turns:[{id:'batch:0',speaker:'batch:A',text:'Gesicherte Worte',startMs:0,endMs:1000,final:true}],speakerNames:{},speakerReview:'skipped'}},revision:'source-v1',indexRevision:'index-v1'});
  await h.call('/processing/meeting-1',{report,analyze:true});
  for(let n=0;n<2;n++)await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect(h.analyze).toHaveBeenCalledWith(expect.stringContaining('Gesicherte Worte'),'');
});
it('uses existing imported text for recovery instead of spending another batch pass',async()=>{
  const batch=vi.fn(async()=>null);const h=await setup({batch});
  h.io.load.mockResolvedValue({report:{...report,transcriptionOrigin:'import'},revision:'source-v1',indexRevision:'index-v1'});
  await h.call('/processing/meeting-1',{report,analyze:true});
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect(batch).not.toHaveBeenCalled();
  expect((await h.call('/processing/meeting-1')).body.job.state).toBe('analyzing');
});
it('pauses speaker-ambiguous live retranscription and resumes reviewed source without another paid pass',async()=>{
  const speech={provider:'assemblyai' as const,phase:'final' as const,languages:['de'],turns:[{id:'batch:0',speaker:'batch:A',text:'Neue Worte',startMs:0,endMs:1000,final:true}],speakerNames:{}};
  const batch=vi.fn(async()=>speech);const h=await setup({batch});
  h.io.load.mockResolvedValue({report:{...report,transcriptionOrigin:'live',speech:{...speech,phase:'live',turns:[]}},revision:'source-v1',indexRevision:'index-v1'});
  await h.call('/processing/meeting-1',{report,analyze:true,retranscribe:true});
  for(let n=0;n<3;n++)await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  const review=(await h.call('/processing/meeting-1')).body;
  expect(review.job.state).toBe('review');expect(review.report.speech.speakerReview).toBe('pending');
  expect(h.analyze).not.toHaveBeenCalled();expect(batch).toHaveBeenCalledTimes(1);
});
it('bounds transient failures, blocks invalid grants and accepts explicit same-run recovery',async()=>{
  const h=await setup();await h.call('/processing/meeting-1',{report,analyze:true});
  h.io.load.mockRejectedValueOnce(new (await import('../server/processing')).ProcessingError(401,'Bitte Google erneut verbinden.',true));
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  const stopped=(await h.call('/processing/meeting-1')).body.job;
  expect(stopped.state).toBe('blocked');
  const old=h.queue.mock.calls.at(-1)![0];
  await h.call('/processing/meeting-1',{report,analyze:true});
  expect(h.queue.mock.calls.at(-1)![0].run).toBe(old.run);
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  h.analyze.mockRejectedValue(Error('offline'));
  for(let n=0;n<8;n++)await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect((await h.call('/processing/meeting-1')).body.job.state).toBe('error');
  expect(h.analyze).toHaveBeenCalledTimes(8);
});
it('does not rerun a completed job when Drive now contains its exported revision',async()=>{
  const h=await setup();await h.call('/processing/meeting-1',{report,analyze:true});
  for(let n=0;n<4;n++)await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  const done=(await h.call('/processing/meeting-1')).body.report;
  h.io.load.mockResolvedValue({report:done,revision:'exported-v2',indexRevision:'index-v2'});
  const before=h.queue.mock.calls.length;
  expect((await h.call('/processing/meeting-1',{report,analyze:true})).body.job.state).toBe('done');
  expect(h.queue).toHaveBeenCalledTimes(before);
});
it('regenerates an edited report only when explicitly requested, otherwise preserves its summary',async()=>{
  for(const regenerate of [false,true]){
    const h=await setup();
    h.io.load.mockResolvedValue({report:{...report,summary:'Bestehende Zusammenfassung'},revision:'edited-v2',indexRevision:'index-v2'});
    await h.call('/processing/meeting-1',{report,analyze:true,regenerate});
    for(let n=0;n<4;n++)await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
    expect(h.analyze).toHaveBeenCalledTimes(regenerate?1:0);
    expect((await h.call('/processing/meeting-1')).body.report.summary).toBe(regenerate?'Zusammenfassung':'Bestehende Zusammenfassung');
  }
});
it('defaults omitted preferences from the server, but respects an explicit empty override',async()=>{
  const preferences=vi.fn(async()=> 'Server-Präferenz');
  const h=await setup({preferences});
  await h.call('/processing/meeting-1',{report,analyze:true});
  expect(preferences).toHaveBeenCalledWith('alice');
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect(h.analyze).toHaveBeenCalledWith(report.transcription,'Server-Präferenz');
});
it('preserves reviewed final import speech without reading the paid batch job again',async()=>{
  const batch=vi.fn(async()=>null);const h=await setup({batch});
  h.io.load.mockResolvedValue({report:{...report,transcriptionOrigin:'import',speech:{provider:'assemblyai',phase:'final',languages:['de'],turns:[],speakerNames:{},speakerReview:'reviewed'}},revision:'source-v1',indexRevision:'index-v1'});
  await h.call('/processing/meeting-1',{report,analyze:true});
  await h.call('/processing/worker',h.queue.mock.calls.at(-1)![0],'worker');
  expect(batch).not.toHaveBeenCalled();
  expect((await h.call('/processing/meeting-1')).body.job.state).toBe('analyzing');
});
