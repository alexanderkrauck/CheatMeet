import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { UsageCost, UsageEvent, UsageFinish, UsageRecorder, UsageStart, UsageTokens } from '../../shared/usage';
import { fileUsageStore, productionUsageStore, validUsageDate, validUsageRange, type UsagePosition, type UsageStore } from './store';
import { priceUsage, USAGE_RATE_SOURCES } from './pricing';

class UsageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const invalid = (): never => { throw new UsageError(400, 'Ungültige Verbrauchsmetadaten.'); };
const conflict = (): never => { throw new UsageError(409, 'Widersprüchlicher Verbrauchseintrag.'); };
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value as string;
}
function identifier(value: unknown, max = 200): string {
  const result = text(value, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) invalid();
  return result;
}
function modelName(value: unknown): string {
  const result = text(value, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result)) invalid();
  return result;
}
function count(value: unknown, integral = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integral && !Number.isSafeInteger(value))) invalid();
  return value as number;
}
function projectStart(input: UsageStart): UsageStart {
  if (!input || !['summary', 'ask', 'insights', 'consent', 'legacy-transcribe', 'legacy-stitch', 'live-transcription', 'batch-transcription'].includes(input.operation)
    || !['gemini', 'assemblyai'].includes(input.provider) || !['tokens', 'streaming', 'batch'].includes(input.kind)) invalid();
  const value: UsageStart = { owner: text(input.owner, 128), operation: input.operation, provider: input.provider, kind: input.kind, model: modelName(input.model) };
  if (input.ownerLabel !== undefined) value.ownerLabel = text(input.ownerLabel, 200);
  if (input.meetingId !== undefined) {
    // Report IDs also allow leading underscore/hyphen; ledger event IDs do not.
    const meetingId = text(input.meetingId, 200);
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/.test(meetingId)) invalid();
    value.meetingId = meetingId;
  }
  if (input.storage !== undefined) {
    if (!['google', 'microsoft'].includes(input.storage)) invalid();
    value.storage = input.storage;
  }
  if (input.source !== undefined) {
    if (!['mic', 'system'].includes(input.source)) invalid();
    value.source = input.source;
  }
  if (input.session !== undefined) value.session = count(input.session, true);
  if (input.features !== undefined) {
    if (!Array.isArray(input.features) || input.features.length > 16) invalid();
    value.features = [...new Set(input.features.map(feature => identifier(feature, 80)))].sort();
  }
  return value;
}
function projectFinish(input: UsageFinish): UsageFinish {
  if (!input || !['completed', 'failed', 'unknown'].includes(input.state) || !['provider', 'browser', 'unknown'].includes(input.evidence)) invalid();
  const value: UsageFinish = { state: input.state, evidence: input.evidence };
  if (input.tokens !== undefined) {
    if (!input.tokens || typeof input.tokens !== 'object' || Array.isArray(input.tokens)) invalid();
    const tokens = {} as UsageTokens;
    for (const key of ['input', 'output', 'thinking', 'cached', 'total'] as const) {
      tokens[key] = input.tokens[key] == null ? null : count(input.tokens[key], true);
    }
    value.tokens = tokens;
  }
  if (input.audioSeconds !== undefined) value.audioSeconds = count(input.audioSeconds);
  if (input.sessionSeconds !== undefined) value.sessionSeconds = count(input.sessionSeconds);
  if (input.providerRequestId !== undefined) value.providerRequestId = identifier(input.providerRequestId);
  if (input.modelVersion !== undefined) value.modelVersion = modelName(input.modelVersion);
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !validUsageDate(value.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || new Date(value).toISOString() !== value) invalid();
  return value as string;
}
function projectEvent(input: UsageEvent): UsageEvent {
  const finish = projectFinish({ ...input, state: input.state === 'pending' ? 'unknown' : input.state });
  if (input.cost?.currency !== 'USD') invalid();
  const cost: UsageCost = { usd: input.cost.usd === null ? null : count(input.cost.usd), currency: 'USD' };
  if (input.cost.rateId !== undefined) {
    cost.rateId = text(input.cost.rateId, 250);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(cost.rateId)) invalid();
  }
  if (input.cost.rateSource !== undefined) {
    if (!USAGE_RATE_SOURCES.includes(input.cost.rateSource)) invalid();
    cost.rateSource = input.cost.rateSource;
  }
  if (input.cost.rateCheckedAt !== undefined) {
    if (!validUsageDate(input.cost.rateCheckedAt)) invalid();
    cost.rateCheckedAt = input.cost.rateCheckedAt;
  }
  if (input.cost.reason !== undefined) cost.reason = text(input.cost.reason, 300);
  return { ...projectStart(input), ...finish, id: identifier(input.id), startedAt: timestamp(input.startedAt),
    updatedAt: timestamp(input.updatedAt), state: input.state, cost };
}
function sameStart(a: UsageStart, b: UsageStart): boolean {
  const { ownerLabel: _a, ...left } = projectStart(a);
  const { ownerLabel: _b, ...right } = projectStart(b);
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createUsageRecorder(store: UsageStore, options: { now?: () => number } = {}): UsageRecorder {
  const now = options.now ?? Date.now;
  return {
    async begin(input, id = randomUUID()) {
      identifier(id);
      const start = projectStart(input);
      const timestamp = new Date(now()).toISOString();
      await store.mutate(id, current => {
        if (current) {
          if (!sameStart(current, start)) conflict();
          return undefined;
        }
        return { ...start, id, startedAt: timestamp, updatedAt: timestamp,
          state: 'pending', evidence: 'unknown', cost: { usd: null, currency: 'USD', reason: 'Verbrauch noch unbekannt.' } };
      });
      return id;
    },
    async finish(owner, id, update) {
      identifier(id);
      const finish = projectFinish(update);
      const timestamp = new Date(now()).toISOString();
      await store.mutate(id, current => {
        if (!current || current.owner !== owner) throw new UsageError(404, 'Verbrauchseintrag nicht gefunden.');
        if (current.providerRequestId && finish.providerRequestId && current.providerRequestId !== finish.providerRequestId) conflict();
        if (current.state === 'completed' || current.state === 'failed') {
          if (finish.state === 'unknown') return undefined;
          const previous = projectFinish(current as UsageEvent & UsageFinish);
          const next = projectFinish({ ...previous, ...finish });
          if (JSON.stringify(previous) !== JSON.stringify(next)) conflict();
          return undefined;
        }
        const next = { ...projectEvent(current), ...finish, updatedAt: timestamp };
        return { ...next, cost: priceUsage(next) };
      });
    },
    async get(owner, id) {
      identifier(id);
      const event = await store.get(id);
      return event?.owner === owner ? projectEvent(event) : null;
    },
  };
}

let defaultStore: UsageStore | undefined;
let defaultRecorder: UsageRecorder | undefined;
function getDefaultStore(): UsageStore {
  return defaultStore ??= process.env.NODE_ENV === 'production'
    ? productionUsageStore() : fileUsageStore(path.resolve('.usage-events'));
}
export function getUsageRecorder(): UsageRecorder {
  return defaultRecorder ??= createUsageRecorder(getDefaultStore());
}

/** Call only after verifying this request's bearer; decoding does not grant authority. */
export function usageOwnerLabel(req: express.Request, verifiedUid: string): string | undefined {
  try {
    const token = bearer(req);
    if (!token || token.length > 16_384) return undefined;
    const parts = token.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return undefined;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (claims?.sub !== verifiedUid) return undefined;
    for (const label of [claims.name, claims.email]) {
      if (typeof label === 'string' && label.trim().length && label.length <= 200 && !/[\u0000-\u001f\u007f]/.test(label)) return label;
    }
  } catch { /* Labels are optional; identity is independently verified. */ }
  return undefined;
}

const bearer = (req: express.Request): string | undefined => /^Bearer (\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
type CursorContext = { uid: string; scope: 'mine' | 'all'; start: string; end: string };
function encodeCursor(context: CursorContext, after: UsagePosition): string {
  return Buffer.from(JSON.stringify({ v: 1, ...context, after })).toString('base64url');
}
function decodeCursor(value: unknown, context: CursorContext): UsagePosition | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2_000 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  try {
    const decoded = Buffer.from(value as string, 'base64url');
    if (decoded.toString('base64url') !== value) invalid();
    const cursor = JSON.parse(decoded.toString('utf8'));
    if (!cursor || Object.keys(cursor).sort().join(',') !== 'after,end,scope,start,uid,v' || cursor.v !== 1
      || cursor.uid !== context.uid || cursor.scope !== context.scope || cursor.start !== context.start || cursor.end !== context.end
      || !cursor.after || Object.keys(cursor.after).sort().join(',') !== 'date,id'
      || typeof cursor.after.date !== 'string' || cursor.after.date < context.start || cursor.after.date >= context.end
      || !validUsageDate(cursor.after.date)) invalid();
    return { date: cursor.after.date, id: identifier(cursor.after.id) };
  } catch { return invalid(); }
}
function unavailable(res: express.Response, error: unknown) {
  res.status(error instanceof UsageError ? error.status : 503).json({
    error: error instanceof UsageError ? error.message : 'Verbrauchsdaten derzeit nicht verfügbar.',
  });
}

type RouterOptions = {
  store?: UsageStore;
  recorder?: UsageRecorder;
  verifyToken?: (token: string) => Promise<string>;
  ownerUids?: string[];
  now?: () => number;
};
export function createUsageRouter(options: RouterOptions = {}) {
  const router = express.Router();
  const store = options.store ?? getDefaultStore();
  const recorder = options.recorder ?? createUsageRecorder(store, { now: options.now });
  const now = options.now ?? Date.now;
  const allowedOwners = new Set(options.ownerUids ?? (process.env.USAGE_OWNER_UIDS ?? '').split(',').map(value => value.trim()).filter(Boolean));
  const verify = options.verifyToken ?? (async (token: string) => (await import('../analysis')).verifyFirebaseToken(token));
  const authenticate = async (req: express.Request, res: express.Response): Promise<string | null> => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const token = bearer(req);
      if (!token || token.length > 16_384) throw new Error('missing');
      return text(await verify(token), 128);
    } catch { res.status(401).json({ error: 'Bitte erneut anmelden.' }); return null; }
  };
  router.get('/usage', async (req, res) => {
    const uid = await authenticate(req, res);
    if (uid === null) return;
    try {
      if (Object.keys(req.query).some(key => !['start', 'end', 'scope', 'cursor'].includes(key))) invalid();
      const { start, end } = req.query;
      if (!validUsageRange(start, end)) invalid();
      const scope = req.query.scope ?? 'mine';
      if (scope !== 'mine' && scope !== 'all') invalid();
      const canViewAll = allowedOwners.has(uid);
      if (scope === 'all' && !canViewAll) throw new UsageError(403, 'Keine Berechtigung für die Gesamtübersicht.');
      const context: CursorContext = { uid, scope: scope as 'mine' | 'all', start: start as string, end: end as string };
      const after = decodeCursor(req.query.cursor, context);
      const owner = scope === 'mine' ? uid : undefined;
      const [result, trackingSince] = await Promise.all([
        store.query({ owner, start: context.start, end: context.end, after, limit: 250 }), store.trackingSince(owner),
      ]);
      let events: UsageEvent[];
      try {
        events = result.events.map(projectEvent);
        if (trackingSince !== null) timestamp(trackingSince);
      } catch { throw new Error('Ungültiger Verbrauchsspeicher.'); }
      // Filters are always reconstructed from verified identity, never granted by a cursor.
      if (events.some(event => owner !== undefined && event.owner !== owner)) throw new Error('Abfrageumfang');
      res.json({ events, canViewAll, scope, nextCursor: result.next ? encodeCursor(context, result.next) : null,
        trackingSince, historyComplete: false });
    } catch (error) { unavailable(res, error); }
  });
  router.post('/usage/live/:id', async (req, res, next) => {
    const uid = await authenticate(req, res);
    if (uid !== null) { res.locals.usageUid = uid; next(); }
  }, express.json({ limit: '2kb' }), async (req, res) => {
    try {
      const uid = res.locals.usageUid as string;
      const id = identifier(req.params.id);
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['stage', 'providerRequestId', 'audioSeconds', 'sessionSeconds'].includes(key))
        || !['begin', 'end', 'interrupted'].includes(body.stage)) invalid();
      const providerRequestId = body.providerRequestId === undefined ? undefined : identifier(body.providerRequestId);
      const audioSeconds = body.audioSeconds === undefined ? undefined : count(body.audioSeconds);
      const sessionSeconds = body.sessionSeconds === undefined ? undefined : count(body.sessionSeconds);
      if ((audioSeconds !== undefined && audioSeconds > 10_900) || (sessionSeconds !== undefined && sessionSeconds > 10_900)
        || (audioSeconds !== undefined && sessionSeconds !== undefined && audioSeconds > sessionSeconds + 2)
        || (body.stage !== 'end' && (audioSeconds !== undefined || sessionSeconds !== undefined))) invalid();
      const streaming = (event: UsageEvent | null): UsageEvent => {
        if (!event || event.owner !== uid || event.provider !== 'assemblyai' || event.kind !== 'streaming' || event.operation !== 'live-transcription') {
          throw new UsageError(404, 'Verbrauchseintrag nicht gefunden.');
        }
        return event;
      };
      if (body.stage === 'begin') {
        const timestamp = new Date(now()).toISOString();
        await store.mutate(id, current => {
          const event = streaming(current);
          if (providerRequestId && event.providerRequestId && event.providerRequestId !== providerRequestId) conflict();
          const next = projectEvent(event);
          if (providerRequestId) next.providerRequestId = providerRequestId;
          if (event.state === 'pending') next.evidence = 'browser';
          if (next.providerRequestId === event.providerRequestId && next.evidence === event.evidence) return undefined;
          // A late Begin may bind identity, but must never reset completed usage or its cost.
          return { ...next, updatedAt: timestamp };
        });
      } else {
        streaming(await recorder.get(uid, id));
        await recorder.finish(uid, id, {
          state: body.stage === 'end' ? 'completed' : 'unknown', evidence: 'browser',
          ...(providerRequestId !== undefined ? { providerRequestId } : {}),
          ...(audioSeconds !== undefined ? { audioSeconds } : {}),
          ...(sessionSeconds !== undefined ? { sessionSeconds } : {}),
        });
      }
      res.status(204).end();
    } catch (error) { unavailable(res, error); }
  });
  router.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // JSON parser errors must not echo user-supplied contents or a stack trace.
    res.setHeader('Cache-Control', 'no-store');
    res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: 'Ungültige Verbrauchsmeldung.' });
  });
  return router;
}
