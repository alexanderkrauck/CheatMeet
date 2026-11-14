import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UsageEvent } from '../../shared/usage';
import firebaseConfig from '../../firebase-applet-config.json';
import { serviceAccountToken } from '../tokenStore';
import { boundedFetch } from '../processing/budget';

export type UsagePosition = { date: string; id: string };
export type UsageQuery = {
  owner?: string;
  start: string;
  end: string;
  after?: UsagePosition;
  limit: number;
};
export interface UsageStore {
  get(id: string): Promise<UsageEvent | null>;
  /** Atomic CAS; callbacks may run again on contention and must be pure. */
  mutate(id: string, fn: (current: UsageEvent | null) => UsageEvent | undefined): Promise<UsageEvent | null>;
  query(input: UsageQuery): Promise<{ events: UsageEvent[]; next: UsagePosition | null }>;
  trackingSince(owner?: string): Promise<string | null>;
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function usageDate(startedAt: string): string {
  const parts = dateFormatter.formatToParts(new Date(startedAt));
  const part = (kind: string) => parts.find(item => item.type === kind)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
const compare = (a: UsagePosition, b: UsagePosition) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const position = (event: UsageEvent): UsagePosition => ({ date: usageDate(event.startedAt), id: event.id });
const copy = <T>(value: T): T => structuredClone(value);
export function validUsageDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
export function validUsageRange(start: unknown, end: unknown): boolean {
  if (!validUsageDate(start) || !validUsageDate(end)) return false;
  const span = Date.parse(end) - Date.parse(start);
  return Number.isFinite(span) && span > 0 && span <= 32 * 86_400_000;
}
function validateQuery(input: UsageQuery) {
  if (!validUsageRange(input.start, input.end) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500
    || (input.owner !== undefined && (typeof input.owner !== 'string' || !input.owner.length || input.owner.length > 128))
    || (input.after && (typeof input.after.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.after.id)
      || input.after.date < input.start || input.after.date >= input.end || !validUsageDate(input.after.date)))) {
    throw new Error('Ungültige Verbrauchsabfrage.');
  }
}

function page(events: UsageEvent[], input: UsageQuery) {
  validateQuery(input);
  const matching = events.filter(event => {
    const key = position(event);
    return (input.owner === undefined || input.owner === event.owner)
      && key.date >= input.start && key.date < input.end
      && (!input.after || compare(key, input.after) > 0);
  }).sort((a, b) => compare(position(a), position(b)));
  const selected = matching.slice(0, input.limit);
  return { events: copy(selected), next: matching.length > input.limit ? position(selected.at(-1)!) : null };
}
const earliest = (events: UsageEvent[], owner?: string): string | null =>
  events.filter(event => owner === undefined || event.owner === owner)
    .map(event => event.startedAt).sort()[0] ?? null;

/** Dedicated test/fixture backend. Production never selects this factory. */
export function memoryUsageStore(): UsageStore {
  const events = new Map<string, UsageEvent>();
  return {
    async get(id) { return copy(events.get(id) ?? null); },
    async mutate(id, fn) {
      const before = copy(events.get(id) ?? null);
      const next = fn(before);
      if (next === undefined) return before;
      events.set(id, copy(next));
      return copy(next);
    },
    async query(input) { return page([...events.values()], input); },
    async trackingSince(owner) { return earliest([...events.values()], owner); },
  };
}

// A single local dev process may reopen the same store. This is not a production lock.
const fileChains = new Map<string, Promise<unknown>>();
export function fileUsageStore(root: string): UsageStore {
  root = path.resolve(root);
  const file = (id: string) => path.join(root, `${createHash('sha256').update(id).digest('hex')}.json`);
  const read = async (target: string): Promise<UsageEvent | null> => {
    try { return JSON.parse(await readFile(target, 'utf8')) as UsageEvent; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const all = async () => {
    let names: string[];
    try { names = await readdir(root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const events: UsageEvent[] = [];
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const event = await read(path.join(root, name));
      if (event) events.push(event);
    }
    return events;
  };
  return {
    get: id => read(file(id)),
    mutate(id, fn) {
      const target = file(id);
      const run = (fileChains.get(target) ?? Promise.resolve()).then(async () => {
        const before = await read(target);
        const next = fn(before);
        if (next === undefined) return before;
        await mkdir(root, { recursive: true, mode: 0o700 });
        await chmod(root, 0o700);
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
          await rename(temporary, target);
        } finally { await rm(temporary, { force: true }); }
        return copy(next);
      });
      const chain = run.catch(() => undefined);
      fileChains.set(target, chain);
      void chain.finally(() => { if (fileChains.get(target) === chain) fileChains.delete(target); });
      return run;
    },
    query: async input => { validateQuery(input); return page(await all(), input); },
    trackingSince: async owner => earliest(await all(), owner),
  };
}

export type FirestoreUsageOptions = {
  projectId?: string;
  databaseId?: string;
  fetchImpl?: typeof fetch;
  token?: () => Promise<string>;
};

/** Durable, server-only accounting. No TTL; reads never use an unbounded owner scan. */
export function firestoreUsageStore(options: FirestoreUsageOptions = {}): UsageStore {
  const projectId = options.projectId ?? process.env.FIREBASE_PROJECT_ID ?? firebaseConfig.projectId;
  const databaseId = options.databaseId ?? (firebaseConfig as { firestoreDatabaseId?: string }).firestoreDatabaseId ?? '(default)';
  const fetchImpl = options.fetchImpl ?? boundedFetch;
  const token = options.token ?? (() => serviceAccountToken(fetchImpl));
  const root = `projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents`;
  const base = `https://firestore.googleapis.com/v1/${root}`;
  const name = (id: string) => `${root}/usageEvents/${id}`;
  const url = (id: string) => `${base}/usageEvents/${encodeURIComponent(id)}`;
  const call = async (target: string, init: RequestInit = {}) => fetchImpl(target, {
    ...init, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const parse = (document: any): UsageEvent => {
    const fields = document?.fields;
    if (typeof fields?.json?.stringValue !== 'string') throw new Error('Ungültiger Verbrauchsspeicher.');
    const event = JSON.parse(fields.json.stringValue) as UsageEvent;
    if (!event || typeof event.id !== 'string' || document.name !== name(event.id)
      || event.owner !== fields.owner?.stringValue || Date.parse(event.startedAt) !== Date.parse(fields.startedAt?.timestampValue)
      || usageDate(event.startedAt) !== fields.accountingDate?.stringValue) throw new Error('Ungültiger Verbrauchsspeicher.');
    return event;
  };
  const load = async (id: string) => {
    const response = await call(url(id));
    if (response.status === 404) return { event: null, version: null };
    if (!response.ok) throw new Error(`Verbrauchsspeicher nicht lesbar (${response.status}).`);
    const document = await response.json();
    if (typeof document.updateTime !== 'string' || !document.updateTime) throw new Error('Fehlende Speicherversion.');
    const event = parse(document);
    if (event.id !== id) throw new Error('Ungültige Speicheridentität.');
    return { event, version: document.updateTime as string };
  };
  const runQuery = async (structuredQuery: object): Promise<UsageEvent[]> => {
    const response = await call(`${base}:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery }) });
    if (!response.ok) throw new Error(`Verbrauchsabfrage fehlgeschlagen (${response.status}).`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Ungültige Verbrauchsabfrage.');
    return rows.filter(row => row.document).map(row => parse(row.document));
  };
  const ownerFilter = (owner: string) => ({ fieldFilter: { field: { fieldPath: 'owner' }, op: 'EQUAL', value: { stringValue: owner } } });
  return {
    async get(id) { return (await load(id)).event; },
    async mutate(id, fn) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const { event, version } = await load(id);
        const next = fn(event);
        if (next === undefined) return event;
        const precondition = version ? `currentDocument.updateTime=${encodeURIComponent(version)}` : 'currentDocument.exists=false';
        const response = await call(`${url(id)}?${precondition}`, {
          method: 'PATCH', body: JSON.stringify({ fields: {
            json: { stringValue: JSON.stringify(next) }, owner: { stringValue: next.owner },
            accountingDate: { stringValue: usageDate(next.startedAt) }, startedAt: { timestampValue: next.startedAt },
          } }),
        });
        if (response.ok) return next;
        if (response.status === 409 || response.status === 412
          || (response.status === 400 && /FAILED_PRECONDITION|ABORTED/.test(await response.text()))) continue;
        throw new Error(`Verbrauchsspeicher nicht schreibbar (${response.status}).`);
      }
      throw new Error('Zu viele gleichzeitige Verbrauchsänderungen.');
    },
    async query(input) {
      validateQuery(input);
      const filters: object[] = input.owner === undefined ? [] : [ownerFilter(input.owner)];
      filters.push(
        { fieldFilter: { field: { fieldPath: 'accountingDate' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: input.start } } },
        { fieldFilter: { field: { fieldPath: 'accountingDate' }, op: 'LESS_THAN', value: { stringValue: input.end } } },
      );
      const events = await runQuery({
        from: [{ collectionId: 'usageEvents' }], where: { compositeFilter: { op: 'AND', filters } },
        orderBy: [{ field: { fieldPath: 'accountingDate' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: input.limit + 1,
        ...(input.after ? { startAt: { before: false, values: [{ stringValue: input.after.date }, { referenceValue: name(input.after.id) }] } } : {}),
      });
      if (events.length > input.limit + 1 || events.some(event => (input.owner !== undefined && event.owner !== input.owner)
        || usageDate(event.startedAt) < input.start || usageDate(event.startedAt) >= input.end)) throw new Error('Ungültiger Abfrageumfang.');
      const selected = events.slice(0, input.limit);
      return { events: selected, next: events.length > input.limit ? position(selected.at(-1)!) : null };
    },
    async trackingSince(owner) {
      const events = await runQuery({ from: [{ collectionId: 'usageEvents' }],
        ...(owner !== undefined ? { where: ownerFilter(owner) } : {}),
        orderBy: [{ field: { fieldPath: 'startedAt' }, direction: 'ASCENDING' }], limit: 1,
      });
      if (events.length > 1 || (owner !== undefined && events.some(event => event.owner !== owner))) throw new Error('Ungültiger Abfrageumfang.');
      return events[0]?.startedAt ?? null;
    },
  };
}

export function productionUsageStore(): UsageStore { return firestoreUsageStore(); }
