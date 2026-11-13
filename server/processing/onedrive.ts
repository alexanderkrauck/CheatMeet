import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import config from '../../firebase-applet-config.json';
import { serviceAccountToken } from '../tokenStore';
import { fromArchive, toArchive } from '../../src/lib/archive';
import { reportToMarkdown, transcriptToMarkdown } from '../../src/lib/markdown';
import { projectReport } from '../../src/lib/reportProjection';
import { microsoftHome, type MicrosoftHome } from '../../shared/storage';
import type { ReportData } from '../../src/types';
import { ProcessingError, type ProcessingIO, type ProcessingJob } from './index';
import { boundedFetch } from './budget';

const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,sorted(x)])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(sorted(v))??'undefined').digest('hex');
const clean=(v:any)=>JSON.parse(JSON.stringify(v));
const conflict=()=>new ProcessingError(409,'Der Bericht wurde inzwischen geändert.',true);
const artifacts=['audioId','markdownId','transcriptId','consentId'] as const;
const legacy=['rawAudioUrl','driveFolderId','driveReportId','driveMarkdownId','driveTranscriptId','driveConsentId','driveSyncedAt'] as const;
type SourceJob=Pick<ProcessingJob,'owner'|'googleSub'|'refs'>;
function homeFor(j:SourceJob):MicrosoftHome {
  try {
    const h=microsoftHome((j.refs as ProcessingJob['refs'] & {home?:MicrosoftHome}).home);
    if(!h.folderId||!h.reportId||h.folderId===h.rootId||h.reportId===h.folderId||!j.owner||!/^[a-zA-Z0-9_-]{1,200}$/.test(j.refs.id))throw Error();
    return h;
  }catch{throw new ProcessingError(400,'Gesicherte OneDrive-Berichtsreferenzen fehlen.');}
}
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

/** Durable artifacts live only in the pinned owner's own OneDrive; Firestore is an index. */
export function createOneDriveIO(options:{fetchImpl?:typeof fetch;access?:(owner:string,connectionId:string)=>Promise<string>;runtimeToken?:()=>Promise<string>;calendar?:(j:ProcessingJob,r:ReportData)=>Promise<ReportData>}={}):ProcessingIO & {audio(j:ProcessingJob,r:ReportData):Promise<Readable>} {
  const f=options.fetchImpl||boundedFetch;
  const access=options.access|| (async(owner:string,connectionId:string)=>{
    const {getMicrosoftAccess}=await import('../microsoftAuth');
    return (await getMicrosoftAccess(owner,connectionId)).accessToken;
  });
  const runtimeToken=options.runtimeToken||(()=>serviceAccountToken(f));
  const fs=`https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID||config.projectId}/databases/${encodeURIComponent(config.firestoreDatabaseId||'(default)')}/documents`;
  const graph='https://graph.microsoft.com/v1.0';
  function check(res:Response) {
    if(!res.ok)throw new ProcessingError(res.status,res.status===401?'Bitte Microsoft erneut verbinden.':res.status===404?'Gesicherte OneDrive-Datei nicht gefunden.':[409,412].includes(res.status)?'Der Bericht wurde inzwischen geändert.':'Speicherdienst derzeit nicht verfügbar.',[401,403,409,412].includes(res.status));
    return res;
  }
  async function call(token:string,path:string,init:RequestInit={}) {
    // No caller-supplied origin or pagination URL can receive the bearer.
    if(!path.startsWith('/')||path.startsWith('//'))throw new ProcessingError(400,'Ungültiger Microsoft-Pfad.');
    return check(await f(`${graph}${path}`,{...init,headers:{...init.headers,Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(10000)}));
  }
  const itemPath=(h:MicrosoftHome,id:string)=>`/drives/${encodeURIComponent(h.driveId)}/items/${encodeURIComponent(id)}`;
  async function context(j:SourceJob) {
    const h=homeFor(j);const token=await access(j.owner,h.connectionId);
    const own=await (await call(token,'/me/drive')).json();
    if(own.id!==h.driveId)throw new ProcessingError(403,'Der Speicherort gehört nicht zum eigenen OneDrive.',true);
    const root=await metadata(token,h,h.rootId);const folder=await metadata(token,h,h.folderId!,h.rootId);
    if(!root.folder||!folder.folder)throw new ProcessingError(400,'OneDrive-Meeting-Ordner fehlt.');
    return {h,token};
  }
  async function metadata(token:string,h:MicrosoftHome,id:string,parent?:string) {
    const m=await (await call(token,itemPath(h,id))).json();
    if(m.id!==id||m.deleted||m.remoteItem||m.parentReference?.driveId!==h.driveId||parent&&m.parentReference?.id!==parent)throw new ProcessingError(403,'Die OneDrive-Datei gehört nicht zum Meeting oder Konto.',true);
    if(typeof m.eTag!=='string'||!m.eTag)throw new ProcessingError(503,'OneDrive-Revisionsprüfung fehlt.');
    return m;
  }
  async function content(token:string,h:MicrosoftHome,id:string,etag:string,timeout=10000) {
    let res=await f(`${graph}${itemPath(h,id)}/content`,{headers:{Authorization:`Bearer ${token}`,'If-Match':etag},redirect:'manual',signal:AbortSignal.timeout(timeout)});
    if([301,302,303,307,308].includes(res.status)) {
      let u:URL;
      try {u=new URL(res.headers.get('location')||'');}catch{throw new ProcessingError(502,'Ungültiger OneDrive-Download.');}
      if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!['sharepoint.com','1drv.com','storage.live.com'].some(host=>u.hostname===host||u.hostname.endsWith(`.${host}`)))throw new ProcessingError(502,'Unsicherer OneDrive-Download wurde abgelehnt.');
      // Signed download capability is used once, never persisted, never receives OAuth.
      res=await f(u.href,{redirect:'manual',signal:AbortSignal.timeout(timeout)});
    }
    return check(res);
  }
  async function index(j:SourceJob) {
    const url=`${fs}/users/${encodeURIComponent(j.owner)}/meetings/${encodeURIComponent(j.refs.id)}`;
    const res=await f(url,{headers:{Authorization:`Bearer ${await runtimeToken()}`},redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(res.status===404)return {revision:'',report:null,url};
    check(res);const doc=await res.json();
    if(typeof doc.updateTime!=='string'||!doc.updateTime)throw new ProcessingError(503,'Index-Revisionsprüfung fehlt.');
    return {revision:doc.updateTime,report:decode({mapValue:{fields:doc.fields}}) as ReportData,url};
  }
  async function parse(raw:any,j:SourceJob,token:string,h:MicrosoftHome) {
    let r:ReportData;
    try {r=fromArchive(raw,{home:h});}catch{throw new ProcessingError(422,'Die gespeicherten Berichtsdaten sind ungültig.');}
    if(r.id!==j.refs.id)throw new ProcessingError(400,'Meeting-ID stimmt nicht mit dem Archiv überein.');
    let candidate:MicrosoftHome|undefined;
    if(raw.home!==undefined) {
      try{candidate=microsoftHome(raw.home);}catch{throw new ProcessingError(422,'Ungültiger OneDrive-Speicherort im Archiv.');}
      // The initial upload cannot contain its own newly assigned item ID.
      // Context is independently verified against account, parent folder and raw meeting ID.
      if(['connectionId','driveId','rootId'].some(k=>(candidate as any)[k]!== (h as any)[k])||['folderId','reportId'].some(k=>(candidate as any)[k]!==undefined&&(candidate as any)[k]!== (h as any)[k]))throw conflict();
    }
    const trusted={...h,...(candidate?.syncedAt?{syncedAt:candidate.syncedAt}:{})};
    const seen=new Set([h.rootId,h.folderId,h.reportId]);
    for(const key of artifacts) {
      const id=candidate?.[key]||h[key];
      if(id){
        if(seen.has(id))throw new ProcessingError(403,'OneDrive-Artefakte dürfen keine anderen Archivdateien überschreiben.',true);
        seen.add(id);
        try {
          const m=await metadata(token,h,id,h.folderId);
          if(!m.file)throw new ProcessingError(403,'Ungültige OneDrive-Artefaktreferenz.',true);
          trusted[key]=id;
        }catch(e){
          // Consent retention can legitimately remove audio; text recovery remains usable.
          if(key==='audioId'&&e instanceof ProcessingError&&e.status===404)delete trusted.audioId;
          else throw e;
        }
      }
    }
    for(const key of legacy)delete r[key];
    r.home=trusted;
    // Preserve the calendar binding; the parent worker owns optional calendar sync.
    if(raw.calendarProvider==='google'||raw.calendarProvider==='microsoft')r.calendarProvider=raw.calendarProvider;
    if(typeof raw.calendarConnectionId==='string')r.calendarConnectionId=raw.calendarConnectionId;
    return r;
  }
  async function source(j:SourceJob,token:string,h:MicrosoftHome) {
    const root=await metadata(token,h,h.rootId);const folder=await metadata(token,h,h.folderId!,h.rootId);
    if(!root.folder||!folder.folder)throw new ProcessingError(400,'OneDrive-Meeting-Ordner fehlt.');
    const before=await metadata(token,h,h.reportId!,h.folderId);
    if(!before.file)throw new ProcessingError(400,'OneDrive-Berichtsdatei fehlt.');
    const res=await content(token,h,h.reportId!,before.eTag);let raw:any;
    try {raw=await res.json();}catch(e){if(!(e instanceof SyntaxError))throw e;throw new ProcessingError(422,'Die gespeicherten Berichtsdaten sind ungültig.');}
    const after=await metadata(token,h,h.reportId!,h.folderId);
    if(before.eTag!==after.eTag||res.headers.get('etag')&&res.headers.get('etag')!==before.eTag)throw new ProcessingError(503,'OneDrive-Revisionsprüfung ist vorübergehend inkonsistent.');
    const report=await parse(raw,j,token,h);const current=await index(j);
    if(current.report) {
      const ih=current.report.home;
      if(!ih||['connectionId','driveId','rootId','folderId','reportId'].some(k=>(ih as any)[k]!== (h as any)[k]))throw conflict();
      if((Date.parse(current.report.updatedAt||'')||0)>(Date.parse(report.updatedAt||'')||0)&&['title','summary','todos','takeaways','calendarEventId','calendarId','calendarProvider','calendarConnectionId'].some(k=>(current.report as any)[k]!==undefined&&hash((current.report as any)[k])!==hash((report as any)[k])))throw conflict();
    }
    return {report,revision:hash(raw),indexRevision:current.revision,etag:before.eTag};
  }
  // Address names directly: no unchecked Graph nextLink or ambiguous directory scan.
  const namedPath=(h:MicrosoftHome,name:string)=>`${itemPath(h,h.folderId!)}:/${encodeURIComponent(name)}`;
  async function find(token:string,h:MicrosoftHome,name:string) {
    const res=await f(`${graph}${namedPath(h,name)}`,{headers:{Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(res.status===404)return null;
    check(res);const m=await res.json();
    if(typeof m.id!=='string'||!m.id)throw new ProcessingError(502,'OneDrive-Dateireferenz fehlt.');
    return metadata(token,h,m.id,h.folderId);
  }
  async function create(token:string,h:MicrosoftHome,name:string,type:string,text:string) {
    const m=await (await call(token,`${namedPath(h,name)}:/content?@microsoft.graph.conflictBehavior=fail`,{method:'PUT',headers:{'Content-Type':type,'If-None-Match':'*'},body:text})).json();
    if(typeof m.id!=='string'||!m.id)throw new ProcessingError(502,'OneDrive hat den Upload nicht bestätigt.');
    await metadata(token,h,m.id,h.folderId);
    return m.id as string;
  }
  function checkpointName(j:ProcessingJob,name:string) {
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(j.run)||!['prepared','analyzed','export-plan','exported'].includes(name))throw new ProcessingError(400,'Ungültiger Checkpoint.');
    return `.cheatmeet-processing-${j.run}-${name}.json`;
  }
  async function read(token:string,h:MicrosoftHome,j:ProcessingJob,name:string) {
    const m=await find(token,h,checkpointName(j,name));if(!m)return null;
    const raw=await (await content(token,h,m.id,m.eTag)).json();
    if(raw._processing?.run!==j.run||raw._processing?.name!==name||raw._processing?.revision!==j.revision||raw._processing?.indexRevision!==j.indexRevision)throw conflict();
    const r=await parse(raw,j,token,h);
    if(typeof raw._processing.calendarError==='string')r.calendarError=raw._processing.calendarError.slice(0,2000);
    return {raw,report:r};
  }
  async function checkpoint(token:string,h:MicrosoftHome,j:ProcessingJob,name:string,input:ReportData) {
    const r=await parse(toArchive(input,input.updatedAt||j.updatedAt),j,token,h);
    const raw={...toArchive(r,r.updatedAt||j.updatedAt),_processing:{run:j.run,name,revision:j.revision,indexRevision:j.indexRevision,...(input.calendarError?{calendarError:input.calendarError.slice(0,2000)}:{})}};
    const existing=await read(token,h,j,name);
    if(existing){if(hash(existing.raw)!==hash(raw))throw conflict();return;}
    await create(token,h,checkpointName(j,name),'application/json',JSON.stringify(raw));
  }
  async function upsert(token:string,h:MicrosoftHome,name:string,type:string,text:string,known?:string) {
    const m=known?await metadata(token,h,known,h.folderId):await find(token,h,name);
    if(!m)return create(token,h,name,type,text);
    const protectedIds=[h.rootId,h.folderId,h.reportId,...artifacts.map(key=>h[key])].filter(id=>id!==known);
    if(!m.file||protectedIds.includes(m.id))throw new ProcessingError(403,'Ungültige OneDrive-Artefaktreferenz.',true);
    await call(token,`${itemPath(h,m.id)}/content`,{method:'PUT',headers:{'Content-Type':type,'If-Match':m.eTag},body:text});
    return m.id as string;
  }
  return {
    async load(j){const {h,token}=await context(j);return source(j,token,h);},
    async readCheckpoint(j,name){const {h,token}=await context(j);return (await read(token,h,j,name))?.report||null;},
    async checkpoint(j,name,r){const {h,token}=await context(j);await checkpoint(token,h,j,name,r);},
    async export(j,input){
      const {h,token}=await context(j);const current=await source(j,token,h);
      if(current.indexRevision!==j.indexRevision)throw conflict();
      const plan=(await read(token,h,j,'export-plan'))?.report;
      if(plan&&current.revision===hash(toArchive(plan,plan.updatedAt!)))return plan;
      if(current.revision!==j.revision)throw conflict();
      let r=plan;
      if(!r) {
        r=await parse(toArchive(input,input.updatedAt||j.updatedAt),j,token,h);
        const stamp=new Date().toISOString();r.updatedAt=stamp;r.home={...r.home!,syncedAt:stamp};
        if(input.calendarError)r.calendarError=input.calendarError.slice(0,2000);
        if(j.calendarSync&&j.analyze&&r.summary.trim()&&options.calendar)r=await options.calendar(j,r);
        if(r.transcription.trim())r.home.transcriptId=await upsert(token,r.home,'transkript.md','text/markdown',transcriptToMarkdown(r),r.home.transcriptId);
        if(r.summary.trim())r.home.markdownId=await upsert(token,r.home,'zusammenfassung.md','text/markdown',reportToMarkdown(r),r.home.markdownId);
        await checkpoint(token,h,j,'export-plan',r);
      }
      const latest=await source(j,token,h);
      if(latest.revision!==j.revision||latest.indexRevision!==j.indexRevision||latest.etag!==current.etag)throw conflict();
      await call(token,`${itemPath(h,h.reportId!)}/content`,{method:'PUT',headers:{'Content-Type':'application/json','If-Match':latest.etag},body:JSON.stringify(toArchive(r,r.updatedAt!))});
      return r;
    },
    async publish(j,input){
      const {h,token}=await context(j);const current=await index(j);
      const r=await parse(toArchive(input,input.updatedAt||j.updatedAt),j,token,h);
      if(input.calendarError)r.calendarError=input.calendarError.slice(0,2000);
      const value=clean(projectReport(r));
      if(current.revision!==j.indexRevision) {
        if(current.report&&hash(clean(current.report))===hash(value))return;
        throw conflict();
      }
      const precondition=j.indexRevision?`currentDocument.updateTime=${encodeURIComponent(j.indexRevision)}`:'currentDocument.exists=false';
      check(await f(`${current.url}?${precondition}`,{method:'PATCH',headers:{Authorization:`Bearer ${await runtimeToken()}`,'Content-Type':'application/json'},body:JSON.stringify({fields:encode(value).mapValue.fields}),redirect:'manual',signal:AbortSignal.timeout(10000)}));
    },
    async audio(j,input){
      const {h,token}=await context(j);
      const r=await parse(toArchive(input,input.updatedAt||j.updatedAt),j,token,h);
      const id=r.home?.audioId;if(!id)throw new ProcessingError(422,'Gesicherte Audioaufnahme fehlt.');
      const m=await metadata(token,h,id,h.folderId);
      const res=await content(token,h,id,m.eTag,60000);
      if(!res.body)throw new ProcessingError(502,'OneDrive-Audio konnte nicht gelesen werden.');
      return Readable.fromWeb(res.body as any);
    },
  };
}
