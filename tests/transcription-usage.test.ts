import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createBatchTranscriptionService, createTranscriptionRouter } from '../server/transcription';
import { fileSubmissionStore, submissionKey, type SubmissionStore } from '../server/transcriptionStore';
import type { UsageRecorder } from '../shared/usage';
import * as usage from '../server/usage';
import { fileUsageStore, type UsageStore } from '../server/usage/store';

let root: string, store: SubmissionStore, server: Server | undefined, base: string;
let recorder: UsageRecorder;
const provider = vi.fn();
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cheatmeet-asr-usage-'));
  store = fileSubmissionStore(path.join(root, 'jobs'));
  recorder = {
    begin: vi.fn(async (_input, id) => id || 'live-usage-1'),
    finish: vi.fn(async () => {}),
    get: vi.fn(async () => null),
  };
  provider.mockReset().mockImplementation(async () => Response.json({ token: 'temporary-test-token' }));
});
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const listen = async (tracked = true, verified?: { token: string; owner: string }, ledger?: UsageStore) => {
  const app = express();
  const verifyToken = async (token: string) => {
    if (verified?.token === token) return verified.owner;
    if (!['alice', 'bob'].includes(token)) throw Error();
    return token;
  };
  app.use('/api', createTranscriptionRouter({
    apiKey: 'test-key', store, fetchImpl: provider, ...(tracked ? { usageRecorder: recorder } : {}),
    verifyToken,
  }));
  if (ledger) app.use('/api', usage.createUsageRouter({ store: ledger, recorder, verifyToken, ownerUids: [] }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/transcription`;
};
const token = (body: Record<string, unknown> = {}, identity = 'alice') => fetch(`${base}/token`, {
  method: 'POST', headers: { Authorization: `Bearer ${identity}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ reportId: 'meeting', source: 'mic', session: 0, languages: ['de'], ...body }),
});

it('creates one pending streaming event per issued source token, without claiming the socket began', async () => {
  await listen();
  const response = await token({ storage: 'microsoft', owner: 'bob', ownerLabel: 'untrusted' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ token: 'temporary-test-token', usageId: 'live-usage-1' });
  expect(recorder.begin).toHaveBeenCalledExactlyOnceWith({
    owner: 'alice', meetingId: 'meeting', storage: 'microsoft', operation: 'live-transcription',
    provider: 'assemblyai', kind: 'streaming', model: 'universal-3-5-pro',
    source: 'mic', session: 0, features: ['speaker-labels'],
  });
  expect(recorder.finish).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await token({ storage: 'microsoft' })).status).toBe(409);
  expect(recorder.begin).toHaveBeenCalledTimes(1);
  expect(provider).toHaveBeenCalledTimes(1);
});

const completed = {
  id: 'provider-job', status: 'completed', speech_model_used: 'universal-3-5-pro',
  audio_duration: 65.25, text: 'Ergebnis',
  utterances: [{ start: 0, end: 1000, speaker: 'A', text: 'Ergebnis' }],
};
const batchProvider = () => provider.mockImplementation(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/upload')) {
    for await (const _chunk of init?.body as any) { /* consume the real input stream */ }
    return Response.json({ upload_url: 'https://upload.test/fixture' });
  }
  if (url.endsWith('/transcript')) return Response.json({ id: 'provider-job' });
  return Response.json(completed);
});
const batch = (submissionStore = store) => createBatchTranscriptionService({
  store: submissionStore, apiKey: 'test-key', fetchImpl: provider, usageRecorder: recorder,
});

it('persists the batch event ID before the paid submit and settles that same event after a service restart', async () => {
  batchProvider();
  const original = provider.getMockImplementation()!;
  provider.mockImplementation(async (url, init) => {
    if (url.endsWith('/transcript')) {
      const reserved = await store.get(submissionKey('alice', 'meeting:final'));
      expect(reserved?.state).toBe('reserved');
      expect(typeof reserved?.usageId).toBe('string');
      expect(recorder.begin).toHaveBeenCalledExactlyOnceWith({
        owner: 'alice', meetingId: 'meeting', storage: 'google', operation: 'batch-transcription',
        provider: 'assemblyai', kind: 'batch', model: 'universal-3-5-pro', features: ['speaker-labels'],
      }, reserved!.usageId);
    }
    return original(url, init);
  });
  const service = batch();
  expect(await service.start('alice', 'meeting', ['de'], Readable.from(['audio']))).toEqual({ state: 'processing' });
  const submitted = await store.get(submissionKey('alice', 'meeting:final'));
  const restarted = batch(fileSubmissionStore(path.join(root, 'jobs')));
  expect(await restarted.start('alice', 'meeting', ['de'], Readable.from(['unused']))).toEqual({ state: 'existing' });
  expect(await restarted.poll('alice', 'meeting')).toMatchObject({ state: 'completed', speech: { phase: 'final' } });
  expect(await restarted.poll('alice', 'meeting')).toMatchObject({ state: 'completed' });
  expect(recorder.begin).toHaveBeenCalledTimes(1);
  expect(recorder.finish).toHaveBeenLastCalledWith('alice', submitted!.usageId, {
    state: 'completed', evidence: 'provider', providerRequestId: 'provider-job', audioSeconds: 65.25, modelVersion: 'universal-3-5-pro',
  });
  expect(provider.mock.calls.map(([url]) => url.split('/v2')[1])).toEqual([
    '/upload', '/transcript', '/transcript/provider-job', '/transcript/provider-job',
  ]);
});

it.each([400, 500, 'network', 'missing-id'] as const)(
  'distinguishes explicit rejection from an uncertain paid submission (%s)', async outcome => {
    batchProvider();
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (url, init) => {
      if (!url.endsWith('/transcript')) return original(url, init);
      if (outcome === 'network') throw Error('submission response lost');
      return Response.json(outcome === 'missing-id' ? {} : { error: 'fixture' },
        { status: typeof outcome === 'number' ? outcome : 200 });
    });
    const service = batch();
    await expect(service.start('alice', 'meeting', ['de'], Readable.from(['audio']))).rejects.toThrow();
    const job = await store.get(submissionKey('alice', 'meeting:final'));
    expect(recorder.finish).toHaveBeenLastCalledWith('alice', job!.usageId, {
      state: outcome === 400 ? 'failed' : 'unknown', evidence: outcome === 400 ? 'provider' : 'unknown',
    });
    expect(job?.state).toBe(outcome === 400 ? 'retryable' : 'reserved');
    if (outcome !== 400) {
      expect(await service.start('alice', 'meeting', ['de'], Readable.from(['unused']))).toEqual({ state: 'existing' });
      await expect(service.poll('alice', 'meeting')).rejects.toMatchObject({ status: 409 });
      expect(recorder.begin).toHaveBeenCalledTimes(1);
    } else {
      batchProvider();
      await Promise.all([
        service.start('alice', 'meeting', ['de'], Readable.from(['retry'])),
        service.start('alice', 'meeting', ['de'], Readable.from(['concurrent'])),
      ]);
      expect(recorder.begin).toHaveBeenCalledTimes(2);
      const retry = await store.get(submissionKey('alice', 'meeting:final'));
      expect(retry!.usageId).not.toBe(job!.usageId);
    }
  },
);

it.each(['error-job', 'network', 'http-404'] as const)(
  'settles an existing polled job as uncharged only for an actual provider error job (%s)', async outcome => {
    batchProvider();
    const service = batch();
    await service.start('alice', 'meeting', ['de'], Readable.from(['audio']));
    const job = await store.get(submissionKey('alice', 'meeting:final'));
    vi.mocked(recorder.finish).mockClear();
    if (outcome === 'network') provider.mockRejectedValueOnce(Error('poll unavailable'));
    else provider.mockResolvedValueOnce(Response.json({ status: 'error', error: 'fixture' },
      { status: outcome === 'http-404' ? 404 : 200 }));
    await expect(service.poll('alice', 'meeting')).rejects.toThrow();
    expect(recorder.finish).toHaveBeenCalledExactlyOnceWith('alice', job!.usageId, {
      state: outcome === 'error-job' ? 'failed' : 'unknown',
      evidence: outcome === 'error-job' ? 'provider' : 'unknown', providerRequestId: 'provider-job',
    });
    expect((await store.get(submissionKey('alice', 'meeting:final')))?.state).toBe('submitted');
    expect(await service.start('alice', 'meeting', ['de'], Readable.from(['unused']))).toEqual({ state: 'existing' });
    expect(recorder.begin).toHaveBeenCalledTimes(1);
  },
);

it.each(['saved', 'checkpoint-lost'] as const)(
  'keeps accepted provider identity with unknown duration before polling (%s)', async outcome => {
    batchProvider();
    const native = store;
    const checkpointStore: SubmissionStore = {
      ...native,
      set: async (key, value) => {
        if (outcome === 'checkpoint-lost' && value.state === 'submitted') throw Error('checkpoint unavailable');
        await native.set(key, value);
      },
    };
    const service = batch(checkpointStore);
    const started = service.start('alice', 'meeting', ['de'], Readable.from(['audio']));
    if (outcome === 'checkpoint-lost') await expect(started).rejects.toMatchObject({ failureStage: 'checkpoint' });
    else expect(await started).toEqual({ state: 'processing' });
    const job = await store.get(submissionKey('alice', 'meeting:final'));
    expect(recorder.finish).toHaveBeenLastCalledWith('alice', job!.usageId, {
      state: 'unknown', evidence: 'provider', providerRequestId: 'provider-job',
    });
    expect(job?.state).toBe(outcome === 'checkpoint-lost' ? 'reserved' : 'submitted');
    expect(await service.start('alice', 'meeting', ['de'], Readable.from(['unused']))).toEqual({ state: 'existing' });
    expect(provider.mock.calls.filter(([url]) => url.endsWith('/transcript'))).toHaveLength(1);
  },
);

it('carries the worker-supplied pinned storage and verified label without changing the four-argument default', async () => {
  batchProvider();
  await batch().start('alice', 'meeting', ['de'], Readable.from(['audio']),
    { storage: 'microsoft', ownerLabel: 'Alice (verified)' });
  expect(recorder.begin).toHaveBeenCalledWith({
    owner: 'alice', ownerLabel: 'Alice (verified)', meetingId: 'meeting', storage: 'microsoft',
    operation: 'batch-transcription', provider: 'assemblyai', kind: 'batch',
    model: 'universal-3-5-pro', features: ['speaker-labels'],
  }, expect.any(String));
});

it('uses the production recorder factory by default for both token issuance and worker batch submission', async () => {
  // Synthetic runtime mode only: factory is intercepted before constructing
  // either service, so this never reaches a production store or provider.
  const factory = vi.spyOn(usage, 'getUsageRecorder').mockReturnValue(recorder);
  vi.stubEnv('NODE_ENV', 'production');
  batchProvider();
  const original = provider.getMockImplementation()!;
  provider.mockImplementation(async (url, init) => url.includes('/v3/token')
    ? Response.json({ token: 'temporary-test-token' }) : original(url, init));
  await listen(false);
  expect(await (await token()).json()).toEqual({ token: 'temporary-test-token', usageId: 'live-usage-1' });
  const service = createBatchTranscriptionService({ store, apiKey: 'test-key', fetchImpl: provider });
  await service.start('alice', 'meeting', ['de'], Readable.from(['audio']));
  expect(factory).toHaveBeenCalled();
  expect(recorder.begin).toHaveBeenCalledTimes(2);
});

it.each(['alice', 'bob'] as const)('uses a label only from the same verified bearer subject (%s)', async subject => {
  const identity = `fixture.${Buffer.from(JSON.stringify({ sub: subject, name: 'Alice (verified)' })).toString('base64url')}.fixture`;
  await listen(true, { token: identity, owner: 'alice' });
  expect((await token({ ownerLabel: 'body label' }, identity)).status).toBe(200);
  const start = vi.mocked(recorder.begin).mock.calls[0][0];
  expect(start.owner).toBe('alice');
  expect(start.ownerLabel).toBe(subject === 'alice' ? 'Alice (verified)' : undefined);
});

it('includes the verified request label on the real batch import route', async () => {
  const identity = `fixture.${Buffer.from(JSON.stringify({ sub: 'alice', name: 'Alice (verified)' })).toString('base64url')}.fixture`;
  batchProvider();
  const original = provider.getMockImplementation()!;
  provider.mockImplementation(async (url, init) => url.startsWith('https://www.googleapis.com/drive/')
    ? new Response(new Uint8Array(10)) : original(url, init));
  await listen(true, { token: identity, owner: 'alice' });
  const response = await fetch(`${base}/import/meeting`, {
    method: 'POST', headers: { Authorization: `Bearer ${identity}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ driveFileId: 'fixture-file', driveAccessToken: 'fixture-only', languages: ['de'], ownerLabel: 'body label' }),
  });
  expect(response.status).toBe(202);
  expect(recorder.begin).toHaveBeenCalledWith(expect.objectContaining({
    owner: 'alice', ownerLabel: 'Alice (verified)', meetingId: 'meeting', storage: 'google', kind: 'batch',
  }), expect.any(String));
});

const durableLedger = () => {
  const ledger = fileUsageStore(path.join(root, 'usage'));
  recorder = usage.createUsageRecorder(ledger, { now: () => Date.parse('2026-11-14T12:00:00Z') });
  return ledger;
};
const ledgerPage = (ledger: UsageStore) => ledger.query({
  owner: 'alice', start: '2026-11-14', end: '2026-11-15', limit: 250,
});

it('integrates token issuance and authenticated browser receipts with the real durable ledger', async () => {
  const ledger = durableLedger();
  await listen(true, undefined, ledger);
  const issued = await (await token()).json();
  expect(issued).toEqual({ token: 'temporary-test-token', usageId: expect.any(String) });
  const pending = await recorder.get('alice', issued.usageId);
  expect(pending).toMatchObject({ owner: 'alice', storage: 'google', state: 'pending', evidence: 'unknown',
    source: 'mic', session: 0, features: ['speaker-labels'], cost: { usd: null } });
  expect(pending).not.toHaveProperty('sessionSeconds');
  expect(pending).not.toHaveProperty('audioSeconds');
  const receipt = (body: unknown, owner = 'alice') => fetch(`${base.replace('/transcription', '')}/usage/live/${issued.usageId}`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  expect((await receipt({ stage: 'begin', providerRequestId: 'provider-session' })).status).toBe(204);
  expect(await recorder.get('alice', issued.usageId)).toMatchObject({ state: 'pending', evidence: 'browser',
    providerRequestId: 'provider-session', cost: { usd: null } });
  expect((await receipt({ stage: 'end', sessionSeconds: 12.5, audioSeconds: 2 })).status).toBe(204);
  const terminal = await recorder.get('alice', issued.usageId);
  expect(terminal).toMatchObject({ state: 'completed', evidence: 'browser', sessionSeconds: 12.5, audioSeconds: 2,
    providerRequestId: 'provider-session' });
  expect((await receipt({ stage: 'interrupted' })).status).toBe(204);
  expect((await receipt({ stage: 'begin', providerRequestId: 'provider-session' })).status).toBe(204);
  expect(await recorder.get('alice', issued.usageId)).toEqual(terminal);
  expect((await receipt({ stage: 'end', sessionSeconds: 12.5 }, 'bob')).status).toBe(404);
  expect(await recorder.get('bob', issued.usageId)).toBeNull();
  expect((await token()).status).toBe(409);
  expect((await ledgerPage(ledger)).events).toHaveLength(1);
  expect(provider).toHaveBeenCalledTimes(1); // Receipt/read paths never call AssemblyAI.
});

it('uses a single real durable batch event through repeated polls, restart and a later polling outage', async () => {
  const ledger = durableLedger();
  batchProvider();
  await batch().start('alice', 'meeting', ['de'], Readable.from(['audio']), { storage: 'microsoft' });
  const native = await store.get(submissionKey('alice', 'meeting:final'));
  expect(await recorder.get('alice', native!.usageId!)).toMatchObject({ state: 'unknown', storage: 'microsoft', cost: { usd: null } });
  const restartedRecorder = usage.createUsageRecorder(fileUsageStore(path.join(root, 'usage')));
  const service = createBatchTranscriptionService({ store: fileSubmissionStore(path.join(root, 'jobs')),
    usageRecorder: restartedRecorder, apiKey: 'test-key', fetchImpl: provider });
  for (let n = 0; n < 2; n++) expect(await service.poll('alice', 'meeting')).toMatchObject({ state: 'completed' });
  const terminal = await restartedRecorder.get('alice', native!.usageId!);
  expect(terminal).toMatchObject({ state: 'completed', evidence: 'provider', audioSeconds: 65.25, providerRequestId: 'provider-job' });
  expect(terminal).not.toHaveProperty('sessionSeconds');
  expect(JSON.stringify(terminal)).not.toMatch(/Ergebnis|upload\.test|test-key/);
  provider.mockRejectedValueOnce(Error('later poll outage'));
  await expect(service.poll('alice', 'meeting')).rejects.toThrow('later poll outage');
  expect(await restartedRecorder.get('alice', native!.usageId!)).toEqual(terminal);
  expect((await ledgerPage(ledger)).events).toHaveLength(1);
  expect(provider.mock.calls.filter(([url]) => url.endsWith('/transcript'))).toHaveLength(1);
});

it.each(['unexpected-model', 'unsupported model', null, { name: 'universal-3-5-pro' }])(
  'retains real batch seconds but leaves unsupported reported models unpriced (%j)', async model => {
    const ledger = durableLedger();
    batchProvider();
    const service = batch();
    await service.start('alice', 'meeting', ['de'], Readable.from(['audio']));
    provider.mockResolvedValueOnce(Response.json({ ...completed, speech_model_used: model }));
    if (model === null) await expect(service.poll('alice', 'meeting')).resolves.toMatchObject({ state: 'completed' });
    else await expect(service.poll('alice', 'meeting')).rejects.toThrow();
    const events = (await ledgerPage(ledger)).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: 'completed', evidence: 'provider', audioSeconds: 65.25,
      model: 'universal-3-5-pro', cost: { usd: null } });
    if (model === 'unexpected-model') expect(events[0].modelVersion).toBe(model);
    expect(provider.mock.calls.filter(([url]) => url.endsWith('/transcript'))).toHaveLength(1);
  },
);

it('allocates separate durable events for mic, system and a source reconnect token', async () => {
  const ledger = durableLedger();
  await listen();
  const requests = [{ source: 'mic', session: 0 }, { source: 'system', session: 1 }, { source: 'mic', session: 2 }];
  const issued = await Promise.all(requests.map(async request => (await token(request)).json()));
  expect(new Set(issued.map(value => value.usageId)).size).toBe(3);
  const page = await ledgerPage(ledger);
  expect(page.events).toHaveLength(3);
  for (const [index, request] of requests.entries()) {
    expect(await recorder.get('alice', issued[index].usageId)).toMatchObject({
      ...request, operation: 'live-transcription', state: 'pending', evidence: 'unknown', cost: { usd: null },
    });
  }
  expect((await token(requests[0])).status).toBe(409);
  expect((await ledgerPage(ledger)).events).toHaveLength(3);
  expect(provider).toHaveBeenCalledTimes(3);
});

it.each([
  { body: { storage: null }, identity: 'alice', status: 400 },
  { body: { storage: 'other-provider' }, identity: 'alice', status: 400 },
  { body: {}, identity: 'invalid', status: 401 },
])('does not meter or dispatch a rejected token request ($status)', async ({ body, identity, status }) => {
  await listen();
  expect((await token(body, identity)).status).toBe(status);
  expect(recorder.begin).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
});

it('leaves historical native reservations without usage IDs entirely unmetered', async () => {
  await store.reserve(submissionKey('alice', 'meeting:final'), {
    state: 'submitted', providerId: 'historical-provider-job', languages: ['de'], createdAt: '2025-01-01T00:00:00Z',
  });
  batchProvider();
  const service = batch();
  expect(await service.start('alice', 'meeting', ['de'], Readable.from(['unused']))).toEqual({ state: 'existing' });
  expect(await service.poll('alice', 'meeting')).toMatchObject({ state: 'completed' });
  expect(recorder.begin).not.toHaveBeenCalled();
  expect(recorder.finish).not.toHaveBeenCalled();
  expect((await store.get(submissionKey('alice', 'meeting:final')))?.usageId).toBeUndefined();
  expect(provider).toHaveBeenCalledTimes(1);
});

it('retains a pending real event when settlement fails, without discarding text or submitting again', async () => {
  const ledger = durableLedger();
  const finish = vi.spyOn(recorder, 'finish').mockRejectedValue(Error('private failure detail'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  batchProvider();
  const service = batch();
  expect(await service.start('alice', 'meeting', ['de'], Readable.from(['audio']))).toEqual({ state: 'processing' });
  expect(await service.poll('alice', 'meeting')).toMatchObject({ state: 'completed', speech: { turns: [{ text: 'Ergebnis' }] } });
  const event = (await ledgerPage(ledger)).events[0];
  expect(event).toMatchObject({ state: 'pending', evidence: 'unknown', cost: { usd: null } });
  expect(event).not.toHaveProperty('audioSeconds');
  expect(log.mock.calls.map(([message]) => message)).toEqual([
    JSON.stringify({ event: 'usage_settlement_failure', provider: 'assemblyai' }),
    JSON.stringify({ event: 'usage_settlement_failure', provider: 'assemblyai' }),
  ]);
  finish.mockRestore();
  expect(await service.poll('alice', 'meeting')).toMatchObject({ state: 'completed' });
  expect((await ledgerPage(ledger)).events).toHaveLength(1);
  expect(await recorder.get('alice', event.id)).toMatchObject({ state: 'completed', audioSeconds: 65.25 });
  expect(provider.mock.calls.filter(([url]) => url.endsWith('/transcript'))).toHaveLength(1);
});

it.each(['upload', 'begin'] as const)('does not dispatch paid batch work when %s fails before submit', async stage => {
  batchProvider();
  if (stage === 'upload') provider.mockRejectedValueOnce(Error('upload unavailable'));
  else vi.mocked(recorder.begin).mockRejectedValueOnce(Error('ledger unavailable'));
  const input = Readable.from(['audio']);
  await expect(batch().start('alice', 'meeting', ['de'], input)).rejects.toThrow();
  expect(input.destroyed).toBe(true);
  expect((await store.get(submissionKey('alice', 'meeting:final')))?.state).toBe('retryable');
  expect(provider.mock.calls.filter(([url]) => url.endsWith('/transcript'))).toHaveLength(0);
  expect(recorder.begin).toHaveBeenCalledTimes(stage === 'begin' ? 1 : 0);
  expect(recorder.finish).not.toHaveBeenCalled();
});

it('does not issue an untracked live token when beginning usage fails', async () => {
  vi.mocked(recorder.begin).mockRejectedValueOnce(Error('ledger unavailable'));
  await listen();
  expect((await token()).status).toBe(503);
  expect(provider).not.toHaveBeenCalled();
  expect((await token()).status).toBe(409);
});

it.each([undefined, null, -1, '65', 0])('captures only real numeric audio_duration on an existing completed poll (%s)', async duration => {
  batchProvider();
  const service = batch();
  await service.start('alice', 'meeting', ['de'], Readable.from(['audio']));
  const job = await store.get(submissionKey('alice', 'meeting:final'));
  provider.mockResolvedValueOnce(Response.json({ ...completed, audio_duration: duration }));
  expect(await service.poll('alice', 'meeting')).toMatchObject({ state: 'completed' });
  expect(recorder.finish).toHaveBeenLastCalledWith('alice', job!.usageId, {
    state: 'completed', evidence: 'provider', providerRequestId: 'provider-job', modelVersion: 'universal-3-5-pro', ...(duration === 0 ? { audioSeconds: 0 } : {}),
  });
});

it.each(['model', 'transcript'] as const)('records billed completion before downstream %s validation fails', async failure => {
  batchProvider();
  const service = batch();
  await service.start('alice', 'meeting', ['de'], Readable.from(['audio']));
  provider.mockResolvedValueOnce(Response.json({ ...completed,
    ...(failure === 'model' ? { speech_model_used: 'unexpected-model' } : { utterances: [] }),
  }));
  await expect(service.poll('alice', 'meeting')).rejects.toThrow();
  expect(recorder.finish).toHaveBeenLastCalledWith('alice', expect.any(String), {
    state: 'completed', evidence: 'provider', providerRequestId: 'provider-job', audioSeconds: 65.25,
    modelVersion: failure === 'model' ? 'unexpected-model' : 'universal-3-5-pro',
  });
});

it.each([400, 500, 'network', 'missing-token'] as const)(
  'retains unknown streaming usage when no session can be confirmed after token issuance fails (%s)', async outcome => {
    await listen();
    if (outcome === 'network') provider.mockRejectedValueOnce(Error('token response lost'));
    else provider.mockResolvedValueOnce(Response.json({}, { status: typeof outcome === 'number' ? outcome : 200 }));
    expect((await token()).status).toBe(outcome === 'network' ? 503 : 502);
    expect(recorder.finish).toHaveBeenCalledExactlyOnceWith('alice', 'live-usage-1', {
      state: outcome === 400 ? 'failed' : 'unknown', evidence: outcome === 400 ? 'provider' : 'unknown',
    });
    expect((await token()).status).toBe(409);
    expect(recorder.begin).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
  },
);
