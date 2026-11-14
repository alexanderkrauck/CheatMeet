import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import firebaseConfig from "../firebase-applet-config.json";

export interface GrantSnapshot {
  key: string;
  refreshToken: string | null;
  /** Native document version, including credential-free tombstones. */
  version: string | null;
  owner?: string;
  subject?: string;
  /** Revocation cutoff survives tombstones and later same-token generations. */
  revokedAt?: number;
}
type GrantWrite = Omit<GrantSnapshot, "version">;
/** Existing workers/MCP keep their seam; auth mutations require CAS. */
export interface RefreshTokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, refreshToken: string): Promise<void>;
  remove(key: string): Promise<void>;
  read?(key: string): Promise<GrantSnapshot>;
  compare?(expected: GrantSnapshot[], writes: GrantWrite[]): Promise<boolean>;
}
function atomic(store: RefreshTokenStore) {
  if (!store.read || !store.compare) throw Error("Versioned Google grant store required");
  return {read: store.read.bind(store), compare: store.compare.bind(store)};
}
export const uidGrantKey = (uid: string) => `uid-${createHash("sha256").update(uid).digest("hex")}`;
const legacyBindingKey = (uid: string) => `${uidGrantKey(uid)}-legacy`;
export const runtimeGrantStore = (): RefreshTokenStore => process.env.NODE_ENV === "production" ? firestoreStore() : fileGrantStore();
const rawSubject = (sub: string) => sub && !sub.startsWith("uid-") ? sub : "";
const stale = () => Error("Die Google-Verbindung wurde inzwischen geändert. Bitte erneut versuchen.");

/** A historical alias is a lookup hint, never authority over its replacement. */
export async function ownerGoogleGrantState(store: RefreshTokenStore, identity: {uid: string; googleSub: string}) {
  const a = atomic(store);
  const owned = await a.read(uidGrantKey(identity.uid));
  const binding = await a.read(legacyBindingKey(identity.uid));
  const subject = owned.subject || binding.refreshToken || rawSubject(identity.googleSub);
  const legacy = subject ? await a.read(subject) : null;
  const linked = Boolean(subject && rawSubject(identity.googleSub) === subject);
  const aliasOwned = Boolean(legacy?.refreshToken && (
    legacy.owner === owned.key && (!owned.subject || owned.subject === subject) ||
    !legacy.owner && (owned.refreshToken ? legacy.refreshToken === owned.refreshToken || linked && binding.refreshToken === subject : !owned.version && linked)
  ));
  // Do not even no-op write another workspace's replacement or manufacture a
  // subject alias for data-only consent. A linked new consent adds its own CAS.
  const expected = [owned, binding, ...(legacy && (legacy.owner === owned.key || !legacy.owner && (aliasOwned || linked)) ? [legacy] : [])];
  return {owned, binding, subject, legacy, expected, linked, aliasOwned};
}

/** Only verified Firebase identities may use legacy fallback/adoption. */
export async function ownerGoogleGrant(store: RefreshTokenStore, identity: {uid: string; googleSub: string}) {
  const state = await ownerGoogleGrantState(store, identity);
  const {owned, binding, legacy, subject, linked} = state;
  if (owned.refreshToken) {
    // Subject-only cached callbacks retain ownership; another UID's bound
    // consent replaces it. Historical bindings cannot authorize that record.
    if (linked && binding.refreshToken === subject && legacy?.refreshToken &&
        (!legacy.owner || legacy.owner === owned.key) && legacy.refreshToken !== owned.refreshToken) {
      if (!await atomic(store).compare(state.expected, [{...owned, refreshToken:legacy.refreshToken, owner:owned.key, subject}])) throw stale();
      const current = await atomic(store).read(owned.key);
      if (current.refreshToken !== legacy.refreshToken) throw stale();
      return current;
    }
    return owned;
  }
  if (!linked || !legacy?.refreshToken || legacy.owner && legacy.owner !== owned.key) return null;
  // Revoke atomically empties both UID and owned alias. A nonempty owned alias
  // after that point requires NEW explicit subject-only consent, not a stale
  // promotion. Preserve cached clients without trusting a foreign replacement.
  if (owned.version) {
    if (legacy.owner !== owned.key || owned.subject !== subject) return null;
    if (!await atomic(store).compare(state.expected, [{...owned,refreshToken:legacy.refreshToken}])) throw stale();
    const current = await atomic(store).read(owned.key);
    if (current.refreshToken !== legacy.refreshToken) throw stale();
    return current;
  }
  return legacy;
}

/** Preserve legacy job keys without switching the workspace's data account. */
export async function preserveOwnerGoogleGrant(store: RefreshTokenStore, identity: {uid: string; googleSub: string}) {
  const state = await ownerGoogleGrantState(store, identity);
  const {owned, binding, legacy, subject, linked} = state;
  if (!owned.refreshToken && (!linked || !legacy?.refreshToken || legacy.owner && legacy.owner !== owned.key || owned.version && (legacy.owner !== owned.key || owned.subject !== subject))) return;
  const renewed = linked && binding.refreshToken === subject && legacy?.refreshToken && (!legacy.owner || legacy.owner === owned.key);
  const token = renewed ? legacy.refreshToken : owned.refreshToken || legacy!.refreshToken;
  const writes: GrantWrite[] = [{...owned, refreshToken:token, owner:owned.key, subject}];
  writes.push({...binding, refreshToken:linked ? subject : null});
  if (linked && legacy?.refreshToken && (!legacy.owner || legacy.owner === owned.key)) writes.push({...legacy, owner:owned.key});
  if (!await atomic(store).compare(state.expected, writes)) throw stale();
}

/** One conditional commit, not set(uid) followed by unfenced preservation. */
export async function saveOwnerGoogleGrant(store: RefreshTokenStore, identity: {uid: string; googleSub: string}, subject: string, token: string | undefined, state?: Awaited<ReturnType<typeof ownerGoogleGrantState>>) {
  const before = state || await ownerGoogleGrantState(store, identity);
  const {owned, binding} = before;
  const refreshToken = token || (owned.subject === subject || !owned.subject && rawSubject(identity.googleSub) === subject ? owned.refreshToken : null);
  if (!refreshToken) throw Error("Google hat keinen dauerhaften Zugriff erteilt. Bitte erneut versuchen.");
  const linked = rawSubject(identity.googleSub) === subject;
  const writes: GrantWrite[] = [
    {...owned, refreshToken, owner:owned.key, subject},
    {...binding, refreshToken:linked ? subject : null},
  ];
  const expected = [...before.expected];
  if (linked) {
    const alias = before.legacy?.key === subject ? before.legacy : await atomic(store).read(subject);
    if (!expected.some(s => s.key === alias.key)) expected.push(alias);
    writes.push({...alias, refreshToken, owner:owned.key, subject});
  }
  if (!await atomic(store).compare(expected, writes)) throw stale();
}

/** Return only credentials removed by this exact atomic generation check. */
export async function disconnectOwnerGoogleGrant(store: RefreshTokenStore, identity: {uid: string; googleSub: string}) {
  const state = await ownerGoogleGrantState(store, identity);
  // Fence a pending first legacy consent too: absence is not a reason to omit
  // the verified, unclaimed subject's tombstone. Never touch a foreign alias.
  const alias = state.legacy && (state.aliasOwned || state.linked && !state.legacy.refreshToken && (!state.legacy.owner || state.legacy.owner === state.owned.key)) ? state.legacy : null;
  const targets = [state.owned, ...(alias ? [alias] : [])];
  // Also stamp the verified owner/subject on genuine legacy-only tombstones,
  // so a NEW cached-client consent can be distinguished from a foreign alias.
  const writes: GrantWrite[] = targets.map(s => ({...s, refreshToken:null, owner:state.owned.key, ...(state.subject ? {subject:state.subject} : {})}));
  writes.push({...state.binding,refreshToken:null});
  if (!await atomic(store).compare(state.expected, writes)) throw stale();
  return [...new Set(targets.map(s => s.refreshToken).filter((t): t is string => Boolean(t)))];
}

/** invalid_grant must not leave the very same credential available to adopt
 * again through its owned alias, nor clear a newer callback's generation. */
export async function invalidateOwnerGoogleGrant(store: RefreshTokenStore, identity: {uid:string;googleSub:string}, attempted: GrantSnapshot) {
  const state = await ownerGoogleGrantState(store,identity);
  const current = state.expected.find(s => s.key === attempted.key);
  if (!current || current.version !== attempted.version) return false;
  const targets = [current];
  if (current.key === state.owned.key && state.aliasOwned && state.legacy?.refreshToken === attempted.refreshToken) targets.push(state.legacy);
  if (current.key !== state.owned.key && !state.owned.refreshToken) targets.push(state.owned);
  return atomic(store).compare(state.expected,targets.map(s => ({...s,refreshToken:null,owner:state.owned.key,...(state.subject ? {subject:state.subject} : {})})));
}

/** Opaque worker/MCP keys stay compatible; revoked UID keys cannot fall back. */
export async function resolveOwnerGoogleKey(identity: {uid: string; googleSub: string}, store: RefreshTokenStore = runtimeGrantStore()) {
  const key = uidGrantKey(identity.uid);
  // A failed read/CAS is unavailable, never evidence that a legacy key is safe.
  // Read-only get/set/remove fixtures retain their historical successful seam.
  if (!store.read) return await store.get(key) ? key : identity.googleSub;
  const owned = await store.read(key);
  if (owned.refreshToken || !rawSubject(identity.googleSub)) return owned.version || owned.refreshToken ? key : identity.googleSub;
  const grant = await ownerGoogleGrant(store, identity);
  // No eligible alias (including a foreign owner) cannot authorize raw fallback.
  return grant?.key || key;
}
export async function ownerGoogleGrantKeys(store: RefreshTokenStore, identity: {uid: string; googleSub: string}) {
  const s = await ownerGoogleGrantState(store, identity);
  return [s.owned.key, ...(s.aliasOwned && s.legacy ? [s.legacy.key] : [])];
}

function storeWithCompatibility(read: (key:string)=>Promise<GrantSnapshot>, compare:(expected:GrantSnapshot[],writes:GrantWrite[])=>Promise<boolean>): RefreshTokenStore {
  const change = async (key:string, refreshToken:string|null) => {
    for (let attempt=0; attempt<8; attempt++) {
      const before = await read(key);
      if (await compare([before], [{...before,refreshToken}])) return;
    }
    throw stale();
  };
  return {read, compare, get:async key => (await read(key)).refreshToken, set:(key,token)=>change(key,token), remove:key=>change(key,null)};
}
function withRevocationCutoff(next: GrantWrite, before?: GrantSnapshot): GrantWrite {
  const revokedAt = Math.max(before?.revokedAt || 0, next.revokedAt || 0, next.refreshToken === null ? Date.now() : 0);
  return {...next, ...(revokedAt ? {revokedAt} : {})};
}
export function memoryStore(): RefreshTokenStore {
  const tokens = new Map<string, GrantSnapshot>();
  const read = async (key:string):Promise<GrantSnapshot> => ({...tokens.get(key) || {key,refreshToken:null,version:null}});
  return storeWithCompatibility(read, async (expected,writes) => {
    if (expected.some(s => (tokens.get(s.key)?.version || null) !== s.version)) return false;
    for (const s of writes) tokens.set(s.key, {...withRevocationCutoff(s,tokens.get(s.key)),version:randomUUID()});
    return true;
  });
}

/** Local dev is one Express process: no await between compare and writes,
 * including separate store instances. Tombstones survive tsx reloads. */
export function fileGrantStore(root = path.resolve(".google-grants")): RefreshTokenStore {
  const file = (key:string) => path.join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
  const readSync = (key:string):GrantSnapshot => {
    try {
      const text=readFileSync(file(key),"utf8");
      const entry=JSON.parse(text);
      return {key,refreshToken:entry.refreshToken ?? null, version:entry.version || createHash("sha256").update(text).digest("hex"), ...(entry.owner ? {owner:entry.owner} : {}), ...(entry.subject ? {subject:entry.subject} : {}), ...(entry.revokedAt ? {revokedAt:entry.revokedAt} : {})};
    } catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {key,refreshToken:null,version:null}; throw error; }
  };
  return storeWithCompatibility(async key=>readSync(key), async (expected,writes)=> {
    if (expected.some(s=>readSync(s.key).version!==s.version)) return false;
    mkdirSync(root,{recursive:true,mode:0o700});
    for (const s of writes) {
      const target=file(s.key); const temporary=`${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary,JSON.stringify({...withRevocationCutoff(s,readSync(s.key)),version:randomUUID()}),{mode:0o600});
      renameSync(temporary,target);
    }
    return true;
  });
}

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/**
 * Fetches an access token for the runtime service account from the metadata
 * server. Deliberately dependency-free: no Admin SDK, no google-auth-library.
 * Off Cloud Run there is no metadata server, so this fails and the caller
 * reports the store as unavailable.
 */
let cached: { token: string; expiresAt: number } | null = null;

export async function serviceAccountToken(
  fetchImpl: typeof fetch,
): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Metadata server returned ${response.status}`);
  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) throw new Error("Metadata server returned no token");
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000,
  };
  return cached.token;
}

/** Refresh tokens in the project's Firestore, written with the runtime identity. */
export function firestoreStore({
  projectId = process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId,
  databaseId = (firebaseConfig as { firestoreDatabaseId?: string })
    .firestoreDatabaseId || "(default)",
  collection = "driveGrants",
  fetchImpl = fetch,
}: {
  projectId?: string;
  databaseId?: string;
  collection?: string;
  fetchImpl?: typeof fetch;
} = {}): RefreshTokenStore {
  const root = `projects/${projectId}/databases/${databaseId}/documents`;
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents`;
  const docUrl = (key: string) => `${base}/${collection}/${encodeURIComponent(key)}`;
  const call = async (url: string, init: RequestInit = {}) => fetchImpl(url, {
    ...init,
    headers: {...init.headers, Authorization: `Bearer ${await serviceAccountToken(fetchImpl)}`, "Content-Type":"application/json"},
    signal: AbortSignal.timeout(10_000),
  });
  const read = async (key: string): Promise<GrantSnapshot> => {
    const response = await call(docUrl(key));
    if (response.status === 404) return {key, refreshToken:null, version:null};
    if (!response.ok) throw Error(`Firestore read failed (${response.status})`);
    const data = await response.json();
    if (!data.updateTime) throw Error("Firestore grant is missing its document version");
    const revokedAt = data.fields?.revokedAt?.timestampValue;
    if (revokedAt && !Number.isFinite(Date.parse(revokedAt))) throw Error("Invalid Google grant revocation cutoff");
    return {key, refreshToken:data.fields?.refreshToken?.stringValue ?? null, version:data.updateTime,
      ...(data.fields?.owner?.stringValue ? {owner:data.fields.owner.stringValue} : {}),
      ...(data.fields?.subject?.stringValue ? {subject:data.fields.subject.stringValue} : {}),
      ...(revokedAt ? {revokedAt:Date.parse(revokedAt)} : {})};
  };
  // Every read dependency participates in the SAME atomic commit, with the
  // native updateTime (or exists:false). No-op writes fence dependencies too.
  const compare = async (expected: GrantSnapshot[], writes: GrantWrite[]) => {
    if (writes.some(s => !expected.some(e => e.key === s.key))) throw Error("Google grant write without precondition");
    const changes = new Map(writes.map(s => [s.key,s]));
    const response = await call(`${base}:commit`, {method:"POST", body:JSON.stringify({writes:expected.map(before => {
      const change = changes.get(before.key);
      const next = change ? withRevocationCutoff(change,before) : before;
      return {
        update:{name:`${root}/${collection}/${before.key}`, fields:{
          refreshToken:next.refreshToken === null ? {nullValue:null} : {stringValue:next.refreshToken},
          ...(next.owner ? {owner:{stringValue:next.owner}} : {}),
          ...(next.subject ? {subject:{stringValue:next.subject}} : {}),
          ...(next.revokedAt ? {revokedAt:{timestampValue:new Date(next.revokedAt).toISOString()}} : {}),
          updatedAt:{timestampValue:new Date().toISOString()},
        }},
        // Native commit time fences flows begun while a revoke commit waits.
        ...(change?.refreshToken === null ? {updateTransforms:[{fieldPath:"revokedAt",setToServerValue:"REQUEST_TIME"}]} : {}),
        currentDocument:before.version ? {updateTime:before.version} : {exists:false},
      };
    })})});
    if ([404,409,412].includes(response.status)) return false;
    if (response.status === 400 && /FAILED_PRECONDITION|ABORTED/.test(await response.clone().text())) return false;
    if (!response.ok) throw Error(`Firestore write failed (${response.status})`);
    return true;
  };
  return storeWithCompatibility(read, compare);
}
