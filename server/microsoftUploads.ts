import express from 'express';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import firebaseConfig from '../firebase-applet-config.json';
import { fileDocStore, firestoreDocStore, type DocStore } from './mcp/docStore';
import { firebaseAccountFor, getMicrosoftAccess } from './microsoftAuth';
import { serviceAccountToken } from './tokenStore';

interface FinalItem { id: string; size: number; eTag: string; webUrl?: string }
export interface UploadDocument {
  owner: string; connectionId: string; driveId: string; parentId: string; name: string;
  size: number; reportId?: string; itemId?: string; initialEtag?: string;
  uploadUrl: string; expirationDateTime: string; createdAt: number; result?: FinalItem;
}
interface Options {
  store?: DocStore<UploadDocument>;
  identify?: (token: string) => Promise<{uid:string;googleSub:string}>;
  access?: (uid:string,connectionId:string) => Promise<string>;
  fetchImpl?: typeof fetch; now?: () => number;
}
class UploadError extends Error {
  constructor(public status: number, message: string, public retryAfter?: string) { super(message); }
}
const invalid = () => new UploadError(400, 'Ungültige Uploadangaben.');
const conflict = () => new UploadError(409, 'Die Datei ist unvollständig oder wurde inzwischen geändert. Bitte erneut prüfen.');
const expired = () => new UploadError(410, 'Die Uploadsitzung ist abgelaufen. Bitte neu starten.');
const denied = () => new UploadError(403, 'Bitte den Microsoft-Zugriff erneut freigeben.');
const enc = encodeURIComponent;
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\s/\\?#:\x00-\x1f]/.test(v);
function safeUploadUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443') &&
      (u.hostname.endsWith('.up.1drv.com') || u.hostname.endsWith('.up.1drv.com.cn') || u.hostname.endsWith('.sharepoint.com'));
  } catch { return false; }
}
const safeName = (v: unknown): v is string => typeof v === 'string' && v.length <= 180 &&
  /^(?:bericht_daten\.json|zusammenfassung\.md|transkript\.md|einwilligung\.md|index\.json|SCHEMA\.md|[\p{L}\p{N}_ -][\p{L}\p{N}_. -]*\.(?:webm|mp3|mp4|m4a|wav|ogg|flac|aac))$/u.test(v) && !v.includes('..') && !/[ .]$/.test(v);

export function createMicrosoftUploadRouter(options: Options = {}): express.Router {
  const router = express.Router(), fetchImpl = options.fetchImpl || fetch, now = options.now || Date.now;
  let store = options.store;
  const docs = () => store ||= process.env.NODE_ENV !== 'production'
    ? fileDocStore<UploadDocument>(path.resolve('.microsoft-uploads'))
    : firestoreDocStore<UploadDocument>({collection:'microsoftUploads',projectId:process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId,databaseId:(firebaseConfig as {firestoreDatabaseId?:string}).firestoreDatabaseId || '(default)',fetchImpl,token:()=>serviceAccountToken(fetchImpl)});
  // Retain expired-session tombstones for 30 days so expiration is 410, not 404.
  const meta = (d: UploadDocument) => ({ownerKey:d.owner,expireAt:new Date(Math.max(now(),Date.parse(d.expirationDateTime))+30*86400_000)});
  const save = async (handle: string, doc: UploadDocument) => {
    await docs().mutate(handle, current => {
      // A slow status request on another instance must never undo completion.
      if (current?.result) return undefined;
      return doc;
    }, meta(doc));
  };
  const access = async (owner: string, connection: string) => {
    try { const token = await (options.access ? options.access(owner,connection) : getMicrosoftAccess(owner,connection).then(r=>r.accessToken)); if (!token) throw denied(); return token; }
    catch { throw denied(); }
  };
  const request = async (url: string, init: RequestInit = {}) => fetchImpl(url,{...init,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20_000)});
  const check = (r: Response) => {
    if (r.ok) return;
    if (r.status === 401 || r.status === 403) throw denied();
    if (r.status === 429) throw new UploadError(429,'Microsoft begrenzt gerade die Anfragen. Bitte später erneut versuchen.',r.headers.get('retry-after') || undefined);
    if (r.status === 409 || r.status === 412) throw conflict();
    throw new UploadError(502,'Microsoft konnte den Upload nicht bestätigen. Bitte erneut versuchen.');
  };
  const graph = (token: string, route: string, init: RequestInit = {}) => request('https://graph.microsoft.com/v1.0'+route,{...init,headers:{'Content-Type':'application/json',...init.headers,Authorization:`Bearer ${token}`}});
  const route = (run: (owner: string, req: express.Request, res: express.Response)=>Promise<void>): express.RequestHandler => async (req,res) => {
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
    try {
      let owner: string;
      try { const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1]; if (!token) throw denied(); owner=(await (options.identify || firebaseAccountFor)(token)).uid; if (!owner) throw denied(); } catch { throw denied(); }
      await run(owner,req,res);
    } catch (e) {
      const error = e instanceof UploadError ? e : new UploadError(503,'Microsoft ist gerade nicht erreichbar. Bitte erneut versuchen.');
      if (error.retryAfter) res.set('Retry-After',error.retryAfter);
      res.status(error.status).json({error:error.message});
    }
  };
  const json = express.json({limit:'8kb'});
  router.post('/microsoft/uploads',json,route(async (owner,req,res)=>{
    const b = req.body;
    if (!b || !identifier(b.connectionId) || !identifier(b.driveId) || !identifier(b.parentId) || !safeName(b.name) || !Number.isSafeInteger(b.size) || b.size <= 0 || b.size > 250*1024**3 ||
      (b.reportId !== undefined && !identifier(b.reportId)) || (b.itemId !== undefined && !identifier(b.itemId)) ||
      (b.itemId ? typeof b.etag !== 'string' || !b.etag || b.etag.length > 1024 || /[\r\n]/.test(b.etag) : b.etag !== undefined)) throw invalid();
    const token = await access(owner,b.connectionId);
    const own = await graph(token,'/me/drive'); check(own);
    if ((await own.json()).id !== b.driveId) throw denied();
    const base = `/drives/${enc(b.driveId)}/items/`;
    const parent = await graph(token,base+enc(b.parentId)); check(parent);
    const p = await parent.json();
    // Shared/remote and explicitly read-only folders are never upload homes. A
    // successful createUploadSession also checks effective delegated write access.
    if (!p.folder || p.remoteItem || p.deleted || p.id !== b.parentId || p.parentReference?.driveId !== b.driveId || p.shared?.scope === 'anonymous' || p.permissions?.some((v: {roles?:string[]})=>v.roles?.includes('read') && !v.roles?.includes('write') && !v.roles?.includes('owner'))) throw denied();
    if (b.itemId) {
      const existing = await graph(token,base+enc(b.itemId)); check(existing);
      const item = await existing.json();
      if (item.id !== b.itemId || !item.file || item.remoteItem || item.name !== b.name || item.parentReference?.id !== b.parentId || item.parentReference?.driveId !== b.driveId || item.eTag !== b.etag) throw conflict();
    } else {
      const existing = await graph(token,base+enc(b.parentId)+':/'+enc(b.name));
      if (existing.status !== 404) { check(existing); throw conflict(); }
    }
    const createdAt = now();
    const session = await graph(token,base+(b.itemId ? enc(b.itemId) : enc(b.parentId)+':/'+enc(b.name)+':')+'/createUploadSession',{
      method:'POST',headers:b.itemId ? {'If-Match':b.etag} : {},
      body:JSON.stringify({item:{name:b.name,'@microsoft.graph.conflictBehavior':b.itemId ? 'replace' : 'fail'},...(b.itemId ? {deferCommit:true} : {})})
    }); check(session);
    const s = await session.json();
    if (!safeUploadUrl(s.uploadUrl) || !Number.isFinite(Date.parse(s.expirationDateTime)) || Date.parse(s.expirationDateTime) <= now()) throw new UploadError(502,'Microsoft hat keine sichere Uploadsitzung geliefert.');
    const handle = randomBytes(32).toString('base64url');
    const d: UploadDocument = {owner,connectionId:b.connectionId,driveId:b.driveId,parentId:b.parentId,name:b.name,size:b.size,uploadUrl:s.uploadUrl,expirationDateTime:s.expirationDateTime,createdAt,
      ...(b.reportId ? {reportId:b.reportId}:{}),...(b.itemId ? {itemId:b.itemId,initialEtag:b.etag}:{})};
    await save(handle,d); res.json({handle});
  }));
  const load = async (owner: string, body: unknown) => {
    const handle = (body as {handle?: unknown} | null)?.handle;
    if (typeof handle !== 'string' || !/^[\w-]{43}$/.test(handle)) throw new UploadError(404,'Uploadsitzung nicht gefunden.');
    const doc = await docs().get(handle);
    if (!doc || doc.owner !== owner) throw new UploadError(404,'Uploadsitzung nicht gefunden.');
    if (!safeUploadUrl(doc.uploadUrl)) throw new UploadError(502,'Ungültige Uploadsitzung.');
    const token = await access(owner,doc.connectionId);
    return {handle,doc,token};
  };
  const status = async (handle: string, doc: UploadDocument) => {
    // Chunks extend provider expiry; query even after the last observed expiry.
    const response = await request(doc.uploadUrl);
    if (response.status === 404 || response.status === 410) return null;
    check(response);
    const s = await response.json();
    if (!Number.isFinite(Date.parse(s.expirationDateTime)) || !Array.isArray(s.nextExpectedRanges) ||
      !s.nextExpectedRanges.every((v: unknown)=>{
        if (typeof v !== 'string' || !/^\d+-\d*$/.test(v)) return false;
        const [start,end] = v.split('-');
        return Number.isSafeInteger(Number(start)) && Number(start) <= doc.size &&
          (!end || (Number.isSafeInteger(Number(end)) && Number(end) >= Number(start) && Number(end) < doc.size));
      })) throw new UploadError(502,'Ungültiger Uploadfortschritt von Microsoft.');
    doc.expirationDateTime = s.expirationDateTime;
    await save(handle,doc);
    if (Date.parse(s.expirationDateTime) <= now()) throw expired();
    return {uploadUrl:doc.uploadUrl,nextExpectedRanges:s.nextExpectedRanges as string[],expirationDateTime:s.expirationDateTime as string};
  };
  router.post('/microsoft/uploads/session',json,route(async(owner,req,res)=>{
    const {handle,doc} = await load(owner,req.body);
    if (doc.result) throw conflict();
    const s = await status(handle,doc);
    if (!s) throw expired();
    res.json(s);
  }));
  router.post('/microsoft/uploads/complete',json,route(async(owner,req,res)=>{
    const {handle,doc,token} = await load(owner,req.body);
    if (doc.result) { res.json(doc.result); return; }
    const s = await status(handle,doc);
    let item: any;
    if (s) {
      // Deferred providers may express fully received data as [] or [size-].
      if (!doc.itemId || s.nextExpectedRanges.some(v=>Number(v.split('-')[0]) < doc.size)) throw conflict();
      // Crucially the precondition is on this final commit, not just session creation.
      const committed = await graph(token,`/drives/${enc(doc.driveId)}/items/${enc(doc.itemId)}`,{
        method:'PUT',headers:{'If-Match':doc.initialEtag!},
        body:JSON.stringify({name:doc.name,'@microsoft.graph.conflictBehavior':'replace','@microsoft.graph.sourceUrl':doc.uploadUrl})
      }); check(committed); const receipt = await committed.json();
      if (receipt.id !== doc.itemId || typeof receipt.eTag !== 'string') throw conflict();
      const verified = await graph(token,`/drives/${enc(doc.driveId)}/items/${enc(doc.itemId)}`);
      check(verified); item = await verified.json();
      if (item.eTag !== receipt.eTag) throw conflict();
    } else {
      if (Date.parse(doc.expirationDateTime) <= now()) throw expired();
      // For updates, an unavailable deferred session is ambiguous: the old
      // same-size target or another writer must NEVER be mistaken for our commit.
      if (doc.itemId) throw conflict();
      const resolved = await graph(token,`/drives/${enc(doc.driveId)}/items/${enc(doc.parentId)}:/${enc(doc.name)}`);
      if (resolved.status === 404) throw conflict();
      check(resolved); item = await resolved.json();
      // Creation was confirmed absent immediately before session creation;
      // fail-on-conflict + a consumed session + a newly created matching item
      // recovers a lost last-chunk response without accepting a preexisting file.
      if (!Number.isFinite(Date.parse(item.createdDateTime)) || Date.parse(item.createdDateTime) < doc.createdAt - 1000) throw conflict();
    }
    if (!identifier(item.id) || !item.file || item.folder || item.remoteItem || item.deleted || item.size !== doc.size || item.name !== doc.name ||
      item.parentReference?.driveId !== doc.driveId || item.parentReference?.id !== doc.parentId || typeof item.eTag !== 'string' || !item.eTag ||
      (doc.itemId && (item.id !== doc.itemId || item.eTag === doc.initialEtag))) throw conflict();
    const result: FinalItem = {id:item.id,size:item.size,eTag:item.eTag};
    // webUrl is optional. Deliberately omit provider URLs here: only /session
    // is allowed to return the preauthenticated capability, even if metadata lies.
    doc.result = result; await save(handle,doc); res.json(result);
  }));
  // Parser failures must not expose Express HTML, request bodies or signed URLs.
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction)=>{
    const status = (error as {status?:number})?.status;
    res.status(status === 413 ? 413 : 400).set('Cache-Control','no-store').json({error:'Ungültige Uploadanfrage.'});
  });
  return router;
}
