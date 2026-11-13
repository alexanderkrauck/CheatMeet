import { expect, it, vi } from 'vitest';
import { firestoreReportIndex, microsoftTranscriptReader, type IndexEntry } from '../server/mcp/meetings';

const home={provider:'microsoft' as const,connectionId:'conn',driveId:'drive',rootId:'root',rootName:'Meetings',folderId:'folder',transcriptId:'transcript'};
const meeting:IndexEntry={id:'ms',date:'2026-11-13T10:00:00Z',title:'MS',summary:'',todos:[],takeaways:[],participants:[],home};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
it('lists both owner-scoped indexes without copying OneDrive records into the legacy collection',async()=>{
  const f=vi.fn(async(url:any)=>json({documents:[{fields:{id:{stringValue:String(url).includes('/meetings?')?'ms':'google'},title:{stringValue:'Meeting'},home:String(url).includes('/meetings?')?{mapValue:{fields:Object.fromEntries(Object.entries(home).map(([k,v])=>[k,{stringValue:v}]))}}:undefined}}]})) as unknown as typeof fetch;
  const index=firestoreReportIndex({projectId:'p',databaseId:'named',fetchImpl:f,token:async()=> 'runtime'});
  const rows=await index.list('alice');
  expect(rows.map(r=>r.id)).toEqual(['google','ms']);
  expect(rows[1].home).toEqual(home);
  expect((f as any).mock.calls.every(([url]:any)=>String(url).includes('/users/alice/'))).toBe(true);
});
it('reads only an indexed transcript in the connected account and never forwards its bearer across redirects',async()=>{
  const f=vi.fn(async(url:any,init:RequestInit={})=>{
    const s=String(url);
    if(s.endsWith('/me/drive'))return json({id:'drive'});
    if(s.endsWith('/items/transcript'))return json({id:'transcript',parentReference:{driveId:'drive',id:'folder'},size:12});
    if(s.endsWith('/content'))return new Response(null,{status:302,headers:{location:'https://tenant.sharepoint.com/download?temporary=capability'}});
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    return new Response('saved transcript');
  }) as unknown as typeof fetch;
  const access=vi.fn(async()=> 'private-token');
  const reader=microsoftTranscriptReader({access,fetchImpl:f});
  expect(await reader('alice',meeting)).toBe('saved transcript');
  expect(access).toHaveBeenCalledWith('alice','conn');
});
it('rejects a foreign drive or artifact before reading its bytes',async()=>{
  const f=vi.fn(async()=>json({id:'other-drive'})) as unknown as typeof fetch;
  await expect(microsoftTranscriptReader({access:async()=> 'token',fetchImpl:f})('alice',meeting)).rejects.toMatchObject({reason:'not_found'});
  expect(f).toHaveBeenCalledTimes(1);
});
