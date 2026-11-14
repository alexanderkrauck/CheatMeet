import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageRecorder } from '../server/usage';
import { fileUsageStore, firestoreUsageStore, memoryUsageStore } from '../server/usage/store';
import type { UsageStart } from '../shared/usage';

const start: UsageStart = { owner: 'alice', operation: 'summary', provider: 'gemini', kind: 'tokens', model: 'unpriced-model', meetingId: 'meeting-1' };
const complete = { state: 'completed' as const, evidence: 'provider' as const, tokens: { input: 10, output: 2, thinking: null, cached: null, total: 12 } };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(['_meeting', '-meeting'])('preserves supported meeting ID %s without broadening event IDs', async meetingId => {
  const recorder = createUsageRecorder(memoryUsageStore());
  const id = await recorder.begin({ ...start, meetingId });
  await recorder.finish('alice', id, complete);
  expect(await recorder.get('alice', id)).toMatchObject({ meetingId, state: 'completed' });
  await expect(recorder.begin(start, meetingId)).rejects.toThrow();
});

it('keeps a stable attempt terminal across duplicate begins and rejects changed owner or start semantics', async () => {
  let now = Date.parse('2026-11-14T12:00:00.000Z');
  const store = memoryUsageStore();
  const recorder = createUsageRecorder(store, { now: () => now });
  const id = await recorder.begin(start, 'stable-attempt');
  await recorder.finish('alice', id, complete);
  const settled = await recorder.get('alice', id);
  now += 60_000;
  expect(await recorder.begin(start, id)).toBe(id);
  expect(await recorder.get('alice', id)).toEqual(settled);
  await expect(recorder.begin({ ...start, owner: 'bob' }, id)).rejects.toThrow();
  await expect(recorder.begin({ ...start, model: 'different-model' }, id)).rejects.toThrow();
  await expect(recorder.begin({ ...start, meetingId: 'different-meeting' }, id)).rejects.toThrow();
  expect(await recorder.get('bob', id)).toBeNull();
  await expect(recorder.finish('bob', id, complete)).rejects.toThrow();
  expect(await recorder.get('alice', id)).toEqual(settled);
});

it('retains known terminal counts when an interrupted receipt arrives later and rejects conflicting final counts', async () => {
  const store = memoryUsageStore();
  const recorder = createUsageRecorder(store);
  const id = await recorder.begin(start);
  await recorder.finish('alice', id, complete);
  const settled = await recorder.get('alice', id);
  await recorder.finish('alice', id, { state: 'unknown', evidence: 'unknown' });
  await recorder.finish('alice', id, complete);
  expect(await recorder.get('alice', id)).toEqual(settled);
  await expect(recorder.finish('alice', id, { ...complete, tokens: { ...complete.tokens, input: 11 } })).rejects.toThrow();
});

it('can settle a pending or interrupted event without fabricating omitted counts', async () => {
  const recorder = createUsageRecorder(memoryUsageStore());
  const id = await recorder.begin(start);
  expect(await recorder.get('alice', id)).toMatchObject({ state: 'pending', evidence: 'unknown', cost: { usd: null } });
  await recorder.finish('alice', id, { state: 'unknown', evidence: 'unknown' });
  expect(await recorder.get('alice', id)).not.toHaveProperty('tokens');
  await recorder.finish('alice', id, { state: 'completed', evidence: 'provider' });
  const event = await recorder.get('alice', id);
  expect(event).toMatchObject({ state: 'completed', cost: { usd: null } });
  expect(event).not.toHaveProperty('audioSeconds');
});

it('projects closed metadata at write and read boundaries and does not retain caller-owned objects', async () => {
  const store = memoryUsageStore();
  const recorder = createUsageRecorder(store);
  const input = { ...start, prompt: 'private prompt', transcript: 'private words', features: [] };
  const id = await recorder.begin(input, 'projection');
  input.features.push('injected-later');
  await recorder.finish('alice', id, { ...complete, summary: 'private summary' } as typeof complete);
  const event = await recorder.get('alice', id);
  expect(event).not.toHaveProperty('prompt');
  expect(event).not.toHaveProperty('transcript');
  expect(event).not.toHaveProperty('summary');
  expect(event!.features).toEqual([]);
  event!.tokens!.input = 999;
  expect((await recorder.get('alice', id))!.tokens!.input).toBe(10);
});

it('serializes concurrent stable begins in private durable files and survives reopening without TTL deletion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cheatmeet-usage-ledger-'));
  roots.push(root);
  const a = createUsageRecorder(fileUsageStore(root));
  const b = createUsageRecorder(fileUsageStore(root));
  expect(await Promise.all([a.begin(start, 'stable'), b.begin(start, 'stable')])).toEqual(['stable', 'stable']);
  await a.finish('alice', 'stable', complete);
  const reopened = createUsageRecorder(fileUsageStore(root));
  expect(await reopened.get('alice', 'stable')).toMatchObject({ state: 'completed', tokens: complete.tokens });
  const files = (await readdir(root)).filter(name => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  expect((await stat(path.join(root, files[0]))).mode & 0o777).toBe(0o600);
  expect((await stat(root)).mode & 0o777).toBe(0o700);
});

function firestoreFixture() {
  let document: any = null;
  let version = 0;
  let collide = false;
  const requests: { url: string; init: RequestInit; body: any }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: String(url), init, body });
    if (String(url).endsWith(':runQuery')) return Response.json(document ? [{ document }] : []);
    if (init.method === 'PATCH') {
      if (collide) { collide = false; return new Response(null, { status: 412 }); }
      document = { ...body, name: 'projects/fixture/databases/named/documents/usageEvents/durable', updateTime: `2026-11-14T12:00:00.${String(++version).padStart(6, '0')}Z` };
      return Response.json(document);
    }
    return document ? Response.json(document) : new Response(null, { status: 404 });
  });
  const store = () => firestoreUsageStore({ projectId: 'fixture', databaseId: 'named', fetchImpl, token: async () => 'runtime-fixture-only' });
  return { requests, fetchImpl, store, collision: () => { collide = true; },
    normalizeTimestamp: () => { document.fields.startedAt.timestampValue = document.fields.startedAt.timestampValue.replace('.000Z', 'Z'); },
    corruptOwner: () => { document.fields.owner.stringValue = 'bob'; } };
}

it('uses Firestore native CAS, persists real owner/date fields, and reads the exact durable event back', async () => {
  const fixture = firestoreFixture();
  const recorder = createUsageRecorder(fixture.store(), { now: () => Date.parse('2026-11-14T23:30:00.000Z') });
  await recorder.begin(start, 'durable');
  fixture.collision();
  await recorder.finish('alice', 'durable', complete);
  expect(await createUsageRecorder(fixture.store()).get('alice', 'durable')).toMatchObject({ state: 'completed', tokens: complete.tokens });
  const writes = fixture.requests.filter(request => request.init.method === 'PATCH');
  expect(writes[0].url).toContain('currentDocument.exists=false');
  expect(writes[1].url).toContain('currentDocument.updateTime=');
  expect(writes).toHaveLength(3);
  expect(writes.at(-1)!.body.fields).toMatchObject({ owner: { stringValue: 'alice' }, accountingDate: { stringValue: '2026-11-15' }, startedAt: { timestampValue: '2026-11-14T23:30:00.000Z' } });
  expect(writes.at(-1)!.body.fields).not.toHaveProperty('expireAt');
});

it('sends bounded indexed Firestore owner/date filters and a native exclusive pagination cursor', async () => {
  const fixture = firestoreFixture();
  const store = fixture.store();
  await store.query({ owner: 'alice', start: '2026-10-25', end: '2026-10-26', limit: 250, after: { date: '2026-10-25', id: 'previous' } });
  const query = fixture.requests[0].body.structuredQuery;
  expect(query.from).toEqual([{ collectionId: 'usageEvents' }]);
  expect(query.limit).toBe(251);
  expect(query.where.compositeFilter.op).toBe('AND');
  expect(query.where.compositeFilter.filters).toEqual([
    { fieldFilter: { field: { fieldPath: 'owner' }, op: 'EQUAL', value: { stringValue: 'alice' } } },
    { fieldFilter: { field: { fieldPath: 'accountingDate' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2026-10-25' } } },
    { fieldFilter: { field: { fieldPath: 'accountingDate' }, op: 'LESS_THAN', value: { stringValue: '2026-10-26' } } },
  ]);
  expect(query.orderBy).toEqual([{ field: { fieldPath: 'accountingDate' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }]);
  expect(query.startAt).toEqual({ before: false, values: [{ stringValue: '2026-10-25' }, { referenceValue: 'projects/fixture/databases/named/documents/usageEvents/previous' }] });
  await store.trackingSince('alice');
  const first = fixture.requests.at(-1)!.body.structuredQuery;
  expect(first.limit).toBe(1);
  expect(first.where.fieldFilter.value.stringValue).toBe('alice');
  expect(first.orderBy[0].field.fieldPath).toBe('startedAt');
});

it('bounds every store query, filters owner and Vienna day before paginating, and never silently truncates', async () => {
  const store = memoryUsageStore();
  for (let n = 0; n < 6; n++) {
    const recorder = createUsageRecorder(store, { now: () => Date.parse(n === 5 ? '2026-10-24T21:59:59.000Z' : '2026-10-24T22:30:00.000Z') });
    await recorder.begin({ ...start, owner: n === 4 ? 'bob' : 'alice' }, `attempt-${n}`);
  }
  const first = await store.query({ owner: 'alice', start: '2026-10-25', end: '2026-10-26', limit: 2 });
  expect(first.events.map(event => event.id)).toEqual(['attempt-0', 'attempt-1']);
  expect(first.next).toEqual({ date: '2026-10-25', id: 'attempt-1' });
  const second = await store.query({ owner: 'alice', start: '2026-10-25', end: '2026-10-26', limit: 2, after: first.next! });
  expect(second.events.map(event => event.id)).toEqual(['attempt-2', 'attempt-3']);
  expect(second.next).toBeNull();
  await expect(store.query({ start: '2026-10-25', end: '2026-10-26', limit: 0 })).rejects.toThrow();
  await expect(store.query({ start: '2026-10-25', end: '2026-10-26', limit: 501 })).rejects.toThrow();
});

it('accepts Firestore canonical timestamps with omitted zero fractions without corrupting the original event timestamp', async () => {
  const fixture = firestoreFixture();
  const recorder = createUsageRecorder(fixture.store(), { now: () => Date.parse('2026-11-14T12:00:00.000Z') });
  await recorder.begin(start, 'durable');
  fixture.normalizeTimestamp();
  expect(await recorder.get('alice', 'durable')).toMatchObject({ startedAt: '2026-11-14T12:00:00.000Z' });
  await recorder.finish('alice', 'durable', complete);
  expect(await recorder.get('alice', 'durable')).toMatchObject({ state: 'completed' });
  fixture.corruptOwner();
  await expect(recorder.get('alice', 'durable')).rejects.toThrow();
  await expect(recorder.begin(start, 'durable')).rejects.toThrow();
});

it('never falls back to empty or in-memory success after Firestore read/write/query failures', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
  const store = firestoreUsageStore({ projectId: 'fixture', databaseId: 'named', fetchImpl, token: async () => 'runtime-fixture-only' });
  await expect(store.get('missing')).rejects.toThrow();
  await expect(createUsageRecorder(store).begin(start)).rejects.toThrow();
  await expect(store.query({ owner: 'alice', start: '2026-11-14', end: '2026-11-15', limit: 250 })).rejects.toThrow();
  await expect(store.trackingSince('alice')).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

it('bounds native CAS contention without weakening its create precondition', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init: RequestInit = {}) => new Response(null, { status: init.method === 'PATCH' ? 409 : 404 }));
  const store = firestoreUsageStore({ projectId: 'fixture', databaseId: 'named', fetchImpl, token: async () => 'runtime-fixture-only' });
  await expect(createUsageRecorder(store).begin(start, 'contended')).rejects.toThrow();
  const writes = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH');
  expect(writes).toHaveLength(8);
  expect(writes.every(([url]) => String(url).includes('currentDocument.exists=false'))).toBe(true);
});

it.each([
  { ...start, owner: '' }, { ...start, meetingId: '../private' },
  { ...start, model: 'https://provider.test?key=private' }, { ...start, ownerLabel: 'bad\nlabel' },
  { ...start, session: -1 }, { ...start, features: ['prompt with content'] },
])('rejects invalid or content/capability-bearing start metadata without writing: %j', async input => {
  const store = memoryUsageStore();
  const write = vi.spyOn(store, 'mutate');
  await expect(createUsageRecorder(store).begin(input)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});

it.each([
  { ...complete, tokens: { ...complete.tokens, input: -1 } },
  { ...complete, tokens: { ...complete.tokens, input: 1.5 } },
  { ...complete, tokens: { ...complete.tokens, input: Infinity } },
  { ...complete, tokens: { ...complete.tokens, output: NaN } },
  { ...complete, audioSeconds: Infinity }, { ...complete, sessionSeconds: -1 },
  { ...complete, providerRequestId: 'https://provider.test?token=private' },
])('rejects malformed finish counts/identifiers without damaging its pending record: %j', async finish => {
  const recorder = createUsageRecorder(memoryUsageStore());
  const id = await recorder.begin(start);
  const initial = await recorder.get('alice', id);
  await expect(recorder.finish('alice', id, finish)).rejects.toThrow();
  expect(await recorder.get('alice', id)).toEqual(initial);
});

it('canonicalizes development roots before locking concurrent writers and makes an existing root private', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cheatmeet-usage-alias-'));
  roots.push(root);
  await chmod(root, 0o755);
  const a = createUsageRecorder(fileUsageStore(root));
  const b = createUsageRecorder(fileUsageStore(path.relative(process.cwd(), root)));
  const results = await Promise.allSettled([a.begin(start, 'shared-id'), b.begin({ ...start, owner: 'bob' }, 'shared-id')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await stat(root)).mode & 0o777).toBe(0o700);
});
