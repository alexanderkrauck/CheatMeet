import {expect,it,vi} from 'vitest';
import {syncWorkerCalendar} from '../server/processing/calendar';
import type {ReportData} from '../src/types';
import type {ProcessingJob} from '../server/processing';
const report:ReportData={id:'meeting',title:'Meeting',date:'2026-11-13T09:00:00Z',summary:'Summary <safe>',transcription:'Text',todos:[],takeaways:[],calendarProvider:'microsoft',calendarConnectionId:'calendar-account',calendarId:'primary',calendarEventId:'event',driveFolderId:'google-home'};
it('writes a Microsoft calendar independently of a Google archive, conditionally preserving Teams HTML',async()=>{
  const html='<html><body>Organizer <div id="teams">join link</div></body></html>';
  const f=vi.fn(async(_url:any,init:RequestInit={})=>new Response(JSON.stringify(init.method==='PATCH'?{}:{body:{contentType:'html',content:html},'@odata.etag':'event-v1',webLink:'https://outlook.office.com/event'}),{headers:{'content-type':'application/json'}})) as unknown as typeof fetch;
  const microsoft=vi.fn(async()=> 'ms-access');const google=vi.fn(async()=> 'google-access');
  const result=await syncWorkerCalendar({owner:'alice',googleSub:'google-alice'} as ProcessingJob,report,{fetchImpl:f,microsoftAccess:microsoft,googleAccess:google});
  expect(microsoft).toHaveBeenCalledWith('alice','calendar-account');expect(google).not.toHaveBeenCalled();
  const patch=(f as any).mock.calls.find(([,init]:any)=>init.method==='PATCH');
  expect(patch[0]).toBe('https://graph.microsoft.com/v1.0/me/events/event');
  expect(new Headers(patch[1].headers).get('If-Match')).toBe('event-v1');
  const body=JSON.parse(patch[1].body).body;
  expect(body.content).toContain('<div id="teams">join link</div>');
  expect(body.content).toContain('Summary &lt;safe&gt;');
  expect(body.content).toContain('https://drive.google.com/drive/folders/google-home');
  expect(result.calendarSyncedAt).toBeTruthy();
});
it('treats missing calendar permission as a warning and never changes archive identity',async()=>{
  const result=await syncWorkerCalendar({owner:'alice',googleSub:''} as ProcessingJob,report,{microsoftAccess:async()=>{throw Error('revoked');},fetchImpl:vi.fn() as any});
  expect(result.calendarError).toBeTruthy();expect(result.driveFolderId).toBe('google-home');expect(result.summary).toBe(report.summary);
});
