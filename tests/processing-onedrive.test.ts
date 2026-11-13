import { describe, expect, it, vi } from 'vitest';
import { createOneDriveIO } from '../server/processing/onedrive';
import type { ProcessingJob } from '../server/processing';
import type { ReportData } from '../src/types';

const home = { provider:'microsoft' as const, connectionId:'connection', driveId:'drive', rootId:'root', rootName:'Meetings', folderId:'folder', reportId:'report' };
const report:ReportData = { id:'meeting', title:'Meeting', date:'2026-11-13', summary:'Existing summary', transcription:'Private transcript', todos:[], takeaways:[], status:'completed', home, updatedAt:'2026-11-13T10:00:00Z' };
const job = ():ProcessingJob => ({ owner:'owner', googleSub:'', refs:{id:'meeting',driveFolderId:'folder',driveReportId:'report',home}, run:'run', revision:'',indexRevision:'',updatedAt:'2026-11-13T10:00:00Z' } as ProcessingJob);
const json = (v:unknown,status=200,headers:Record<string,string>={}) => new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json',...headers}});
function fixture(calendar?:(j:ProcessingJob,r:ReportData)=>Promise<ReportData>) {
  let raw:any={...report,archive:{version:1}};
  let etag='"v1"'; let ownDrive='drive'; let index:any=null;
  const items=new Map<string,any>([
    ['root',{id:'root',folder:{},parentReference:{driveId:'drive'}}],
    ['folder',{id:'folder',folder:{},parentReference:{driveId:'drive',id:'root'}}],
    ['report',{id:'report',file:{},parentReference:{driveId:'drive',id:'folder'}}],
  ]);
  const contents=new Map<string,string>(); const writes:any[]=[];
  const fetchImpl=vi.fn(async (input:any,init:RequestInit={}) => {
    const u=new URL(String(input)); const method=init.method||'GET';
    if(u.hostname==='firestore.googleapis.com') {
      if(method==='PATCH'){writes.push({url:u.href,init});return json({updateTime:'next'});}
      return index?json(index):json({},404);
    }
    expect(u.origin).toBe('https://graph.microsoft.com');
    if(u.pathname==='/v1.0/me/drive')return json({id:ownDrive});
    const named=/\/items\/folder:\/([^/]+)(:\/content)?$/.exec(u.pathname);
    if(named) {
      const name=decodeURIComponent(named[1]);const existing=[...items.values()].find(x=>x.name===name);
      if(method==='GET')return existing?json(existing):json({},404);
      if(existing)return json({},409);
      writes.push({url:u.href,init});
      const item={id:`artifact${items.size}`,name,file:{},eTag:'"artifact"',parentReference:{driveId:'drive',id:'folder'}};
      items.set(item.id,item);contents.set(item.id,String(init.body));return json(item);
    }
    const match=/\/items\/([^/:]+)(.*)/.exec(u.pathname);
    if(!match)throw Error(`Unexpected URL ${u}`);
    const id=decodeURIComponent(match[1]),tail=match[2];
    if(tail==='/children')return json({value:[...items.values()].filter(x=>x.parentReference?.id===id)});
    if(method==='PUT') {
      writes.push({url:u.href,init});
      if(tail===':/content') {
        const name=decodeURIComponent(id); const newId=`artifact${items.size}`;
        const item={id:newId,name,file:{},eTag:'"artifact"',parentReference:{driveId:'drive',id:'folder'}};
        items.set(newId,item);contents.set(newId,String(init.body));return json(item);
      }
      if(id==='report'){raw=JSON.parse(String(init.body));etag='"v2"';return json({...items.get(id),eTag:etag});}
      contents.set(id,String(init.body));return json({...items.get(id),eTag:'"artifact"'});
    }
    if(tail==='/content')return id==='report'?json(raw,200,{etag}):new Response(contents.get(id)||'',{headers:{etag:'"artifact"'}});
    const item=items.get(id);return item?json({...item,eTag:id==='report'?etag:'"artifact"'}):json({},404);
  }) as unknown as typeof fetch;
  const access=vi.fn(async()=> 'microsoft-token');
  const io=createOneDriveIO({fetchImpl,access,runtimeToken:async()=> 'runtime-token',calendar});
  return {io,fetchImpl,access,items,contents,writes,get raw(){return raw;},set raw(v){raw=v;},set etag(v:string){etag=v;},set ownDrive(v:string){ownDrive=v;},set index(v:any){index=v;}};
}

describe('OneDrive audio',()=>{
  it('streams a validated audio artifact without forwarding OAuth to its download redirect',async()=>{
    const f=fixture();f.items.set('audio',{id:'audio',file:{},parentReference:{driveId:'drive',id:'folder'}});
    const original=vi.mocked(f.fetchImpl).getMockImplementation()!;
    vi.mocked(f.fetchImpl).mockImplementation(async(url,init)=>{
      if(String(url).endsWith('/audio/content'))return new Response(null,{status:302,headers:{location:'https://tenant.sharepoint.com/download?capability=private'}});
      if(String(url).startsWith('https://tenant.sharepoint.com/')) {
        expect(new Headers(init?.headers).get('Authorization')).toBeNull();expect(init?.redirect).toBe('manual');
        return new Response('audio-bytes');
      }
      return original(url,init);
    });
    const audio=await f.io.audio(job(),{...report,home:{...home,audioId:'audio'}});
    const chunks=[];for await(const chunk of audio)chunks.push(Buffer.from(chunk));expect(Buffer.concat(chunks).toString()).toBe('audio-bytes');
  });
  it('rejects attacker download hosts before making a credential-free request',async()=>{
    const f=fixture();f.items.set('audio',{id:'audio',file:{},parentReference:{driveId:'drive',id:'folder'}});
    const original=vi.mocked(f.fetchImpl).getMockImplementation()!;
    vi.mocked(f.fetchImpl).mockImplementation(async(url,init)=>String(url).endsWith('/audio/content')?new Response(null,{status:302,headers:{location:'https://attacker.example/file'}}):original(url,init));
    await expect(f.io.audio(job(),{...report,home:{...home,audioId:'audio'}})).rejects.toMatchObject({status:502});
    expect(vi.mocked(f.fetchImpl).mock.calls.some(([url])=>String(url).includes('attacker.example'))).toBe(false);
  });
});

describe('OneDrive index publication',()=>{
  it('writes only a transcript-free owner meeting index using updateTime precondition',async()=>{
    const f=fixture();const j=job();j.indexRevision='2026-11-13T10:00:00.000001Z';
    f.index={updateTime:j.indexRevision,fields:{}};
    await f.io.publish(j,report);
    expect(f.writes).toHaveLength(1);const {url,init}=f.writes[0];
    expect(url).toContain('/users/owner/meetings/meeting?currentDocument.updateTime=');
    const fields=JSON.parse(init.body).fields;expect(fields.transcription).toEqual({stringValue:''});expect(fields.speech).toBeUndefined();
    expect(fields.home.mapValue.fields.provider).toEqual({stringValue:'microsoft'});
    expect(fields.rawAudioUrl).toBeUndefined();
    f.index={updateTime:'newer',fields:{title:{stringValue:'Human edit'}}};
    await expect(f.io.publish(j,report)).rejects.toMatchObject({status:409});expect(f.writes).toHaveLength(1);
  });
});

describe('OneDrive export',()=>{
  it('loads the first canonical upload before its own new item ID could be serialized into itself',async()=>{
    const f=fixture();const first={...f.raw,home:{...home}};delete first.home.reportId;f.raw=first;
    const loaded=await f.io.load(job());
    expect(loaded.report.home?.reportId).toBe('report');
    expect(loaded.report.transcription).toBe('Private transcript');
  });
  it('runs opted-in calendar sync after source guards and durably retains its result',async()=>{
    const calendar=vi.fn(async(_j:ProcessingJob,r:ReportData)=>({...r,calendarSyncedAt:'2026-11-13T12:00:00Z',calendarError:'Calendar warning'}));
    const f=fixture(calendar);const j=job();j.analyze=true;j.calendarSync=true;Object.assign(j,await f.io.load(j));
    const out=await f.io.export(j,report);
    expect(calendar).toHaveBeenCalledTimes(1);expect(out.calendarSyncedAt).toBe('2026-11-13T12:00:00Z');
    expect(out.calendarError).toBe('Calendar warning');
    expect((await f.io.export(j,report)).calendarSyncedAt).toBe(out.calendarSyncedAt);
    expect(calendar).toHaveBeenCalledTimes(1);
  });
  it('conditionally exports markdown and source, preserving summary/calendar and reusing export plan on retry',async()=>{
    const f=fixture();const j=job();Object.assign(j,await f.io.load(j));
    const input={...report,calendarProvider:'microsoft' as const,calendarConnectionId:'calendar-connection',calendarEventId:'event',calendarId:'calendar'};
    const out=await f.io.export(j,input);
    expect(out.summary).toBe('Existing summary');
    expect(out).toMatchObject({calendarProvider:'microsoft',calendarConnectionId:'calendar-connection',calendarEventId:'event'});
    expect(out.home?.markdownId).toBeTruthy();expect(out.home?.transcriptId).toBeTruthy();
    const authoritative=f.writes.filter(x=>new URL(x.url).pathname==='/v1.0/drives/drive/items/report/content');
    expect(authoritative).toHaveLength(1);expect(new Headers(authoritative[0].init.headers).get('If-Match')).toBe('"v1"');
    expect(f.raw.home).toEqual(out.home);expect(f.raw).not.toHaveProperty('driveFolderId');
    const count=f.writes.length;expect(await f.io.export(j,input)).toEqual(out);expect(f.writes).toHaveLength(count);
  });
  it('rejects an ETag-only edit between the initial export snapshot and authoritative write',async()=>{
    const f=fixture();const j=job();Object.assign(j,await f.io.load(j));
    const original=vi.mocked(f.fetchImpl).getMockImplementation()!;
    vi.mocked(f.fetchImpl).mockImplementation(async(url,init)=>{
      const res=await original(url,init);
      if(init?.method==='PUT'&&String(url).includes('export-plan.json'))f.etag='"edited"';
      return res;
    });
    await expect(f.io.export(j,report)).rejects.toMatchObject({status:409});
    expect(f.writes.some(w=>w.url.endsWith('/report/content'))).toBe(false);
  });
  it('retains a saved export plan across a conditional 412 rejection',async()=>{
    const f=fixture();const j=job();Object.assign(j,await f.io.load(j));
    const original=vi.mocked(f.fetchImpl).getMockImplementation()!;
    vi.mocked(f.fetchImpl).mockImplementation(async(url,init)=>init?.method==='PUT'&&String(url).endsWith('/report/content')?json({},412):original(url,init));
    await expect(f.io.export(j,report)).rejects.toMatchObject({status:412,blocked:true});
    expect(await f.io.readCheckpoint(j,'export-plan')).toMatchObject({summary:'Existing summary'});
    expect(f.raw.home.markdownId).toBeUndefined();
  });
  it('does not write when the owner index revision changed',async()=>{
    const f=fixture();const j=job();Object.assign(j,await f.io.load(j));
    // Same archive binding/content, but a different Firestore snapshot is still a conflict.
    f.index={updateTime:'newer',fields:{home:{mapValue:{fields:Object.fromEntries(Object.entries(home).map(([k,v])=>[k,{stringValue:v}]))}}}};
    await expect(f.io.export(j,report)).rejects.toMatchObject({status:409});expect(f.writes).toHaveLength(0);
  });
  it('refuses a name lookup that aliases the authoritative source file',async()=>{
    const f=fixture();f.items.get('report').name='transkript.md';const j=job();Object.assign(j,await f.io.load(j));
    await expect(f.io.export(j,report)).rejects.toMatchObject({status:403});expect(f.writes).toHaveLength(0);
  });
  it('never overwrites archive-discovered audio when a derived filename aliases it',async()=>{
    const f=fixture();f.items.set('audio',{id:'audio',name:'transkript.md',file:{},parentReference:{driveId:'drive',id:'folder'}});
    f.raw={...f.raw,home:{...home,audioId:'audio'}};const j=job();const loaded=await f.io.load(j);Object.assign(j,loaded);
    await expect(f.io.export(j,loaded.report)).rejects.toMatchObject({status:403});expect(f.writes).toHaveLength(0);
  });
  it('does not write anything when canonical source content changed',async()=>{
    const f=fixture();const j=job();Object.assign(j,await f.io.load(j));
    f.raw={...f.raw,summary:'Human edit'};
    await expect(f.io.export(j,report)).rejects.toMatchObject({status:409});expect(f.writes).toHaveLength(0);
  });
});

describe('OneDrive processing checkpoints',()=>{
  it('durably reuses a run-specific checkpoint without overwriting it',async()=>{
    const f=fixture();const j=job();
    expect(await f.io.readCheckpoint(j,'prepared')).toBeNull();
    await f.io.checkpoint(j,'prepared',report);
    const saved=await f.io.readCheckpoint(j,'prepared');
    expect(saved).toMatchObject({summary:'Existing summary',transcription:'Private transcript',home});
    expect([...f.items.values()].some(x=>x.name==='.cheatmeet-processing-run-prepared.json')).toBe(true);
    const count=f.writes.length;
    await f.io.checkpoint(j,'prepared',report);expect(f.writes).toHaveLength(count);
    await expect(f.io.checkpoint(j,'prepared',{...report,summary:'Different'})).rejects.toMatchObject({status:409});
    expect(await f.io.readCheckpoint({...j,run:'another'},'prepared')).toBeNull();
    expect(JSON.stringify([...f.contents.values()])).not.toContain('microsoft-token');
  });
});

describe('OneDrive processing source',()=>{
  it('recovers text after consent retention removed the audio without trusting a missing artifact',async()=>{
    const f=fixture();f.raw={...f.raw,home:{...home,audioId:'expired-audio'}};
    const loaded=await f.io.load(job());expect(loaded.report.transcription).toBe('Private transcript');
    expect(loaded.report.home?.audioId).toBeUndefined();
  });
  it('never accepts the authoritative JSON as a derived artifact target',async()=>{
    const f=fixture();f.raw={...f.raw,home:{...home,markdownId:'report'}};
    await expect(f.io.load(job())).rejects.toMatchObject({status:403});expect(f.writes).toHaveLength(0);
  });
  it('rejects another actual OneDrive even when requested metadata could be accessible',async()=>{
    const f=fixture();f.ownDrive='another-drive';
    await expect(f.io.load(job())).rejects.toMatchObject({status:403});
    expect(vi.mocked(f.fetchImpl).mock.calls).toHaveLength(1);expect(f.writes).toHaveLength(0);
  });
  it('rejects cross-meeting artifacts and remote shortcuts',async()=>{
    const f=fixture();f.raw={...f.raw,home:{...home,audioId:'foreign'}};
    f.items.set('foreign',{id:'foreign',file:{},parentReference:{driveId:'drive',id:'other-folder'}});
    await expect(f.io.load(job())).rejects.toMatchObject({status:403});
    f.raw={...report};f.items.get('folder').remoteItem={id:'remote'};
    await expect(f.io.load(job())).rejects.toMatchObject({status:403});expect(f.writes).toHaveLength(0);
  });
  it('requires a finalized valid home before obtaining any token',async()=>{
    const f=fixture();const j=job();delete (j.refs as any).home.reportId;
    try {await expect(f.io.load(j)).rejects.toMatchObject({status:400});expect(f.access).not.toHaveBeenCalled();}
    finally {(j.refs as any).home.reportId='report';}
  });
  it('retries inconsistent content/metadata ETag snapshots without writing',async()=>{
    const f=fixture();const original=vi.mocked(f.fetchImpl).getMockImplementation()!;
    vi.mocked(f.fetchImpl).mockImplementation(async(url,init)=>{
      const res=await original(url,init);
      if(String(url).endsWith('/report/content'))f.etag='"changed"';
      return res;
    });
    await expect(f.io.load(job())).rejects.toMatchObject({status:503});expect(f.writes).toHaveLength(0);
  });
  it('does not classify an interrupted source-body read as permanently invalid JSON',async()=>{
    const f=fixture();const original=vi.mocked(f.fetchImpl).getMockImplementation()!;const error=new Error('download interrupted');
    vi.mocked(f.fetchImpl).mockImplementation(async(url,init)=>{
      if(String(url).endsWith('/report/content'))return new Response(new ReadableStream({start(controller){controller.error(error);}}));
      return original(url,init);
    });
    await expect(f.io.load(job())).rejects.toBe(error);expect(f.writes).toHaveLength(0);
  });
  it('canonical hash ignores JSON object key order but detects content changes',async()=>{
    const f=fixture();const first=await f.io.load(job());
    f.raw=Object.fromEntries(Object.entries(f.raw).reverse());expect((await f.io.load(job())).revision).toBe(first.revision);
    f.raw={...f.raw,title:'Edited'};expect((await f.io.load(job())).revision).not.toBe(first.revision);
  });
  it('pins access and index to the job owner, parses content without legacy Drive IDs',async()=>{
    const f=fixture();const j=job();const loaded=await f.io.load(j);
    expect(f.access).toHaveBeenCalledWith('owner','connection');
    expect(f.fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/users/owner/meetings/meeting'),expect.anything());
    expect(loaded.report).toMatchObject({title:'Meeting',summary:'Existing summary',transcription:'Private transcript',home});
    expect(loaded.report).not.toHaveProperty('driveFolderId');expect(loaded.report).not.toHaveProperty('driveReportId');
    expect(loaded.revision).toMatch(/^[a-f0-9]{64}$/);
  });
});
