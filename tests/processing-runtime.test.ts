import { afterEach, expect, it, vi } from 'vitest';
import { createDriveIO, mergeCalendarDescription } from '../server/processing/drive';
import { createTaskQueue, verifyProcessingWorker } from '../server/processing/runtime';
import { withProcessingBudget, boundedFetch } from '../server/processing/budget';
import { toArchive } from '../src/lib/archive';
import { ProcessingError, type ProcessingJob } from '../server/processing';
import type { ReportData } from '../src/types';

const report:ReportData={id:'meeting',title:'Titel',date:'2026-09-30T10:00:00Z',summary:'',transcription:'Gespeicherter Text',todos:[],takeaways:[],driveFolderId:'folder',driveReportId:'json'};
function fakeDrive(noV3Etags=false,laggingV2=false){
  const files=new Map<string,{name:string;mimeType:string;parents:string[];ownedByMe:boolean;body:any;etag:string}>();
  files.set('folder',{name:'Meeting',mimeType:'application/vnd.google-apps.folder',parents:[],ownedByMe:true,body:'',etag:'folder-1'});
  files.set('json',{name:'bericht_daten.json',mimeType:'application/json',parents:['folder'],ownedByMe:true,body:toArchive(report,report.date),etag:'json-1'});
  let index:any=null;let sourcePatches=0;let creates=0;let failAfterSourceWrite=false;
  const calls:{url:string;init:RequestInit}[]=[];
  const json=(v:unknown,status=200,etag?:string)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json',...(etag?{etag}:{})}});
  const f=vi.fn(async(input:any,init:RequestInit={})=>{
    const url=new URL(String(input));calls.push({url:String(input),init});
    if(url.hostname==='oauth2.googleapis.com')return json({access_token:'access',expires_in:3600});
    if(url.hostname==='firestore.googleapis.com'){
      if(init.method==='PATCH'){
        if(index)return json({},412);
        index={...JSON.parse(String(init.body)),updateTime:'published-1'};return json(index);
      }
      return index?json(index):json({},404);
    }
    if(url.hostname==='www.googleapis.com'&&url.pathname.startsWith('/calendar/'))return json({description:'Notizen vom Organisator',etag:'calendar-1',htmlLink:'https://calendar/event'});
    const fid=/\/files\/([^/]+)$/.exec(url.pathname)?.[1];
    if(url.pathname==='/upload/drive/v3/files'){
      const body=String(init.body);const meta=JSON.parse(body.split('\r\n\r\n')[1].split('\r\n')[0]);
      const content=body.split('\r\n\r\n')[2].split('\r\n--cheatmeet_processing_boundary')[0];
      const file=`created-${++creates}`;
      files.set(file,{...meta,ownedByMe:true,body:meta.mimeType==='application/json'?JSON.parse(content):content,etag:file+'-1'});
      return json({id:file});
    }
    if(fid&&url.pathname.startsWith('/upload/')){
      const file=files.get(fid)!;
      if((init.headers as any)['If-Match']&&(init.headers as any)['If-Match']!==file.etag)return json({},412);
      file.body=file.mimeType==='application/json'?JSON.parse(String(init.body)):String(init.body);file.etag+='-next';
      if(fid==='json'){sourcePatches++;if(failAfterSourceWrite){failAfterSourceWrite=false;throw Error('connection lost after commit');}}
      return json({id:fid});
    }
    if(fid){const file=files.get(fid);if(!file)return json({},404);if(url.pathname.startsWith('/drive/v2/'))return json({etag:file.etag,version:file.etag+(laggingV2?'-stale':'')});return url.searchParams.get('alt')==='media'?json(file.body,200,noV3Etags?undefined:file.etag):json({id:fid,...file,version:file.etag},200,noV3Etags?undefined:file.etag);}
    const q=url.searchParams.get('q')||'';const name=/name = '([^']+)'/.exec(q)?.[1];
    return json({files:[...files.entries()].filter(([,v])=>v.name===name&&v.parents.includes('folder')).map(([id])=>({id}))});
  }) as unknown as typeof fetch;
  const io=createDriveIO({fetchImpl:f,grants:{get:async()=> 'refresh',set:async()=>{},remove:async()=>{}},runtimeToken:async()=> 'runtime'});
  const j={owner:'alice',googleSub:'google-alice',refs:{id:'meeting',driveReportId:'json',driveFolderId:'folder'},run:'run-1',updatedAt:report.date,calendarSync:false,analyze:true} as ProcessingJob;
  return {io,j,files,calls,f,setIndex:(v:any)=>{index=v;},failAfterWrite:()=>{failAfterSourceWrite=true;},sourcePatches:()=>sourcePatches,creates:()=>creates,index:()=>index};
}
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('uses named Firestore, verifies source membership, exports/upserts and publishes transcript-free projection',async()=>{
  const h=fakeDrive();const initial=await h.io.load(h.j);Object.assign(h.j,{revision:initial.revision,indexRevision:initial.indexRevision});
  const exported=await h.io.export(h.j,{...report,summary:'Ergebnis'});
  await h.io.checkpoint(h.j,'exported',exported);
  await h.io.publish(h.j,exported);await h.io.publish(h.j,exported);
  expect(h.sourcePatches()).toBe(1);
  expect(h.index().fields.transcription.stringValue).toBe('');
  expect(h.index().fields.speech).toBeUndefined();
  expect(h.index().fields.transcriptChars.integerValue).toBe(String(report.transcription.length));
  expect(h.calls.find(c=>c.url.includes('firestore.googleapis.com'))!.url).not.toContain('/databases/(default)/');
  expect(h.calls.filter(c=>c.url.includes('/calendar/'))).toHaveLength(0);
  expect((await h.io.readCheckpoint(h.j,'exported'))?.summary).toBe('Ergebnis');
});
it('uses a real Drive v2 revision precondition when v3 omits ETag headers',async()=>{
  const h=fakeDrive(true);Object.assign(h.j,await h.io.load(h.j));
  const result=await h.io.export(h.j,{...report,summary:'Ergebnis'});
  expect(result.summary).toBe('Ergebnis');
  const write=h.calls.find(c=>c.url.includes('/upload/drive/v2/files/json'));
  expect(write?.init.method).toBe('PUT');
  expect((write?.init.headers as any)['If-Match']).toBe('json-1');
});
it('retries an inconsistent Drive revision read without classifying it as a human edit or writing bytes',async()=>{
  const h=fakeDrive(true,true);
  await expect(h.io.load(h.j)).rejects.toMatchObject({status:503,blocked:false});
  expect(h.sourcePatches()).toBe(0);
});
it('classifies malformed durable archives as permanent validation failures',async()=>{
  const h=fakeDrive();h.files.get('json')!.body={...h.files.get('json')!.body,title:null};
  await expect(h.io.load(h.j)).rejects.toMatchObject({status:422});
});
it('refuses to overwrite a newer user-edited index from an older Drive archive',async()=>{
  const h=fakeDrive();h.setIndex({updateTime:'newer',fields:{id:{stringValue:'meeting'},title:{stringValue:'Benutzer-Titel'},summary:{stringValue:'Benutzer-Zusammenfassung'},updatedAt:{stringValue:'2026-11-01T10:00:00Z'}}});
  await expect(h.io.load(h.j)).rejects.toMatchObject({status:409,blocked:true});
  expect(h.sourcePatches()).toBe(0);
});
it('persists Calendar warnings across Drive checkpoints and never treats them as a failed report',async()=>{
  const h=fakeDrive();Object.assign(h.j,await h.io.load(h.j));
  await h.io.checkpoint(h.j,'exported',{...report,summary:'Ergebnis',calendarError:'Kalender fehlt.'});
  expect((await h.io.readCheckpoint(h.j,'exported'))?.calendarError).toBe('Kalender fehlt.');
});
it('recovers durable text when retained audio was already deleted, without fetching audio',async()=>{
  const h=fakeDrive();h.files.get('json')!.body={...h.files.get('json')!.body,rawAudioUrl:'deleted-audio',audioDeletedAt:'2026-10-01T00:00:00Z'};
  const result=await h.io.load(h.j);
  expect(result.report.transcription).toBe(report.transcription);
  expect(h.calls.some(c=>c.url.includes('deleted-audio'))).toBe(false);
});
it('recovers a committed-but-unacknowledged Drive source update without overwriting or creating duplicate exports',async()=>{
  const h=fakeDrive();Object.assign(h.j,await h.io.load(h.j));h.failAfterWrite();
  await expect(h.io.export(h.j,{...report,summary:'Ergebnis'})).rejects.toThrow('connection lost');
  const count=h.creates();
  const recovered=await h.io.export(h.j,{...report,summary:'Ergebnis'});
  expect(recovered.summary).toBe('Ergebnis');expect(h.sourcePatches()).toBe(1);expect(h.creates()).toBe(count);
});
it('blocks changed source and foreign Drive parents before writing anything',async()=>{
  const h=fakeDrive();Object.assign(h.j,await h.io.load(h.j));
  h.files.get('json')!.body.summary='User edit';
  await expect(h.io.export(h.j,{...report,summary:'AI'})).rejects.toMatchObject({status:409,blocked:true});
  expect(h.sourcePatches()).toBe(0);
  h.files.get('json')!.parents=['foreign'];
  await expect(h.io.load(h.j)).rejects.toMatchObject({status:403,blocked:true});
});
it('pauses for missing and revoked grants instead of deleting them',async()=>{
  const remove=vi.fn();const base={set:async()=>{},remove};
  const missing=createDriveIO({grants:{...base,get:async()=>null},fetchImpl:vi.fn() as any});
  await expect(missing.load(fakeDrive().j)).rejects.toMatchObject({status:401,blocked:true});
  const revoked=createDriveIO({grants:{...base,get:async()=> 'refresh'},fetchImpl:vi.fn(async()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400})) as any});
  await expect(revoked.load(fakeDrive().j)).rejects.toMatchObject({status:401,blocked:true});
  expect(remove).not.toHaveBeenCalled();
});
it('preserves Calendar organiser text and only PATCHes an already-linked opted-in event',async()=>{
  const h=fakeDrive();Object.assign(h.j,await h.io.load(h.j));h.j.calendarSync=true;
  const result=await h.io.export(h.j,{...report,summary:'Ergebnis',calendarId:'primary',calendarEventId:'event'});
  const writes=h.calls.filter(c=>c.url.includes('/calendar/')&&c.init.method==='PATCH');
  expect(writes).toHaveLength(1);expect(JSON.parse(String(writes[0].init.body)).description).toContain('Notizen vom Organisator');
  expect(result.calendarSyncedAt).toBeTruthy();
  const first=mergeCalendarDescription('Vorher\n\n--- CheatMeet ---\nAlt\n--- Ende CheatMeet ---\n\nNachher','Neu');
  expect(first).toBe('Vorher\n\n--- CheatMeet ---\nNeu\n--- Ende CheatMeet ---\n\nNachher');
  expect(mergeCalendarDescription(first,'Neu')).toBe(first);
});
it('enqueues deterministic OIDC Cloud Tasks without credentials in the payload and tolerates AlreadyExists',async()=>{
  vi.stubEnv('PROCESSING_QUEUE','projects/test/locations/eu/queues/processing');vi.stubEnv('PROCESSING_WORKER_URL','https://app/api/processing/worker');vi.stubEnv('PROCESSING_SERVICE_ACCOUNT','worker@test.iam.gserviceaccount.com');
  const f=vi.fn(async()=>new Response('{}',{status:409}));
  await createTaskQueue(f as any,async()=> 'runtime')({key:'key',run:'run',seq:2},30);
  const body=JSON.parse(String((f.mock.calls[0] as any)[1].body));
  expect(body.task.dispatchDeadline).toBe('240s');
  expect(body.task.httpRequest.oidcToken).toEqual({serviceAccountEmail:'worker@test.iam.gserviceaccount.com',audience:'https://app/api/processing/worker'});
  expect(JSON.parse(Buffer.from(body.task.httpRequest.body,'base64').toString())).toEqual({key:'key',run:'run',seq:2});
  await expect(verifyProcessingWorker('not-a-google-id-token')).rejects.toBeTruthy();
});
it('applies one awaited budget across REST requests, including their existing timeout signals',async()=>{
  const f=vi.fn(async(_url:any,init:any)=>{await new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});return new Response('{}');});
  vi.stubGlobal('fetch',f);
  await expect(withProcessingBudget(10,()=>boundedFetch('https://fake.test',{signal:AbortSignal.timeout(5000)}))).rejects.toBeTruthy();
  expect(f).toHaveBeenCalledTimes(1);
});
