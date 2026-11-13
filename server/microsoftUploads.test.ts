import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { memoryDocStore } from './mcp/docStore';
import { createMicrosoftUploadRouter, type UploadDocument } from './microsoftUploads';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); });
const uploadUrl = 'https://sn3302.up.1drv.com/up/private-capability';
const expiry = () => new Date(Date.now() + 3600_000).toISOString();
const input = {connectionId:'connection', driveId:'drive', parentId:'parent', name:'bericht_daten.json', size:12};
const item = {id:'new', name:input.name, size:12, eTag:'"new"', file:{}, parentReference:{driveId:'drive',id:'parent'}, createdDateTime:new Date(Date.now()+1000).toISOString()};
function provider() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/me/drive')) return Response.json({id:'drive'});
    if (url.endsWith('/items/parent')) return Response.json({id:'parent',folder:{},parentReference:{driveId:'drive'}});
    if (url.endsWith('/createUploadSession')) return Response.json({uploadUrl,expirationDateTime:expiry()});
    if (url.includes(':/bericht_daten.json')) return new Response(null,{status:404});
    throw Error('Unexpected test request: '+url+' '+init?.method);
  });
}
async function fixture(fetchImpl = provider(), store = memoryDocStore<UploadDocument>()) {
  const app = express();
  app.use('/api',createMicrosoftUploadRouter({store,identify:async t=>({uid:t,googleSub:''}),access:async()=> 'graph-secret',fetchImpl:fetchImpl as typeof fetch}));
  const server = createServer(app); servers.push(server);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as {port:number}).port;
  const post=async (route:string,body:unknown,owner='alice')=>{
    const response=await fetch(`http://127.0.0.1:${port}/api/microsoft/uploads${route}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+owner},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  return {post,fetchImpl,store};
}
describe('Microsoft server-owned upload sessions',()=>{
  it('resumes after router restart, never sends bearer to the upload URL, hides foreign handles',async()=>{
    const f=await fixture(); const {handle}=(await f.post('',input)).body;
    f.fetchImpl.mockImplementation(async(url,init)=>{
      expect(url).toBe(uploadUrl); expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.redirect).toBe('error');
      return Response.json({nextExpectedRanges:['4-'],expirationDateTime:expiry()});
    });
    const restarted=await fixture(f.fetchImpl,f.store);
    expect((await restarted.post('/session',{handle},'bob')).status).toBe(404);
    expect((await restarted.post('/session',{handle})).body).toMatchObject({uploadUrl,nextExpectedRanges:['4-']});
    expect((await restarted.post('/complete',{handle})).status).toBe(409);
  });
  it('recovers a lost create final-chunk response only when the session is gone and the new item matches',async()=>{
    const f=await fixture(); const {handle}=(await f.post('',input)).body;
    f.fetchImpl.mockImplementation(async(url)=>url===uploadUrl ? new Response(null,{status:404}) : Response.json(item));
    const restarted=await fixture(f.fetchImpl,f.store);
    expect((await restarted.post('/complete',{handle})).body).toEqual({id:'new',size:12,eTag:'"new"'});
    expect((await restarted.post('/complete',{handle})).status).toBe(200);
  });
  it('defers updates and commits using the original If-Match, never accepting the old same-size item',async()=>{
    const f=await fixture();
    const normal=f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async(url,init)=>url.endsWith('/items/old') ? Response.json({...item,id:'old',eTag:'"original"'}) : normal(url,init));
    const created=await f.post('',{...input,itemId:'old',etag:'"original"'});
    expect(created.status).toBe(200);
    const call=f.fetchImpl.mock.calls.find(([url])=>url.endsWith('/createUploadSession'))!;
    expect(JSON.parse(call[1]!.body as string).deferCommit).toBe(true);
    const {handle}=created.body;
    f.fetchImpl.mockImplementation(async(url,init)=>{
      if(url===uploadUrl) return Response.json({nextExpectedRanges:[],expirationDateTime:expiry()});
      expect(init?.method).toBe('PUT');
      expect(new Headers(init?.headers).get('if-match')).toBe('"original"');
      expect(JSON.parse(init!.body as string)).toEqual({name:input.name,'@microsoft.graph.sourceUrl':uploadUrl,'@microsoft.graph.conflictBehavior':'replace'});
      return new Response(null,{status:412});
    });
    expect((await f.post('/complete',{handle})).status).toBe(409);
    f.fetchImpl.mockImplementation(async(url)=>url===uploadUrl ? new Response(null,{status:404}) : Response.json({...item,id:'old',eTag:'"original"'}));
    expect((await f.post('/complete',{handle})).status).toBe(409);
  });
  it('reads back the exact committed update and rejects an intervening change before confirming',async()=>{
    const f=await fixture(); const normal=f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async(url,init)=>url.endsWith('/items/old') ? Response.json({...item,id:'old',eTag:'"original"'}) : normal(url,init));
    const {handle}=(await f.post('',{...input,itemId:'old',etag:'"original"'})).body;
    f.fetchImpl.mockImplementation(async(url,init)=>{
      if(url===uploadUrl) return Response.json({nextExpectedRanges:['12-'],expirationDateTime:expiry()});
      if(init?.method==='PUT') return Response.json({...item,id:'old'});
      return Response.json({...item,id:'old',eTag:'"another-writer"'});
    });
    expect((await f.post('/complete',{handle})).status).toBe(409);
    f.fetchImpl.mockImplementation(async(url)=>url===uploadUrl ? Response.json({nextExpectedRanges:['12-'],expirationDateTime:expiry()}) : Response.json({...item,id:'old'}));
    expect((await f.post('/complete',{handle})).body).toEqual({id:'old',size:12,eTag:'"new"'});
  });
  it.each(['name','parent','drive','size','old'])('rejects mismatched recovered create metadata: %s',async(field)=>{
    const f=await fixture(); const {handle}=(await f.post('',input)).body;
    const wrong={...item,...(field==='name'?{name:'transkript.md'}:field==='parent'?{parentReference:{id:'other',driveId:'drive'}}:field==='drive'?{parentReference:{id:'parent',driveId:'other'}}:field==='size'?{size:11}:{createdDateTime:'2020-01-01T00:00:00Z'})};
    f.fetchImpl.mockImplementation(async(url)=>url===uploadUrl ? new Response(null,{status:404}) : Response.json(wrong));
    expect((await f.post('/complete',{handle})).status).toBe(409);
  });
  it.each(['../audio.webm','https://evil/audio.mp3','foo.exe','bericht_daten.json/evil','audio..mp3'])('rejects unsafe name %s without provider calls',async(name)=>{
    const f=await fixture(); expect((await f.post('',{...input,name})).status).toBe(400); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('preserves provider throttling and hides raw URL errors',async()=>{
    const f=await fixture(); const {handle}=(await f.post('',input)).body;
    f.fetchImpl.mockResolvedValue(new Response(uploadUrl,{status:429,headers:{'Retry-After':'23'}}));
    const throttled=await f.post('/session',{handle}); expect(throttled.status).toBe(429); expect(throttled.headers.get('retry-after')).toBe('23'); expect(JSON.stringify(throttled.body)).not.toContain(uploadUrl);
    f.fetchImpl.mockRejectedValue(Error(uploadUrl));
    const failed=await f.post('/session',{handle}); expect(failed.status).toBe(503); expect(JSON.stringify(failed.body)).not.toContain(uploadUrl);
  });
  it('reports expired and unknown sessions without leaking capabilities',async()=>{
    const f=await fixture(); const {handle}=(await f.post('',input)).body;
    f.fetchImpl.mockResolvedValue(Response.json({nextExpectedRanges:['0-'],expirationDateTime:'2020-01-01T00:00:00Z'}));
    expect((await f.post('/session',{handle})).status).toBe(410);
    expect((await f.post('/complete',{handle:'a'.repeat(43)})).status).toBe(404);
  });
  it('rejects a signed upload host outside Microsoft',async()=>{
    const f=await fixture(); const normal=f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async(url,init)=>url.endsWith('/createUploadSession') ? Response.json({uploadUrl:'https://evil.example/upload',expirationDateTime:expiry()}) : normal(url,init));
    const result=await f.post('',input); expect(result.status).toBe(502); expect(JSON.stringify(result.body)).not.toContain('evil');
  });
  it('rejects unowned drives, remote parents, and preexisting files',async()=>{
    for (const kind of ['drive','parent','existing']) {
      const f=await fixture(); const normal=f.fetchImpl.getMockImplementation()!;
      f.fetchImpl.mockImplementation(async(url,init)=>{
        if(kind==='drive' && url.endsWith('/me/drive')) return Response.json({id:'foreign'});
        if(kind==='parent' && url.endsWith('/items/parent')) return Response.json({id:'parent',folder:{},remoteItem:{},parentReference:{driveId:'drive'}});
        if(kind==='existing' && url.includes(':/bericht_daten.json') && !url.endsWith('/createUploadSession')) return Response.json(item);
        return normal(url,init);
      });
      expect((await f.post('',input)).status).toBe(kind==='existing'?409:403);
      expect(f.fetchImpl.mock.calls.some(([url])=>url.endsWith('/createUploadSession'))).toBe(false);
    }
  });
  it('rejects impossible provider ranges before permitting a deferred commit',async()=>{
    const f=await fixture(); const normal=f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async(url,init)=>url.endsWith('/items/old') ? Response.json({...item,id:'old',eTag:'"original"'}) : normal(url,init));
    const {handle}=(await f.post('',{...input,itemId:'old',etag:'"original"'})).body;
    f.fetchImpl.mockResolvedValue(Response.json({nextExpectedRanges:['99999999999999999999999999-'],expirationDateTime:expiry()}));
    expect((await f.post('/complete',{handle})).status).toBe(502);
    expect(f.fetchImpl.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
  });
  it('never exposes a signed capability disguised as an optional webUrl',async()=>{
    const f=await fixture(); const {handle}=(await f.post('',input)).body;
    f.fetchImpl.mockImplementation(async(url)=>url===uploadUrl ? new Response(null,{status:404}) : Response.json({...item,webUrl:uploadUrl}));
    const result=await f.post('/complete',{handle}); expect(result.status).toBe(200); expect(result.body.webUrl).toBeUndefined();
  });
  it('a late status response cannot erase a concurrently persisted completion',async()=>{
    const memory=memoryDocStore<UploadDocument>();
    const store={...memory,get:async(id:string)=>structuredClone(await memory.get(id))};
    const f=await fixture(provider(),store); const {handle}=(await f.post('',input)).body;
    let enter!:()=>void, release!:(response:Response)=>void;
    const entered=new Promise<void>(r=>{enter=r;});
    const delayed=new Promise<Response>(r=>{release=r;});
    let requests=0;
    f.fetchImpl.mockImplementation(async(url)=>{
      if(url===uploadUrl && requests++===0) {enter(); return delayed;}
      return url===uploadUrl ? new Response(null,{status:404}) : Response.json(item);
    });
    const pending=f.post('/session',{handle}); await entered;
    expect((await f.post('/complete',{handle})).status).toBe(200);
    release(Response.json({nextExpectedRanges:['4-'],expirationDateTime:expiry()})); await pending;
    expect((await store.get(handle))?.result).toEqual({id:'new',size:12,eTag:'"new"'});
  });
  it('creates an opaque durable handle using a route-owned parser and fail-on-conflict',async()=>{
    const {post,fetchImpl,store}=await fixture();
    const result=await post('',input);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({handle:expect.stringMatching(/^[\w-]{43}$/)});
    const saved=await store.get(result.body.handle);
    expect(saved).toMatchObject({owner:'alice',uploadUrl,...input});
    const call=fetchImpl.mock.calls.find(([url])=>url.endsWith('/createUploadSession'))!;
    expect(JSON.parse(call[1]!.body as string).item['@microsoft.graph.conflictBehavior']).toBe('fail');
    expect(call[1]?.redirect).toBe('error');
  });
});
