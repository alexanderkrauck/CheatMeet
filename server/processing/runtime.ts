import { createRemoteJWKSet, jwtVerify } from 'jose';
import config from '../../firebase-applet-config.json';
import { serviceAccountToken } from '../tokenStore';
import { firestoreDocStore } from '../mcp/docStore';
import { firebaseAccountFor, microsoftConfigured } from '../microsoftAuth';
import { analyzeTranscript } from '../analysis';
import { createBatchTranscriptionService, ApiError } from '../transcription';
import { ProcessingError } from './index';
import { validLanguages } from '../../shared/transcription';
import type { ProcessingJob, ProcessingOptions, Task } from './index';
import { createDriveIO } from './drive';
import { createOneDriveIO } from './onedrive';
import { storageIO, type StorageIO } from './storage';
import { fileSubmissionStore, firestoreSubmissionStore, submissionKey, type Submission, type SubmissionStore } from '../transcriptionStore';
import { processingSourceKey } from '../../shared/processing';
import { syncWorkerCalendar } from './calendar';
import { boundedFetch, remainingProcessingMs, withProcessingHeadroom } from './budget';

export const processingConfigured=()=>Boolean(process.env.PROCESSING_QUEUE&&process.env.PROCESSING_WORKER_URL&&process.env.PROCESSING_SERVICE_ACCOUNT&&(process.env.GOOGLE_OAUTH_CLIENT_SECRET||microsoftConfigured()));
const googleKeys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export async function verifyProcessingWorker(token:string) {
  if(!processingConfigured()||!token)throw Error('Worker not configured');
  const {payload}=await jwtVerify(token,googleKeys,{algorithms:['RS256'],audience:process.env.PROCESSING_WORKER_URL,issuer:['https://accounts.google.com','accounts.google.com']});
  if(payload.email!==process.env.PROCESSING_SERVICE_ACCOUNT||payload.email_verified!==true||!payload.sub)throw Error('Wrong worker identity');
}
export function createTaskQueue(fetchImpl:typeof fetch=fetch,token=()=>serviceAccountToken(fetchImpl)) {
  return async(task:Task,delay=0)=>{
    const queue=process.env.PROCESSING_QUEUE!;
    const name=`${queue}/tasks/processing-${task.key}-${task.run}-${task.seq}`;
    const response=await fetchImpl(`https://cloudtasks.googleapis.com/v2/${queue}/tasks`,{
      method:'POST',headers:{Authorization:`Bearer ${await token()}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),
      body:JSON.stringify({task:{name,dispatchDeadline:'240s',...(delay?{scheduleTime:new Date(Date.now()+delay*1000).toISOString()}:{}),httpRequest:{httpMethod:'POST',url:process.env.PROCESSING_WORKER_URL,headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify(task)).toString('base64'),oidcToken:{serviceAccountEmail:process.env.PROCESSING_SERVICE_ACCOUNT,audience:process.env.PROCESSING_WORKER_URL}}}}),
    });
    if(!response.ok&&response.status!==409)throw Error(`Cloud Tasks enqueue failed (${response.status})`);
  };
}
/** The worker and capability read share the existing durable final-pass store. */
export function createProcessingTranscription(io:Pick<StorageIO,'audio'>,options:NonNullable<Parameters<typeof createBatchTranscriptionService>[0]>={}):Required<Pick<ProcessingOptions,'batch'|'retranscription'>> {
  const store=options.store||(process.env.NODE_ENV==='production'?firestoreSubmissionStore():fileSubmissionStore());
  const batch=createBatchTranscriptionService({fetchImpl:boundedFetch,...options,store});
  return {
    retranscription:async(owner,id)=>{
      const submission=await store.get(submissionKey(owner,`${id}:final`));
      if(submission&&submission.state!=='retryable')return !submission.providerId
        ? {state:'uncertain',message:'Der letzte vollständige Transkriptionsauftrag ist unbestätigt. Kein erneutes Senden; die Originalaufnahme und das bisherige Transkript bleiben erhalten.'}
        : {state:'used',message:'Der einmalige vollständige Transkriptionsdurchlauf wurde bereits verwendet. Es wird kein weiterer kostenpflichtiger Durchlauf gestartet.'};
      return (options.apiKey??process.env.ASSEMBLYAI_API_KEY)
        ? {state:'available',message:'Ein einmaliger kostenpflichtiger Durchlauf der gesamten Aufnahme ist verfügbar.'}
        : {state:'unavailable',message:'Transkription ist nicht eingerichtet.'};
    },
    batch:async(job,report)=>{
      try{
        // Bind only new explicit full passes. Historical jobs/import recovery
        // keep their existing reservation semantics; nothing is migrated/deleted.
        let service=batch;
        if(job.requireNewBatch){
          const source=processingSourceKey(job.refs);
          type BoundSubmission=Submission&{processingRun?:string;processingSource?:string};
          const bound=(value:Submission):BoundSubmission=>({...value,processingRun:job.run,processingSource:source});
          const runStore:SubmissionStore={
            get:async key=>{
              const value=await store.get(key) as BoundSubmission|null;
              if(value&&value.state!=='retryable'&&(value.processingRun!==job.run||value.processingSource!==source))throw new ProcessingError(409,'Der vollständige Transkriptionsdurchlauf ist bereits für einen anderen Auftrag belegt. Es wurde keine neue Transkription gestartet.',true);
              return value;
            },
            reserve:(key,value)=>store.reserve(key,bound(value)),
            retry:(key,value)=>store.retry(key,bound(value)),
            set:(key,value)=>store.set(key,bound(value)),
          };
          service=createBatchTranscriptionService({fetchImpl:boundedFetch,...options,store:runStore});
        }
        const result=await service.poll(job.owner,report.id);
        if(result.state==='completed')return result.speech;
        if(result.state==='retryable'){
          const input=await io.audio(job,report);
          try{await service.start(job.owner,report.id,validLanguages(report.speech?.languages)?report.speech.languages:['de','en'],input,{storage:job.refs?.home?'microsoft':'google',ownerLabel:job.usageOwnerLabel});}
          finally{input.destroy();}
        }
        return null;
      }catch(e){if(e instanceof ApiError)throw new ProcessingError(e.status,e.message,e.status===409);throw e;}
    },
  };
}
export function runtimeOptions():ProcessingOptions {
  const projectId=process.env.FIREBASE_PROJECT_ID||config.projectId;
  const io=storageIO(createDriveIO({calendar:syncWorkerCalendar}),createOneDriveIO({calendar:syncWorkerCalendar}));
  return {
    enabled:processingConfigured,
    identify:t=>firebaseAccountFor(t,projectId),verifyWorker:verifyProcessingWorker,enqueue:createTaskQueue(),
    store:firestoreDocStore<ProcessingJob>({collection:'processingJobs',projectId,databaseId:config.firestoreDatabaseId||'(default)',fetchImpl:fetch,token:()=>serviceAccountToken(fetch)}),
    io,analyze:(text,prefs,job)=>withProcessingHeadroom(20000,()=>analyzeTranscript(text,prefs,{retryAttempts:1,timeoutMs:remainingProcessingMs(120000),usageContext:{owner:job.owner,ownerLabel:job.usageOwnerLabel,meetingId:job.reportId,storage:job.refs.home?'microsoft':'google',operation:'summary'}})),
    preferences:async(owner)=>{
      const database=encodeURIComponent(config.firestoreDatabaseId||'(default)');
      const response=await boundedFetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/${database}/documents/users/${encodeURIComponent(owner)}/settings/preferences`,{headers:{Authorization:`Bearer ${await serviceAccountToken(boundedFetch)}`},signal:AbortSignal.timeout(10000)});
      if(response.status===404)return '';
      if(!response.ok)throw Error('Preferences unavailable');
      const value=(await response.json()).fields?.summaryPrompt?.stringValue;
      return typeof value==='string'?value.slice(0,20000):'';
    },
    ...createProcessingTranscription(io),
  };
}
