import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageRecorder, createUsageRouter, getUsageRecorder, usageOwnerLabel } from '../server/usage';
import { fileUsageStore, memoryUsageStore, type UsageStore } from '../server/usage/store';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function serve(options: Parameters<typeof createUsageRouter>[0]) {
  const app = express();
  // Production has no global body parser: the router owns its JSON receipts.
  app.use('/api', createUsageRouter(options));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
}
const verifyToken = async (token: string) => {
  if (!['alice', 'bob', 'operator'].includes(token)) throw new Error('invalid fixture identity');
  return token;
};
const headers = (uid = 'alice') => ({ Authorization: `Bearer ${uid}` });

it('reads a settled durable event through the authenticated own-account API after reopening the store', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cheatmeet-usage-router-'));
  roots.push(root);
  const recorder = createUsageRecorder(fileUsageStore(root), { now: () => Date.parse('2026-11-14T12:00:00.000Z') });
  const id = await recorder.begin({ owner: 'alice', operation: 'summary', provider: 'gemini', kind: 'tokens', model: 'not-yet-priced' }, 'attempt-1');
  await recorder.finish('alice', id, { state: 'completed', evidence: 'provider', tokens: { input: 12, output: 3, thinking: null, cached: null, total: 15 } });
  const base = await serve({ store: fileUsageStore(root), verifyToken, ownerUids: [] });
  const response = await fetch(`${base}/usage?start=2026-11-14&end=2026-11-15`, { headers: headers() });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    events: [expect.objectContaining({ id, owner: 'alice', state: 'completed', tokens: { input: 12, output: 3, thinking: null, cached: null, total: 15 }, cost: expect.objectContaining({ usd: null }) })],
    canViewAll: false, scope: 'mine', nextCursor: null,
    trackingSince: '2026-11-14T12:00:00.000Z', historyComplete: false,
  });
  expect((await fetch(`${base}/usage?start=2026-11-14&end=2026-11-15`)).status).toBe(401);
});

it('exposes the default recorder singleton without performing provider or ledger I/O', () => {
  expect(getUsageRecorder()).toBe(getUsageRecorder());
});

it('restricts all-account metadata to exact allowlisted UIDs and rejects owner/scope overrides', async () => {
  const store = memoryUsageStore();
  const recorder = createUsageRecorder(store, { now: () => Date.parse('2026-11-14T12:00:00.000Z') });
  for (const owner of ['alice', 'bob']) await recorder.begin({ owner, operation: 'ask', provider: 'gemini', kind: 'tokens', model: 'gemini-3.8-flash' }, `${owner}-request`);
  const base = await serve({ store, verifyToken, ownerUids: ['operator'] });
  const query = `${base}/usage?start=2026-11-14&end=2026-11-15`;
  const own = await (await fetch(query, { headers: headers() })).json();
  expect(own.events.map((event: any) => event.owner)).toEqual(['alice']);
  expect(own.canViewAll).toBe(false);
  expect((await fetch(`${query}&scope=all`, { headers: headers() })).status).toBe(403);
  expect((await fetch(`${query}&owner=bob`, { headers: headers() })).status).toBe(400);
  expect((await fetch(`${query}&scope=administrator`, { headers: headers('operator') })).status).toBe(400);
  const all = await fetch(`${query}&scope=all`, { headers: headers('operator') });
  expect(all.status).toBe(200);
  expect(await all.json()).toMatchObject({ canViewAll: true, scope: 'all', events: [expect.objectContaining({ owner: 'alice' }), expect.objectContaining({ owner: 'bob' })] });
  const notExact = await serve({ store, verifyToken, ownerUids: ['oper', 'operator@example.test', '*'] });
  expect((await fetch(`${notExact}/usage?start=2026-11-14&end=2026-11-15&scope=all`, { headers: headers('operator') })).status).toBe(403);
});

it.each([
  '', 'start=2026-02-30&end=2026-03-02', 'start=2026-2-01&end=2026-02-02',
  'start=2026-11-14&end=2026-11-14', 'start=2026-11-15&end=2026-11-14',
  'start=2026-11-01&end=2026-12-04', 'start=2026-11-01&end=not-a-date',
  'start=2026-11-14&start=2026-11-13&end=2026-11-15',
  'start=2026-11-14&end=2026-11-15&cursor=not-valid!',
])('rejects invalid civil date/range/cursor input before reading storage: %s', async query => {
  const store = memoryUsageStore();
  const read = vi.spyOn(store, 'query');
  const base = await serve({ store, verifyToken, ownerUids: [] });
  expect((await fetch(`${base}/usage?${query}`, { headers: headers() })).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});

it('paginates all 503 rows without duplicates and binds cursors to identity, scope and exact date filters', async () => {
  const store = memoryUsageStore();
  const recorder = createUsageRecorder(store, { now: () => Date.parse('2026-11-14T23:30:00.000Z') });
  for (let n = 0; n < 503; n++) await recorder.begin({ owner: 'alice', operation: 'ask', provider: 'gemini', kind: 'tokens', model: 'unpriced' }, `page-${String(n).padStart(4, '0')}`);
  await recorder.begin({ owner: 'bob', operation: 'ask', provider: 'gemini', kind: 'tokens', model: 'unpriced' }, 'foreign');
  const base = await serve({ store, verifyToken, ownerUids: ['operator'] });
  const query = `${base}/usage?start=2026-11-15&end=2026-11-16`;
  const events = [];
  let cursor: string | null = null;
  let firstCursor = '';
  const sizes = [];
  do {
    const response = await fetch(`${query}${cursor ? `&cursor=${cursor}` : ''}`, { headers: headers() });
    expect(response.status).toBe(200);
    const data = await response.json();
    sizes.push(data.events.length);
    events.push(...data.events);
    cursor = data.nextCursor;
    if (!firstCursor) firstCursor = cursor!;
  } while (cursor);
  expect(sizes).toEqual([250, 250, 3]);
  expect(new Set(events.map(event => event.id)).size).toBe(503);
  expect(events.every(event => event.owner === 'alice')).toBe(true);
  expect((await fetch(`${query}&cursor=${firstCursor}`, { headers: headers('bob') })).status).toBe(400);
  expect((await fetch(`${query}&scope=all&cursor=${firstCursor}`, { headers: headers('operator') })).status).toBe(400);
  expect((await fetch(`${base}/usage?start=2026-11-14&end=2026-11-16&cursor=${firstCursor}`, { headers: headers() })).status).toBe(400);
});

it('projects stored rows into closed content-free metadata instead of trusting arbitrary persisted input keys', async () => {
  const backing = memoryUsageStore();
  const recorder = createUsageRecorder(backing, { now: () => Date.parse('2026-11-14T12:00:00.000Z') });
  const id = await recorder.begin({ owner: 'alice', operation: 'ask', provider: 'gemini', kind: 'tokens', model: 'unpriced' });
  await backing.mutate(id, current => ({ ...current!, prompt: 'private', transcript: 'private', summary: 'private', tokens: { input: 1, output: null, thinking: null, cached: null, total: null, content: 'private' }, cost: { usd: null, currency: 'USD', secret: 'private' } } as any));
  const base = await serve({ store: backing, verifyToken, ownerUids: [] });
  const response = await fetch(`${base}/usage?start=2026-11-14&end=2026-11-15`, { headers: headers() });
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain('private');
});

it('returns a content-free unavailable response rather than empty success on a failed ledger query', async () => {
  const store: UsageStore = { ...memoryUsageStore(), query: async () => { throw new Error('capability=https://private.test?token=private'); } };
  const base = await serve({ store, verifyToken, ownerUids: [] });
  const response = await fetch(`${base}/usage?start=2026-11-14&end=2026-11-15`, { headers: headers() });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private');
});

it('derives a bounded label only from the same verified bearer subject, never request body or headers', () => {
  const jwt = (payload: object) => `fixture.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  const req = (payload: object) => ({ get: (key: string) => key === 'authorization' ? `Bearer ${jwt(payload)}` : 'body-label', body: { name: 'body-label' } }) as express.Request;
  expect(usageOwnerLabel(req({ sub: 'alice', name: 'Alice Example', email: 'alice@example.test' }), 'alice')).toBe('Alice Example');
  expect(usageOwnerLabel(req({ sub: 'alice', email: 'alice@example.test' }), 'alice')).toBe('alice@example.test');
  expect(usageOwnerLabel(req({ sub: 'bob', name: 'Impostor' }), 'alice')).toBeUndefined();
  expect(usageOwnerLabel(req({ sub: 'alice', name: 'x'.repeat(201) }), 'alice')).toBeUndefined();
  expect(usageOwnerLabel(req({ sub: 'alice', name: 'bad\nlabel' }), 'alice')).toBeUndefined();
});

const liveInput = { owner: 'alice', operation: 'live-transcription' as const, provider: 'assemblyai' as const, kind: 'streaming' as const,
  model: 'universal-3-5-pro', source: 'mic' as const, session: 0, features: ['speaker-labels'] };
async function liveFixture() {
  const store = memoryUsageStore();
  const recorder = createUsageRecorder(store, { now: () => Date.parse('2026-11-14T12:00:00.000Z') });
  const id = await recorder.begin(liveInput, 'live-1');
  const base = await serve({ store, recorder, verifyToken, ownerUids: ['operator'] });
  const receipt = (body: object, uid = 'alice', usageId = id) => fetch(`${base}/usage/live/${usageId}`, {
    method: 'POST', headers: { ...headers(uid), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { store, recorder, id, base, receipt };
}

it('binds an authenticated own streaming session and settles browser-relayed termination counts idempotently', async () => {
  const { recorder, id, receipt } = await liveFixture();
  expect((await receipt({ stage: 'begin', providerRequestId: 'provider-session-1' })).status).toBe(204);
  expect(await recorder.get('alice', id)).toMatchObject({ state: 'pending', evidence: 'browser', providerRequestId: 'provider-session-1', cost: { usd: null } });
  const end = { stage: 'end', providerRequestId: 'provider-session-1', audioSeconds: 80, sessionSeconds: 100 };
  const responses = await Promise.all([receipt(end), receipt(end)]);
  expect(responses.map(response => response.status)).toEqual([204, 204]);
  const final = await recorder.get('alice', id);
  expect(final).toMatchObject({ state: 'completed', evidence: 'browser', audioSeconds: 80, sessionSeconds: 100 });
  expect((await receipt({ ...end, sessionSeconds: 101 })).status).toBe(409);
  expect((await receipt({ ...end, providerRequestId: 'different-session' })).status).toBe(409);
  expect((await receipt({ stage: 'begin', providerRequestId: 'provider-session-1' })).status).toBe(204);
  expect((await receipt({ stage: 'interrupted' })).status).toBe(204);
  expect(await recorder.get('alice', id)).toEqual(final);
});

it('leaves an interrupted or count-less session unpriced and can later accept its actual termination', async () => {
  const { recorder, id, receipt } = await liveFixture();
  expect((await receipt({ stage: 'interrupted' })).status).toBe(204);
  const interrupted = await recorder.get('alice', id);
  expect(interrupted).toMatchObject({ state: 'unknown', cost: { usd: null } });
  expect(interrupted).not.toHaveProperty('sessionSeconds');
  expect((await receipt({ stage: 'end', sessionSeconds: 12 })).status).toBe(204);
  expect(await recorder.get('alice', id)).toMatchObject({ state: 'completed', evidence: 'browser', sessionSeconds: 12 });
  const other = await recorder.begin({ ...liveInput, session: 1 }, 'live-2');
  expect((await receipt({ stage: 'end' }, 'alice', other)).status).toBe(204);
  expect(await recorder.get('alice', other)).toMatchObject({ state: 'completed', evidence: 'browser', cost: { usd: null } });
});

it('rejects unauthenticated, alien, operator-on-alien and nonstreaming receipts without touching the row', async () => {
  const { recorder, id, base, receipt } = await liveFixture();
  const initial = await recorder.get('alice', id);
  for (const uid of ['bad-token', 'bob', 'operator']) expect((await receipt({ stage: 'end', sessionSeconds: 10 }, uid)).status).toBe(uid === 'bad-token' ? 401 : 404);
  expect((await fetch(`${base}/usage/live/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"stage":"end"}' })).status).toBe(401);
  const tokenId = await recorder.begin({ owner: 'alice', operation: 'summary', provider: 'gemini', kind: 'tokens', model: 'gemini-3.8-flash' });
  expect((await receipt({ stage: 'end' }, 'alice', tokenId)).status).toBe(404);
  expect((await receipt({ stage: 'end' }, 'alice', 'missing-id')).status).toBe(404);
  expect(await recorder.get('alice', id)).toEqual(initial);
});

it.each([
  { stage: 'end', owner: 'bob' }, { stage: 'end', model: 'free-model' }, { stage: 'end', cost: { usd: 0 } },
  { stage: 'end', prompt: 'private' }, { stage: 'end', sessionSeconds: -1 }, { stage: 'end', audioSeconds: 10901 },
  { stage: 'end', sessionSeconds: 10901 }, { stage: 'end', sessionSeconds: '10' },
  { stage: 'end', audioSeconds: 20, sessionSeconds: 10 }, { stage: 'end', providerRequestId: 'https://private.test?key=private' },
  { stage: 'begin', sessionSeconds: 1 }, { stage: 'interrupted', audioSeconds: 1 }, { stage: 'invented' }, {}, [],
])('validates the closed receipt schema and bounded consistent durations: %j', async body => {
  const { recorder, id, receipt } = await liveFixture();
  const initial = await recorder.get('alice', id);
  expect((await receipt(body)).status).toBe(400);
  expect(await recorder.get('alice', id)).toEqual(initial);
});

it('handles malformed and oversized receipt JSON within its own route without exposing parser input', async () => {
  const { base, id } = await liveFixture();
  const response = await fetch(`${base}/usage/live/${id}`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: '{"private":' });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('private');
  expect((await fetch(`${base}/usage/live/${id}`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'begin', extra: 'x'.repeat(4096) }) })).status).toBe(413);
});

it('rejects a canonical but impossible civil cursor date before invoking any store query', async () => {
  const store = memoryUsageStore();
  const query = vi.spyOn(store, 'query');
  const base = await serve({ store, verifyToken, ownerUids: [] });
  const cursor = Buffer.from(JSON.stringify({ v: 1, uid: 'alice', scope: 'mine', start: '2026-02-01', end: '2026-03-01', after: { date: '2026-02-30', id: 'valid-id' } })).toString('base64url');
  expect((await fetch(`${base}/usage?start=2026-02-01&end=2026-03-01&cursor=${cursor}`, { headers: headers() })).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it('accepts actual leap dates and an inclusive 32-day maximum while keeping end exclusive', async () => {
  const store = memoryUsageStore();
  const base = await serve({ store, verifyToken, ownerUids: [] });
  for (const range of ['start=2028-02-29&end=2028-03-01', 'start=2026-11-01&end=2026-12-03']) {
    const response = await fetch(`${base}/usage?${range}`, { headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ events: [], trackingSince: null, historyComplete: false, nextCursor: null });
  }
});

it.each(['[]', '{"stage":"end","sessionSeconds":1e309}', '{"stage":"end","sessionSeconds":null}', '{"stage":"end","audioSeconds":null}', '{"stage":"begin","__proto__":{"owner":"bob"}}'])('rejects malformed runtime JSON values without accepting nonfinite counts or extra prototype keys: %s', async body => {
  const { base, id, recorder } = await liveFixture();
  expect((await fetch(`${base}/usage/live/${id}`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body })).status).toBe(400);
  expect(await recorder.get('alice', id)).toMatchObject({ state: 'pending', cost: { usd: null } });
});

it.each(['timestamp', 'source-url', 'oversized-reason'] as const)('fails closed rather than leaking malformed known stored metadata: %s', async poison => {
  const store = memoryUsageStore();
  const recorder = createUsageRecorder(store, { now: () => Date.parse('2026-11-14T12:00:00.000Z') });
  const id = await recorder.begin({ owner: 'alice', operation: 'ask', provider: 'gemini', kind: 'tokens', model: 'unpriced' });
  await store.mutate(id, current => ({ ...current!,
    ...(poison === 'timestamp' ? { updatedAt: 'private meeting content' } : {}),
    cost: { ...current!.cost,
      ...(poison === 'source-url' ? { rateSource: 'https://provider.test?token=private' } : {}),
      ...(poison === 'oversized-reason' ? { reason: `private${'x'.repeat(1000)}` } : {}),
    },
  }));
  const base = await serve({ store, verifyToken, ownerUids: [] });
  const response = await fetch(`${base}/usage?start=2026-11-14&end=2026-11-15`, { headers: headers() });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private');
});
