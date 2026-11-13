import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type { ReportData } from '../../src/types';
import type { MeetingTranscript } from '../../shared/transcription';
import { needsSpeakerReview, renderTranscript } from '../../shared/transcription';
import { reconcileSpeakers } from '../../src/lib/speakerMatches';
import { processingActive, type ProcessingJobView } from '../../shared/processing';
import type { DocStore } from '../mcp/docStore';
import { runtimeOptions } from './runtime';
import { toArchive } from '../../src/lib/archive';
import { withProcessingBudget } from './budget';
import { microsoftHome, type MicrosoftHome } from '../../shared/storage';
export { processingConfigured } from './runtime';

export interface Task { key: string; run: string; seq: number }
export interface ProcessingJob extends ProcessingJobView {
  owner: string; googleSub: string; key: string; run: string; seq: number;
  refs: { id:string; driveFolderId:string; driveReportId:string; home?:MicrosoftHome };
  revision:string; indexRevision:string; analyze:boolean; retranscribe:boolean; calendarSync:boolean; regenerate?:boolean;
  preferences:string; step:'prepare'|'analyze'|'export'|'publish'; failures:number; polls:number;
  lease?:string; leaseUntil?:number;
}
export interface ProcessingIO {
  load(job: Pick<ProcessingJob,'owner'|'googleSub'|'refs'>): Promise<{report:ReportData;revision:string;indexRevision:string}>;
  readCheckpoint(job:ProcessingJob,name:string):Promise<ReportData|null>;
  checkpoint(job:ProcessingJob,name:string,report:ReportData):Promise<void>;
  export(job:ProcessingJob,report:ReportData):Promise<ReportData>;
  publish(job:ProcessingJob,report:ReportData):Promise<void>;
}
export interface ProcessingOptions {
  enabled:()=>boolean; store:DocStore<ProcessingJob>;
  identify:(token:string)=>Promise<{uid:string;googleSub:string}>;
  verifyWorker:(token:string)=>Promise<void>;
  enqueue:(task:Task,delaySeconds?:number)=>Promise<void>;
  io:ProcessingIO;
  analyze:(text:string,preferences:string)=>Promise<{title:string;summary:string;transcription:string;todos:ReportData['todos'];takeaways:string[]}>;
  batch?:(job:ProcessingJob,report:ReportData)=>Promise<MeetingTranscript|null>;
  now?:()=>number;
  preferences?:(owner:string)=>Promise<string>;
}
export class ProcessingError extends Error {
  constructor(public status:number,message:string,public blocked=false){super(message);}
}
export const jobKey=(owner:string,id:string)=>createHash('sha256').update(`${owner}\0${id}`).digest('hex');
export const publicJob=(j:ProcessingJob):ProcessingJobView=>({reportId:j.reportId,state:j.state,message:j.message,attempts:j.attempts,updatedAt:j.updatedAt,...(j.error?{error:j.error}:{}),...(j.warning?{warning:j.warning}:{})});
const messages:Record<ProcessingJobView['state'],string>={queued:'Verarbeitung ist gesichert.',transcribing:'Transkript wird vorbereitet …',analyzing:'Bericht wird erstellt …',exporting:'Bericht wird im Meeting-Archiv gesichert …',review:'Sprecher prüfen oder Prüfung überspringen.',done:'Fertig.',blocked:'Bitte den verbundenen Speicherdienst oder den Auftrag prüfen.',error:'Verarbeitung fehlgeschlagen.'};
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(id);
const providerAware=(req:express.Request)=>req.get('X-CheatMeet-Storage')==='microsoft';
export function createProcessingRouter(options:Partial<ProcessingOptions>={}) {
  const o={...runtimeOptions(),...options} as ProcessingOptions;
  const router=express.Router(); const now=o.now||Date.now;
  const stamp=()=>new Date(now()).toISOString();
  const meta=(j:ProcessingJob)=>({ownerKey:j.owner,expireAt:new Date(now()+180*86400000)});
  const auth=async(req:express.Request)=>{
    const token=/^Bearer (\S+)$/i.exec(req.headers.authorization||'')?.[1];
    if(!token)throw new ProcessingError(401,'Bitte erneut anmelden.');
    try{return await o.identify(token);}catch{throw new ProcessingError(401,'Bitte erneut anmelden.');}
  };
  const fail=(res:express.Response,e:unknown)=>res.status(e instanceof ProcessingError?e.status:503).json({error:e instanceof ProcessingError?e.message:'Verarbeitung derzeit nicht verfügbar. Bitte später erneut versuchen.'});
  // Per-instance, nonauthoritative list snapshots only. Never cache identity,
  // grants, or hydrated report/transcript results; Firestore still owns jobs.
  type ListItem = { job: ProcessingJobView; microsoft: boolean };
  const lists = new Map<string, { expires: number; pending: Promise<ListItem[]> }>();
  const ownerList = (owner: string) => {
    const cached = lists.get(owner);
    if (cached && cached.expires > now()) return cached.pending;
    lists.delete(owner);
    if (lists.size >= 128) lists.delete(lists.keys().next().value!);
    const entry = { expires: Infinity, pending: undefined as unknown as Promise<ListItem[]> };
    entry.pending = o.store.listByOwner(owner).then(jobs => {
      entry.expires = now() + (jobs.some(processingActive) ? 5000 : 60000);
      return jobs.map(j => ({ job: publicJob(j), microsoft: !!j.refs.home }));
    }).catch(error => {
      if (lists.get(owner) === entry) lists.delete(owner);
      throw error;
    });
    lists.set(owner, entry);
    return entry.pending;
  };
  const send=async(j:ProcessingJob,delay=0)=>{
    lists.delete(j.owner); // Also invalidate terminal transitions (no enqueue).
    if(processingActive(j))await o.enqueue({key:j.key,run:j.run,seq:j.seq},delay);
  };
  router.get('/processing/config',(_req,res)=>res.json({enabled:o.enabled()}));
  // Worker route MUST precede the report-id route; browser Firebase tokens never authenticate here.
  router.post('/processing/worker',express.json({limit:'4kb'}),async(req,res)=>{
    try{
      try{await o.verifyWorker(/^Bearer (\S+)$/i.exec(req.headers.authorization||'')?.[1]||'');}catch{throw new ProcessingError(401,'Worker-Identität erforderlich.');}
      const task=req.body as Task;
      if(!task||!validId(task.key)||!validId(task.run)||!Number.isSafeInteger(task.seq)||task.seq<0)throw new ProcessingError(400,'Ungültiger Auftrag.');
      let j=await o.store.get(task.key);
      if(!j||j.run!==task.run||!processingActive(j)){res.json({ok:true});return;}
      if(j.seq!==task.seq){await send(j);res.json({ok:true});return;}
      const lease=randomUUID();
      j=await o.store.mutate(task.key,c=>c&&c.run===task.run&&c.seq===task.seq&&processingActive(c)&&(!c.leaseUntil||c.leaseUntil<=now())?{...c,lease,leaseUntil:now()+240000,attempts:c.attempts+1,updatedAt:stamp()}:undefined,meta);
      if(!j||j.lease!==lease){throw new ProcessingError(503,'Auftrag wird bereits verarbeitet.');}
      lists.delete(j.owner);
      const claimed=j;
      let patch:Partial<ProcessingJob>;
      let delay=0;
      try {
        await withProcessingBudget(200000, async()=>{
        // Every paid/result stage first probes its durable Drive checkpoint.
        if(j.step==='prepare'){
          let report=await o.io.readCheckpoint(j,'prepared');
          if(!report){
            const source=await o.io.load(j);
            if(source.revision!==j.revision||source.indexRevision!==j.indexRevision)throw new ProcessingError(409,'Der Bericht wurde inzwischen geändert. Bitte erneut starten.',true);
            report=source.report;
            if(!report.transcription.trim()&&report.speech?.turns.length)report={...report,transcription:renderTranscript(report.speech)};
            if(j.analyze&&(report.transcriptionOrigin==='import'&&!report.transcription.trim()&&report.speech?.phase!=='final'||j.retranscribe)){
              if(!o.batch)throw new ProcessingError(503,'Transkription ist nicht eingerichtet.',true);
              const speech=await o.batch(j,report);
              if(!speech){
                if(j.polls>=360)throw new ProcessingError(422,'Transkription dauert zu lange. Der bestehende Auftrag bleibt erhalten.',true);
                patch={state:'transcribing',polls:j.polls+1};delay=30;
              }else{
                report={...report,speech:report.transcriptionOrigin!=='import'&&report.speech?reconcileSpeakers(report.speech,speech):{...speech,speakerReview:'skipped'},transcription:renderTranscript(speech)};
                if(report.speech)report.transcription=renderTranscript(report.speech);
              }
            }
            if(!delay){
              if(j.analyze&&!report.transcription.trim())throw new ProcessingError(422,'Kein gespeichertes Transkript vorhanden. Es wurde keine weitere Transkription gestartet.');
              await o.io.checkpoint(j,'prepared',report);
            }
          }
          if(!delay)patch={step:needsSpeakerReview(report.speech)?'export':j.analyze&&(j.regenerate||!report.summary.trim())?'analyze':'export',state:needsSpeakerReview(report.speech)?'exporting':j.analyze&&(j.regenerate||!report.summary.trim())?'analyzing':'exporting'};
        }else if(j.step==='analyze'){
          let result=await o.io.readCheckpoint(j,'analyzed');
          if(!result){
            const report=await o.io.readCheckpoint(j,'prepared');
            if(!report)throw new ProcessingError(422,'Gesichertes Transkript fehlt.');
            const source=await o.io.load(j);
            if(source.revision!==j.revision||source.indexRevision!==j.indexRevision)throw new ProcessingError(409,'Der Bericht wurde inzwischen geändert.',true);
            const analysis=await o.analyze(report.transcription,j.preferences);
            result={...report,...analysis,title:report.title.trim()||analysis.title,suggestedTitle:analysis.title,transcription:report.transcription,status:'completed',error:'',updatedAt:stamp()};
            await o.io.checkpoint(j,'analyzed',result);
          }
          patch={step:'export',state:'exporting'};
        }else if(j.step==='export'){
          let result=await o.io.readCheckpoint(j,'exported');
          if(!result){
            const report=await o.io.readCheckpoint(j,'analyzed')||await o.io.readCheckpoint(j,'prepared');
            if(!report)throw new ProcessingError(422,'Gesicherter Bericht fehlt.');
            result=await o.io.export(j,report);
            await o.io.checkpoint(j,'exported',result);
          }
          patch={step:'publish',state:'exporting',...(result.calendarError?{warning:result.calendarError}:{})};
        }else{
          const report=await o.io.readCheckpoint(j,'exported');
          if(!report)throw new ProcessingError(422,'Export fehlt.');
          await o.io.publish(j,report);
          patch={state:needsSpeakerReview(report.speech)?'review':'done'};
        }
        });
        patch={...patch!,failures:0,error:undefined};
      }catch(e){
        const status=(e as {status?:number}).status;
        const blocked=e instanceof ProcessingError&&e.blocked||status===401||status===403||status===409;
        const permanent=blocked||!!status&&status>=400&&status<500&&![408,429].includes(status);
        const failures=j.failures+1;
        console.warn(JSON.stringify({event:'processing_failure',reportId:j.reportId,step:j.step,status:status||null,name:e instanceof Error?e.name:'unknown',attempt:failures}));
        const message=e instanceof ProcessingError?e.message
          : permanent?`Der KI-Dienst hat den Auftrag abgelehnt (Status ${status}). Bitte die Konfiguration prüfen.`
          :'Vorübergehender Dienstfehler. Die gesicherten Schritte bleiben erhalten.';
        patch={failures,error:message,state:blocked?'blocked':permanent||failures>=8?'error':j.state};
        delay=Math.min(900,10*2**failures);
      }
      const next=await o.store.mutate(task.key,c=>c&&c.run===claimed.run&&c.lease===lease?{...c,...patch,seq:c.seq+1,lease:undefined,leaseUntil:undefined,message:messages[patch.state||c.state],updatedAt:stamp()}:undefined,meta);
      if(next)await send(next,delay);
      res.json({ok:true});
    }catch(e){fail(res,e);}
  });
  router.get('/processing',async(req,res)=>{try{const a=await auth(req);const jobs=await ownerList(a.uid);res.setHeader('Cache-Control','no-store');res.json({jobs:jobs.filter(j=>!j.microsoft||providerAware(req)).map(j=>j.job).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,50)});}catch(e){fail(res,e);}});
  router.get('/processing/:id',async(req,res)=>{try{
    const a=await auth(req);const j=await o.store.get(jobKey(a.uid,String(req.params.id)));
    if(!j||j.owner!==a.uid||j.refs.home&&!providerAware(req))throw new ProcessingError(404,'Auftrag nicht gefunden.');
    const report=['done','review'].includes(j.state)?await o.io.readCheckpoint(j,'exported'):null;
    res.setHeader('Cache-Control','no-store');res.json({job:publicJob(j),...(report?{report}:{})});
  }catch(e){fail(res,e);}});
  router.post('/processing/:id',express.json({limit:'12mb'}),async(req,res)=>{try{
    const a=await auth(req);
    if(!o.enabled())throw new ProcessingError(503,'Serververarbeitung ist nicht eingerichtet.');
    const b=req.body;const r=b?.report;
    let home:MicrosoftHome|undefined;
    if(r?.home!==undefined){
      try{home=microsoftHome(r.home);}catch{throw new ProcessingError(400,'Ungültiger OneDrive-Speicherort.');}
      if(!providerAware(req)||!home.folderId||!home.reportId||r.driveFolderId||r.driveReportId||r.rawAudioUrl)throw new ProcessingError(400,'Eindeutige OneDrive-Berichtsreferenzen fehlen.');
    }
    if(!r||!validId(req.params.id)||r.id!==req.params.id||!home&&(!validId(r.driveFolderId)||!validId(r.driveReportId))||typeof b.analyze!=='boolean'||['retranscribe','calendarSync','regenerate'].some(k=>b[k]!==undefined&&typeof b[k]!=='boolean')||b.preferences!==undefined&&(typeof b.preferences!=='string'||b.preferences.length>20000))throw new ProcessingError(400,'Gesicherte Berichtsreferenzen fehlen.');
    const key=jobKey(a.uid,r.id);const existing=await o.store.get(key);
    if(existing&&(Boolean(existing.refs.home)!==Boolean(home)||home&&['connectionId','driveId','folderId','reportId'].some(k=>(existing.refs.home as any)?.[k]!== (home as any)[k])))throw new ProcessingError(409,'Der Auftrag gehört zu einem anderen Meeting-Speicherort.',true);
    if(existing&&processingActive(existing)){await send(existing);res.status(202).json({job:publicJob(existing)});return;}
    const refs:ProcessingJob['refs']={id:r.id,driveFolderId:home?.folderId||r.driveFolderId,driveReportId:home?.reportId||r.driveReportId,...(home?{home}:{})};
    const source=await o.io.load({owner:a.uid,googleSub:a.googleSub,refs});
    if(existing?.state==='done'&&(existing.analyze||!b.analyze)&&existing.revision===source.revision){res.status(202).json({job:publicJob(existing)});return;}
    if(existing?.state==='done'&&(existing.analyze||!b.analyze)){
      const exported=await o.io.readCheckpoint(existing,'exported');
      const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,sorted(x)])):v;
      const canonical=(r:ReportData)=>JSON.stringify(sorted(toArchive(r,'')));
      if(exported&&canonical(exported)===canonical(source.report)){res.status(202).json({job:publicJob(existing)});return;}
    }
    const preferences=typeof b.preferences==='string'?b.preferences:await o.preferences?.(a.uid)||'';
    const same=existing&&['blocked','error','review'].includes(existing.state)&&existing.revision===source.revision&&existing.indexRevision===source.indexRevision;
    const fresh:ProcessingJob={reportId:r.id,key,owner:a.uid,googleSub:a.googleSub,refs,revision:source.revision,indexRevision:source.indexRevision,run:randomUUID(),seq:0,state:'queued',message:messages.queued,attempts:0,failures:0,polls:0,step:'prepare',analyze:b.analyze,retranscribe:b.retranscribe===true,calendarSync:b.calendarSync===true,regenerate:b.regenerate===true,preferences,updatedAt:stamp()};
    const next=await o.store.mutate(key,c=>{
      if(c&&processingActive(c))return undefined;
      // Same-revision retries retain paid/result checkpoints and immutable run.
      return same&&c?.run===existing.run?{...c,state:'queued',message:messages.queued,error:undefined,failures:0,seq:c.seq+1,lease:undefined,leaseUntil:undefined,updatedAt:stamp()}:fresh;
    },meta);
    if(!next)throw new ProcessingError(503,'Auftrag konnte nicht gesichert werden.');
    await send(next);res.status(202).json({job:publicJob(next)});
  }catch(e){fail(res,e);}});
  return router;
}
