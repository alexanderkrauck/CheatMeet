import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import config from '../../firebase-applet-config.json';
import { firestoreStore, serviceAccountToken, type RefreshTokenStore } from '../tokenStore';
import { refreshAccessToken } from '../googleAuth';
import { fromArchive, toArchive } from '../../src/lib/archive';
import { reportToMarkdown, transcriptToMarkdown } from '../../src/lib/markdown';
import { projectReport } from '../../src/lib/reportProjection';
import { formatTodoLine } from '../../shared/analysis';
import type { ReportData } from '../../src/types';
import { ProcessingError, type ProcessingIO, type ProcessingJob } from './index';
import { boundedFetch } from './budget';

const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,sorted(x)])):v;
const hash=(v:unknown)=>createHash('sha256').update((JSON.stringify(sorted(v))??'undefined')).digest('hex');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(v);
const clean=(v:unknown)=>JSON.parse(JSON.stringify(v));
// Firestore REST values, not a second report store. Index keeps the existing projection shape.
function encode(v:any):any {
  if(v===null)return {nullValue:null};
  if(typeof v==='string')return {stringValue:v};
  if(typeof v==='boolean')return {booleanValue:v};
  if(typeof v==='number')return Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v};
  if(Array.isArray(v))return {arrayValue:{values:v.map(encode)}};
  return {mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)]))}};
}
function decode(v:any):any {
  if('stringValue'in v)return v.stringValue;if('booleanValue'in v)return v.booleanValue;
  if('integerValue'in v)return Number(v.integerValue);if('doubleValue'in v)return v.doubleValue;
  if('timestampValue'in v)return v.timestampValue;if('nullValue'in v)return null;
  if(v.arrayValue)return (v.arrayValue.values||[]).map(decode);
  return Object.fromEntries(Object.entries(v.mapValue?.fields||{}).map(([k,x])=>[k,decode(x)]));
}
/** Matching the browser's bounded CheatMeet block; never replace organiser text. */
export function mergeCalendarDescription(existing:string,block:string) {
  const fresh=`--- CheatMeet ---\n${block}\n--- Ende CheatMeet ---`;
  const BR='(?:<br\\s*/?>|\\r?\\n|^|$)';
  const opener=new RegExp(`(?<=${BR})[ \\t]*--- CheatMeet ---[ \\t]*(?=${BR})`,'g');
  const closer=new RegExp(`[ \\t]*--- Ende CheatMeet ---[ \\t]*(?=${BR})`);
  let region:{start:number;end:number}|undefined;
  for(const match of existing.matchAll(opener)){
    const from=match.index!;const close=closer.exec(existing.slice(from+match[0].length));
    if(close)region={start:from,end:from+match[0].length+close.index+close[0].length};
  }
  if(!region){const kept=existing.replace(/(?:\s|<br\s*\/?>)+$/i,'');return `${kept?kept+'\n\n':''}${fresh}`;}
  const before=existing.slice(0,region.start).replace(/(?:\s|<br\s*\/?>)+$/i,'');
  const after=existing.slice(region.end).replace(/^(?:\s|<br\s*\/?>)+/i,'');
  return [before,fresh,after].filter(Boolean).join('\n\n');
}
export function createDriveIO(options:{fetchImpl?:typeof fetch;grants?:RefreshTokenStore;runtimeToken?:()=>Promise<string>}={}) : ProcessingIO & {audio:(j:ProcessingJob,r:ReportData)=>Promise<Readable>} {
  const f=options.fetchImpl||boundedFetch;const grants=options.grants||firestoreStore({fetchImpl:f});
  const runtimeToken=options.runtimeToken||(()=>serviceAccountToken(f));
  const project=process.env.FIREBASE_PROJECT_ID||config.projectId;
  const fs=`https://firestore.googleapis.com/v1/projects/${project}/databases/${encodeURIComponent(config.firestoreDatabaseId||'(default)')}/documents`;
  async function access(j:Pick<ProcessingJob,'googleSub'>){
    const refreshToken=await grants.get(j.googleSub);
    if(!refreshToken)throw new ProcessingError(401,'Bitte Google erneut verbinden.',true);
    try {
      const value=await refreshAccessToken({refreshToken,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID||config.oAuthClientId||'',clientSecret:process.env.GOOGLE_OAUTH_CLIENT_SECRET||''},f);
      return value.accessToken;
    }catch(e){
      // Revocation is an explicit pause; network errors are retried, never delete the grant.
      if(/invalid_grant|widerrufen|erneut verbinden/i.test(String(e)))throw new ProcessingError(401,'Bitte Google erneut verbinden.',true);
      throw e;
    }
  }
  async function call(token:string,url:string,init:RequestInit={},timeout=10000){
    const res=await f(url,{...init,headers:{...init.headers,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(timeout)});
    if(!res.ok)throw new ProcessingError(res.status,res.status===401?'Bitte Google erneut verbinden.':res.status===404?'Gesicherte Datei nicht gefunden.':res.status===412?'Der Bericht wurde inzwischen geändert.':'Google-Dienst derzeit nicht verfügbar.',[401,403,409,412].includes(res.status));
    return res;
  }
  const drive='https://www.googleapis.com/drive/v3/files';
  async function metadata(token:string,file:string,folder?:string){
    if(!id(file))throw new ProcessingError(400,'Ungültige Drive-Dateireferenz.');
    const res=await call(token,`${drive}/${file}?fields=id,name,mimeType,parents,ownedByMe,trashed,version`);
    const data=await res.json();
    if(data.trashed||data.ownedByMe!==true||folder&&!data.parents?.includes(folder))throw new ProcessingError(403,'Die Drive-Datei gehört nicht zum Meeting oder Konto.',true);
    return {data,etag:res.headers.get('etag')};
  }
  async function index(j:Pick<ProcessingJob,'owner'|'refs'>){
    const res=await f(`${fs}/users/${encodeURIComponent(j.owner)}/reports/${j.refs.id}`,{headers:{Authorization:`Bearer ${await runtimeToken()}`},signal:AbortSignal.timeout(10000)});
    if(res.status===404)return {revision:'',report:null};
    if(!res.ok)throw new ProcessingError(res.status,'Berichtsindex derzeit nicht verfügbar.');
    const doc=await res.json();return {revision:String(doc.updateTime||''),report:decode({mapValue:{fields:doc.fields}}) as ReportData};
  }
  async function archive(response:Response,refs:ProcessingJob['refs']){
    let raw:any;
    try{raw=await response.json();}
    catch(e){if(!(e instanceof SyntaxError))throw e;throw new ProcessingError(422,'Die gespeicherten Berichtsdaten sind ungültig. Bitte das Drive-Archiv prüfen.');}
    try{return {raw,report:fromArchive(raw,refs)};}
    catch{throw new ProcessingError(422,'Die gespeicherten Berichtsdaten sind ungültig. Bitte das Drive-Archiv prüfen.');}
  }
  async function source(j:Pick<ProcessingJob,'owner'|'googleSub'|'refs'>,token:string){
    const folder=await metadata(token,j.refs.driveFolderId);
    if(folder.data.mimeType!=='application/vnd.google-apps.folder')throw new ProcessingError(400,'Meeting-Ordner fehlt.');
    const sourceMeta=await metadata(token,j.refs.driveReportId,j.refs.driveFolderId);
    const response=await call(token,`${drive}/${j.refs.driveReportId}?alt=media`,{},10000);
    const {raw,report}=await archive(response,j.refs);
    // Drive v3 can omit ETag headers entirely. v2 still exposes the resource
    // tag explicitly and supports conditional media PUT. Match its version to
    // the v3 metadata read before media so the tag describes the bytes we read.
    let etag=response.headers.get('etag');let legacyEtag=false;
    if(!etag){
      const revision=await (await call(token,`https://www.googleapis.com/drive/v2/files/${j.refs.driveReportId}?fields=etag,version`)).json();
      if(typeof revision.etag!=='string'||!revision.etag||!sourceMeta.data.version||String(revision.version)!==String(sourceMeta.data.version))
        throw new ProcessingError(409,'Die Drive-Quelldatei wurde während des Lesens geändert.',true);
      etag=revision.etag;legacyEtag=true;
    }
    if(report.id!==j.refs.id)throw new ProcessingError(400,'Meeting-ID stimmt nicht mit dem Archiv überein.');
    // Audio can legitimately be gone after its consent retention deadline. Check
    // ancillary file membership when that file is actually read/written, not on text recovery.
    const current=await index(j);
    if(current.report&&['driveFolderId','driveReportId'].some(k=>(current.report as any)[k]&&(current.report as any)[k]!== (j.refs as any)[k]))throw new ProcessingError(409,'Die Berichtsreferenzen wurden inzwischen geändert.',true);
    if(current.report && (Date.parse(current.report.updatedAt||'')||0)>(Date.parse(report.updatedAt||'')||0) && ['title','summary','todos','takeaways','calendarEventId','calendarId'].some(k=>(current.report as any)[k]!==undefined && hash((current.report as any)[k])!==hash((report as any)[k])))throw new ProcessingError(409,'Neuere Änderungen sind noch nicht im Drive-Archiv gesichert. Bitte den Bericht zuerst synchronisieren.',true);
    return {report,revision:hash(raw),indexRevision:current.revision,etag,legacyEtag};
  }
  async function find(token:string,folder:string,name:string){
    const params=new URLSearchParams({q:`'${folder}' in parents and name = '${name.replace(/'/g,"\\'")}' and trashed = false`,fields:'files(id,ownedByMe)',pageSize:'2'});
    const data=await (await call(token,`${drive}?${params}`)).json();
    if(data.files?.length>1)throw new ProcessingError(409,'Mehrere gleichnamige Drive-Dateien gefunden. Bitte prüfen.',true);
    return data.files?.[0]?.id as string|undefined;
  }
  async function upsert(token:string,j:Pick<ProcessingJob,'refs'>,name:string,type:string,text:string,known?:string){
    const file=known||await find(token,j.refs.driveFolderId,name);
    if(file){
      const m=await metadata(token,file,j.refs.driveFolderId);
      await call(token,`https://www.googleapis.com/upload/drive/v3/files/${file}?uploadType=media`,{method:'PATCH',headers:{'Content-Type':type,...(m.etag?{'If-Match':m.etag}:{})},body:text});
      return file;
    }
    const boundary='cheatmeet_processing_boundary';
    const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,parents:[j.refs.driveFolderId],mimeType:type})}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n${text}\r\n--${boundary}--`;
    const out=await (await call(token,'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body})).json();
    if(!id(out.id))throw new ProcessingError(502,'Drive hat den Upload nicht bestätigt.');return out.id;
  }
  const checkpointName=(j:ProcessingJob,name:string)=>`.cheatmeet-processing-${j.run}-${name}.json`;
  async function read(token:string,j:ProcessingJob,name:string){
    const file=await find(token,j.refs.driveFolderId,checkpointName(j,name));if(!file)return null;
    await metadata(token,file,j.refs.driveFolderId);
    const {raw,report}=await archive(await call(token,`${drive}/${file}?alt=media`),j.refs);
    if(report.id!==j.refs.id)throw new ProcessingError(400,'Meeting-ID stimmt nicht mit dem Checkpoint überein.');
    if(typeof raw._processing?.calendarError==='string')report.calendarError=raw._processing.calendarError.slice(0,2000);
    return report;
  }
  async function checkpoint(token:string,j:ProcessingJob,name:string,r:ReportData){
    await upsert(token,j,checkpointName(j,name),'application/json',JSON.stringify({...toArchive(r,r.updatedAt||j.updatedAt),...(r.calendarError?{_processing:{calendarError:r.calendarError}}:{})}));
  }
  async function calendar(token:string,r:ReportData):Promise<ReportData>{
    if(!r.calendarEventId||!r.calendarId)return r;
    try{
      const url=`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(r.calendarId||'primary')}/events/${encodeURIComponent(r.calendarEventId)}`;
      const event=await (await call(token,url)).json();
      const lines=[r.summary.trim()].filter(Boolean);
      if(r.todos.length)lines.push('','Aufgaben:',...r.todos.map(t=>`• ${formatTodoLine(t)}`));
      if(r.driveFolderId)lines.push('',`Bericht & Aufnahme: https://drive.google.com/drive/folders/${r.driveFolderId}`);
      await call(token,url,{method:'PATCH',headers:{'Content-Type':'application/json',...(event.etag?{'If-Match':event.etag}:{})},body:JSON.stringify({description:mergeCalendarDescription(event.description||'',lines.join('\n'))})});
      return {...r,calendarSyncedAt:new Date().toISOString(),calendarLink:typeof event.htmlLink==='string'?event.htmlLink:r.calendarLink,calendarError:''};
    }catch(e){
      if(e instanceof ProcessingError&&[404,410].includes(e.status))return {...r,calendarEventId:undefined,calendarId:undefined,calendarLink:undefined,calendarSyncedAt:undefined,calendarError:'Der verknüpfte Kalendereintrag existiert nicht mehr. Die Verknüpfung wurde entfernt.'};
      return {...r,calendarError:'Kalendereintrag konnte nicht aktualisiert werden. Der Bericht bleibt gesichert.'};
    }
  }
  return {
    async load(j){return source(j,await access(j));},
    async readCheckpoint(j,name){return read(await access(j),j,name);},
    async checkpoint(j,name,r){await checkpoint(await access(j),j,name,r);},
    async export(j,input){
      const token=await access(j);const current=await source(j,token);const plan=await read(token,j,'export-plan');
      if(current.indexRevision!==j.indexRevision)throw new ProcessingError(409,'Der Bericht wurde inzwischen geändert.',true);
      if(plan&&current.revision===hash(toArchive(plan,plan.updatedAt!)))return plan;
      if(current.revision!==j.revision)throw new ProcessingError(409,'Die Drive-Quelldatei wurde inzwischen geändert.',true);
      let r:ReportData={...input,updatedAt:plan?.updatedAt||new Date().toISOString(),driveSyncedAt:plan?.driveSyncedAt||new Date().toISOString()};
      if(j.calendarSync&&j.analyze&&r.summary.trim())r=await calendar(token,r);
      if(r.transcription.trim())r.driveTranscriptId=await upsert(token,j,'transkript.md','text/markdown',transcriptToMarkdown(r),r.driveTranscriptId);
      if(r.summary.trim())r.driveMarkdownId=await upsert(token,j,'zusammenfassung.md','text/markdown',reportToMarkdown(r),r.driveMarkdownId);
      await checkpoint(token,j,'export-plan',r);
      // Guard immediately before the authoritative JSON write; If-Match closes the read/write race.
      const latest=await source(j,token);
      if(latest.revision!==j.revision||latest.indexRevision!==j.indexRevision)throw new ProcessingError(409,'Der Bericht wurde inzwischen geändert.',true);
      if(!latest.etag)throw new ProcessingError(503,'Drive-Revisionsprüfung fehlt; Export wurde nicht überschrieben.');
      await call(token,`https://www.googleapis.com/upload/drive/${latest.legacyEtag?'v2':'v3'}/files/${j.refs.driveReportId}?uploadType=media`,{method:latest.legacyEtag?'PUT':'PATCH',headers:{'Content-Type':'application/json','If-Match':latest.etag},body:JSON.stringify(toArchive(r,r.updatedAt!))});
      return r;
    },
    async publish(j,r){
      const current=await index(j);const value=clean(projectReport(r));
      if(current.revision!==j.indexRevision){
        if(current.report&&hash(clean(current.report))===hash(value))return;
        throw new ProcessingError(409,'Der Berichtsindex wurde inzwischen geändert.',true);
      }
      const precondition=j.indexRevision?`currentDocument.updateTime=${encodeURIComponent(j.indexRevision)}`:'currentDocument.exists=false';
      await call(await runtimeToken(),`${fs}/users/${encodeURIComponent(j.owner)}/reports/${j.refs.id}?${precondition}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:encode(value).mapValue.fields})});
    },
    async audio(j,r){
      if(!id(r.rawAudioUrl))throw new ProcessingError(422,'Gesicherte Audioaufnahme fehlt.');
      const token=await access(j);await metadata(token,r.rawAudioUrl,j.refs.driveFolderId);
      const res=await call(token,`${drive}/${r.rawAudioUrl}?alt=media`,{},60000);
      if(!res.body)throw new ProcessingError(502,'Drive-Audio konnte nicht gelesen werden.');
      return Readable.fromWeb(res.body as any);
    },
  };
}
