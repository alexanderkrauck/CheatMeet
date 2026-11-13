import { createRemoteJWKSet, jwtVerify } from 'jose';
import config from '../../firebase-applet-config.json';
import { serviceAccountToken } from '../tokenStore';
import { firestoreDocStore } from '../mcp/docStore';
import { googleAccountFor } from '../googleAuth';
import { analyzeTranscript } from '../analysis';
import { createBatchTranscriptionService, ApiError } from '../transcription';
import { ProcessingError } from './index';
import { validLanguages } from '../../shared/transcription';
import type { ProcessingJob, ProcessingOptions, Task } from './index';
import { createDriveIO } from './drive';
import { boundedFetch, remainingProcessingMs } from './budget';

export const processingConfigured=()=>Boolean(process.env.PROCESSING_QUEUE&&process.env.PROCESSING_WORKER_URL&&process.env.PROCESSING_SERVICE_ACCOUNT&&process.env.GOOGLE_OAUTH_CLIENT_SECRET);
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
export function runtimeOptions():ProcessingOptions {
  const projectId=process.env.FIREBASE_PROJECT_ID||config.projectId;
  const io=createDriveIO();
  const batch=createBatchTranscriptionService({fetchImpl:boundedFetch});
  return {
    enabled:processingConfigured,
    identify:t=>googleAccountFor(t,projectId),verifyWorker:verifyProcessingWorker,enqueue:createTaskQueue(),
    store:firestoreDocStore<ProcessingJob>({collection:'processingJobs',projectId,databaseId:config.firestoreDatabaseId||'(default)',fetchImpl:fetch,token:()=>serviceAccountToken(fetch)}),
    io,analyze:(text,prefs)=>analyzeTranscript(text,prefs,{retryAttempts:1,timeoutMs:remainingProcessingMs(120000)}),
    preferences:async(owner)=>{
      const database=encodeURIComponent(config.firestoreDatabaseId||'(default)');
      const response=await boundedFetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/${database}/documents/users/${encodeURIComponent(owner)}/settings/preferences`,{headers:{Authorization:`Bearer ${await serviceAccountToken(boundedFetch)}`},signal:AbortSignal.timeout(10000)});
      if(response.status===404)return '';
      if(!response.ok)throw Error('Preferences unavailable');
      const value=(await response.json()).fields?.summaryPrompt?.stringValue;
      return typeof value==='string'?value.slice(0,20000):'';
    },
    batch:async(job,report)=>{
      try{
      const result=await batch.poll(job.owner,report.id);
      if(result.state==='completed')return result.speech;
      if(result.state==='retryable'){
        const input=await io.audio(job,report);
        await batch.start(job.owner,report.id,validLanguages(report.speech?.languages)?report.speech.languages:['de','en'],input);
      }
      return null;
      }catch(e){if(e instanceof ApiError)throw new ProcessingError(e.status,e.message,e.status===409);throw e;}
    },
  };
}
