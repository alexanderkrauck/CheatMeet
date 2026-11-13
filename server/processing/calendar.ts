import type {ReportData} from '../../src/types';
import type {ProcessingJob} from './index';
import {mergeMicrosoftBody} from '../../shared/microsoftCalendar';
import {archiveFolderLink} from '../../shared/storage';
import {formatTodoLine} from '../../shared/analysis';
import {getMicrosoftAccess} from '../microsoftAuth';
import {fileGrantStore,firestoreStore} from '../tokenStore';
import {refreshAccessToken} from '../googleAuth';
import config from '../../firebase-applet-config.json';
import {mergeCalendarDescription} from './drive';
import {boundedFetch} from './budget';
interface Options {
  fetchImpl?:typeof fetch;
  microsoftAccess?:(owner:string,connectionId:string)=>Promise<string>;
  googleAccess?:(googleSub:string)=>Promise<string>;
}
/** Calendar provider belongs to the event, not the archive or current user default. */
export async function syncWorkerCalendar(j:ProcessingJob,r:ReportData,options:Options={}):Promise<ReportData> {
  if(!r.calendarEventId||!r.calendarId)return r;
  const f=options.fetchImpl||boundedFetch;
  try {
    const microsoft=r.calendarProvider==='microsoft';
    let token:string;
    if(microsoft){
      if(!r.calendarConnectionId)throw Error('Missing pinned calendar connection');
      token=await (options.microsoftAccess|| (async(owner,connectionId)=>(await getMicrosoftAccess(owner,connectionId)).accessToken))(j.owner,r.calendarConnectionId);
    }else{
      if(!j.googleSub)throw Error('Missing Google identity');
      const access=options.googleAccess|| (async(sub:string)=>{
        const store=process.env.NODE_ENV==='production'?firestoreStore({fetchImpl:f}):fileGrantStore();
        const refreshToken=await store.get(sub);if(!refreshToken)throw Error('Missing Google grant');
        return (await refreshAccessToken({refreshToken,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID||config.oAuthClientId||'',clientSecret:process.env.GOOGLE_OAUTH_CLIENT_SECRET||''},f)).accessToken;
      });
      token=await access(j.googleSub);
    }
    const url=microsoft?`https://graph.microsoft.com/v1.0/me/${r.calendarId==='primary'?'':`calendars/${encodeURIComponent(r.calendarId)}/`}events/${encodeURIComponent(r.calendarEventId)}`
      :`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(r.calendarId)}/events/${encodeURIComponent(r.calendarEventId)}`;
    const call=async(init:RequestInit={})=>{
      const res=await f(url,{...init,headers:{...init.headers,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(microsoft?{Prefer:'IdType="ImmutableId"'}:{})},redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!res.ok)throw Object.assign(Error('Calendar operation failed'),{status:res.status});return res;
    };
    const current=await call();const event=await current.json();
    const etag=microsoft?event['@odata.etag']||current.headers.get('etag'):event.etag;
    if(typeof etag!=='string'||!etag)throw Error('Missing calendar revision');
    const lines=[r.summary.trim()].filter(Boolean);
    if(r.todos.length)lines.push('','Aufgaben:',...r.todos.map(t=>`• ${formatTodoLine(t)}`));
    const link=archiveFolderLink(r);if(link)lines.push('',`Bericht & Aufnahme: ${link}`);
    const block=lines.join('\n');
    const contentType=event.body?.contentType?.toLowerCase()==='html'?'html':'text';
    const body=microsoft?{body:{contentType,content:mergeMicrosoftBody(event.body?.content||'',block,contentType)}}
      :{description:mergeCalendarDescription(event.description||'',block)};
    await call({method:'PATCH',headers:{'If-Match':etag},body:JSON.stringify(body)});
    return {...r,calendarSyncedAt:new Date().toISOString(),calendarLink:(microsoft?event.webLink:event.htmlLink)||r.calendarLink,calendarError:''};
  }catch(e){
    if([404,410].includes((e as any)?.status))return {...r,calendarEventId:undefined,calendarId:undefined,calendarProvider:undefined,calendarConnectionId:undefined,calendarLink:undefined,calendarSyncedAt:undefined,calendarError:'Der verknüpfte Kalendereintrag existiert nicht mehr. Die Verknüpfung wurde entfernt.'};
    return {...r,calendarError:'Kalendereintrag konnte nicht aktualisiert werden. Der Bericht bleibt im gewählten Meeting-Archiv gesichert.'};
  }
}
