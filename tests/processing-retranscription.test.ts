import express from 'express';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createProcessingRouter, jobKey, ProcessingError, type ProcessingJob, type ProcessingOptions, type Task } from '../server/processing';
import { memoryDocStore } from '../server/mcp/docStore';
import { createProcessingTranscription } from '../server/processing/runtime';
import { submissionKey, type Submission, type SubmissionStore } from '../server/transcriptionStore';
import { processingActive, processingSourceKey } from '../shared/processing';
import type { ReportData } from '../src/types';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
const original: ReportData = {
  id: 'meeting', date: '2026-11-14T09:00:00Z', updatedAt: '2026-11-14T10:00:00Z',
  title: 'Besprechung', summary: 'Bisherige Zusammenfassung', transcription: 'Gespeichertes Live-Transkript.',
  transcriptionOrigin: 'live', status: 'completed', todos: [], takeaways: [],
  driveFolderId: 'folder', driveReportId: 'json', rawAudioUrl: 'audio',
};
const microsoft: ReportData = {
  ...original, driveFolderId: undefined, driveReportId: undefined, rawAudioUrl: undefined,
  home: { provider: 'microsoft', connectionId: 'connection', driveId: 'b!drive', rootId: 'root', rootName: 'Meetings', folderId: 'folder', reportId: 'json', audioId: 'audio' },
};
const sources = [['Google', original], ['OneDrive', microsoft]] as const;
it('rejects different paid intent when the observed active run finishes before atomic reuse', async () => {
  const f = await setup();
  expect((await f.submit({ analyze: true })).status).toBe(202);
  const get = f.store.get.bind(f.store);
  let queuedAfterCompletion = 0;
  vi.spyOn(f.store, 'get').mockImplementationOnce(async key => {
    const observed = await get(key);
    expect(observed && processingActive(observed)).toBe(true);
    expect((await f.finish()).state).toBe('done');
    queuedAfterCompletion = f.queue.mock.calls.length;
    return observed;
  });
  const requested = await f.submit({ analyze: true, retranscribe: true, regenerate: true });
  expect(requested.status).toBe(409);
  expect(f.queue).toHaveBeenCalledTimes(queuedAfterCompletion);
  expect(f.paidSubmit).not.toHaveBeenCalled();
});
async function setup(initial = original, extra: Partial<ProcessingOptions> = {}) {
  const store = memoryDocStore<ProcessingJob>();
  const reservations = new Map<string, Submission>();
  const submissions: SubmissionStore = {
    get: async key => reservations.get(key) || null,
    reserve: async (key, value) => { if (reservations.has(key)) return false; reservations.set(key, value); return true; },
    retry: async (key, value) => { if (reservations.get(key)?.state !== 'retryable') return false; reservations.set(key, value); return true; },
    set: async (key, value) => { reservations.set(key, value); },
  };
  const paidSubmit = vi.fn();
  const provider = vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/upload')) {
      for await (const _chunk of init!.body as any) { /* consume the actual audio stream */ }
      return Response.json({ upload_url: 'https://provider.invalid/private-upload' });
    }
    if (url.endsWith('/transcript')) {
      paidSubmit(); return Response.json({ id: 'one-final-pass' });
    }
    return Response.json({ status: 'completed', speech_model_used: 'universal-3-5-pro', utterances: [{ speaker: 'A', text: 'Vollständig aus dem Audio.', start: 0, end: 1000 }] });
  });
  const native = createProcessingTranscription({ audio: async () => Readable.from(['fixture audio']) }, { store: submissions, apiKey: 'fixture-only', fetchImpl: provider as typeof fetch });
  const batch = vi.fn(native.batch);
  const retranscription = vi.fn(native.retranscription);
  let source = { report: structuredClone(initial), revision: 'source-1', indexRevision: 'index-1' };
  const artifacts = new Map<string, ReportData>();
  const io = {
    load: vi.fn(async () => structuredClone(source)),
    readCheckpoint: vi.fn(async (job: ProcessingJob, name: string) => artifacts.get(`${job.run}:${name}`) || null),
    checkpoint: vi.fn(async (job: ProcessingJob, name: string, value: ReportData) => { artifacts.set(`${job.run}:${name}`, structuredClone(value)); }),
    export: vi.fn(async (job: ProcessingJob, value: ReportData) => {
      if (job.revision !== source.revision || job.indexRevision !== source.indexRevision) throw new ProcessingError(409, 'Bericht inzwischen geändert.', true);
      source = { ...source, report: structuredClone(value), revision: `${source.revision}-export` };
      return value;
    }),
    publish: vi.fn(async (job: ProcessingJob) => {
      if (job.indexRevision !== source.indexRevision) throw new ProcessingError(409, 'Index inzwischen geändert.', true);
      source.indexRevision += '-publish';
    }),
  };
  const queue = vi.fn(async (_task: Task, _delay?: number) => {});
  const analyze = vi.fn(async (text: string) => ({ title: 'Vorschlag', summary: `Neue Zusammenfassung: ${text}`, transcription: 'Ignored model transcript', todos: [], takeaways: [] }));
  const app = express();
  app.use('/api', createProcessingRouter({
    enabled: () => true, store, io, batch, analyze, enqueue: queue, preferences: async () => '',
    ...{ retranscription },
    identify: async uid => ({ uid, googleSub: uid === 'alice' ? 'grant-alice' : '' }),
    verifyWorker: async token => { if (token !== 'worker') throw Error('not worker'); },
    ...extra,
  }));
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const call = async (path: string, body?: unknown, owner = 'alice', aware = true) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json', ...(aware ? { 'X-CheatMeet-Storage': 'microsoft' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const submit = (options: { analyze: boolean; retranscribe?: boolean; regenerate?: boolean }) => call('/processing/meeting', { report: initial, ...options });
  const tick = async () => call('/processing/worker', queue.mock.calls.at(-1)![0], 'worker');
  const job = () => store.get(jobKey('alice', 'meeting'));
  const finish = async () => {
    for (let n = 0; n < 12 && processingActive((await job())!); n++) expect((await tick()).status).toBe(200);
    return (await job())!;
  };
  return { store, reservations, submissions, provider, paidSubmit, batch, io, queue, analyze, artifacts, call, submit, tick, finish, job,
    source: () => structuredClone(source), edit: (value: Partial<typeof source>) => { source = { ...source, ...value }; } };
}

it.each(sources)('starts a genuine paid full pass after a completed live-only report (%s)', async (_provider, initial) => {
  const h = await setup(initial);
  await h.submit({ analyze: true });
  expect((await h.finish()).state).toBe('done');
  const oldRun = (await h.job())!.run;
  const readable = h.source().report;
  expect(h.paidSubmit).not.toHaveBeenCalled();

  const accepted = await h.submit({ analyze: true, retranscribe: true, regenerate: true });
  expect(accepted.status).toBe(202);
  expect(accepted.body.job.state).toBe('queued');
  expect((await h.job())!.run).not.toBe(oldRun);
  expect(h.source().report).toEqual(readable);
  expect((await h.finish()).state).toBe('done');
  expect(h.paidSubmit).toHaveBeenCalledTimes(1);
  expect(h.source().report.transcription).toContain('Vollständig aus dem Audio.');
  expect(h.source().report.summary).toContain('Vollständig aus dem Audio.');
  expect(h.source().report.transcription).not.toContain('Ignored model transcript');
  expect(h.source().report.summaryNeedsRefresh).toBe(false);
  expect(processingSourceKey(h.source().report)).toBe(processingSourceKey(initial));
});

it.each(['submitted', 'reserved', 'failed'] as const)('rejects a new full pass when its native reservation is %s, without replaying old text', async state => {
  const h = await setup();
  await h.submit({ analyze: true }); await h.finish();
  h.reservations.set(submissionKey('alice', 'meeting:final'), {
    state, languages: ['de'], createdAt: original.date,
    ...(state !== 'reserved' ? { providerId: 'previous-final-pass' } : {}),
  });
  const previous = await h.job(); const readable = h.source().report;
  const queued = h.queue.mock.calls.length;
  const result = await h.submit({ analyze: true, retranscribe: true, regenerate: true });
  expect(result.status).toBe(409);
  expect(result.body.error).toMatch(state === 'reserved' ? /unbestätigt/ : /bereits/);
  expect(await h.job()).toEqual(previous);
  expect(h.queue).toHaveBeenCalledTimes(queued);
  expect(h.source().report).toEqual(readable);
  expect(h.provider).not.toHaveBeenCalled();
});

it.each(sources)('reports source-qualified read-only full-pass eligibility without a processing job (%s)', async (_provider, initial) => {
  const h = await setup(initial);
  const status = () => h.call('/processing/meeting/retranscription-status', { report: initial });
  expect(await status()).toMatchObject({ status: 200, body: { state: 'available', message: expect.any(String) } });
  h.reservations.set(submissionKey('alice', 'meeting:final'), { state: 'reserved', languages: ['de'], createdAt: original.date });
  expect(await status()).toMatchObject({ status: 200, body: { state: 'uncertain' } });
  h.reservations.set(submissionKey('alice', 'meeting:final'), { state: 'submitted', providerId: 'private-provider-id', languages: ['de'], createdAt: original.date });
  expect(await status()).toMatchObject({ status: 200, body: { state: 'used' } });
  expect(JSON.stringify(await status())).not.toContain('private-provider-id');
  expect(h.provider).not.toHaveBeenCalled();
  expect(h.queue).not.toHaveBeenCalled();
  expect(h.io.checkpoint).not.toHaveBeenCalled();
  expect(h.io.export).not.toHaveBeenCalled();
  expect(await h.job()).toBeNull();
});

it.each(sources)('refuses missing or retention-deleted authoritative audio before accepting a paid run (%s)', async (_provider, initial) => {
  const h = await setup(initial);
  for (const removed of [
    { ...initial, rawAudioUrl: undefined, ...(initial.home ? { home: { ...initial.home, audioId: undefined } } : {}) },
    { ...initial, audioDeletedAt: '2026-11-14T11:00:00Z' },
  ]) {
    h.edit({ report: removed });
    expect(await h.call('/processing/meeting/retranscription-status', { report: initial })).toMatchObject({ status: 200, body: { state: 'missing-audio' } });
    const accepted = await h.submit({ analyze: true, retranscribe: true, regenerate: true });
    expect(accepted.status).toBe(422);
    expect(accepted.body.error).toMatch(/Audioaufnahme fehlt/);
  }
  expect(h.provider).not.toHaveBeenCalled();
  expect(h.queue).not.toHaveBeenCalled();
  expect(await h.job()).toBeNull();
});

it('distinguishes an active text-only run from a new paid full-pass intent', async () => {
  const h = await setup();
  await h.submit({ analyze: true, regenerate: true });
  const originalRun = (await h.job())!.run;
  expect(await h.call('/processing/meeting/retranscription-status', { report: original })).toMatchObject({ status: 200, body: { state: 'busy' } });
  const result = await h.submit({ analyze: true, retranscribe: true, regenerate: true });
  expect(result.status).toBe(409);
  expect(result.body.error).toMatch(/verarbeitet|läuft/);
  expect((await h.job())!.run).toBe(originalRun);
  expect(h.queue).toHaveBeenCalledTimes(1);
  expect(h.provider).not.toHaveBeenCalled();
});

it('marks a retained summary stale after full-audio replacement without regeneration', async () => {
  const h = await setup();
  await h.submit({ analyze: true, retranscribe: true });
  expect((await h.finish()).state).toBe('done');
  expect(h.source().report.transcription).toContain('Vollständig aus dem Audio.');
  expect(h.source().report.summary).toBe(original.summary);
  expect(h.source().report.summaryNeedsRefresh).toBe(true);
  expect(h.analyze).not.toHaveBeenCalled();
  expect(h.paidSubmit).toHaveBeenCalledTimes(1);
});

it('starts a new full-pass run rather than resuming an unrelated blocked summary checkpoint', async () => {
  const h = await setup();
  h.analyze.mockRejectedValueOnce(new ProcessingError(422, 'Zusammenfassung abgelehnt.'));
  await h.submit({ analyze: true, regenerate: true });
  expect((await h.finish()).state).toBe('error');
  const previousRun = (await h.job())!.run;
  const accepted = await h.submit({ analyze: true, retranscribe: true, regenerate: true });
  expect(accepted.status).toBe(202);
  expect((await h.job())!.run).not.toBe(previousRun);
  expect((await h.job())!.retranscribe).toBe(true);
  expect((await h.finish()).state).toBe('done');
  expect(h.paidSubmit).toHaveBeenCalledTimes(1);
});

it('resumes its accepted full-pass checkpoints after a blocked export without spending again', async () => {
  const h = await setup();
  h.io.export.mockRejectedValueOnce(new ProcessingError(401, 'Speicher bitte erneut verbinden.', true));
  const options = { analyze: true, retranscribe: true, regenerate: true };
  await h.submit(options);
  expect((await h.finish()).state).toBe('blocked');
  const before = (await h.job())!;
  expect(h.source().report).toEqual(original);
  expect(h.paidSubmit).toHaveBeenCalledTimes(1);
  const accepted = await h.submit(options);
  expect(accepted.status).toBe(202);
  expect((await h.job())!.run).toBe(before.run);
  expect((await h.finish()).state).toBe('done');
  expect(h.source().report.transcription).toContain('Vollständig aus dem Audio.');
  expect(h.analyze).toHaveBeenCalledTimes(1);
  expect(h.paidSubmit).toHaveBeenCalledTimes(1);
});

it('blocks an intervening native reservation instead of presenting another run’s old batch text as new', async () => {
  const h = await setup();
  await h.submit({ analyze: true, retranscribe: true, regenerate: true });
  h.reservations.set(submissionKey('alice', 'meeting:final'), { state: 'submitted', providerId: 'another-run', languages: ['de'], createdAt: original.date });
  expect((await h.finish()).state).toBe('blocked');
  expect(h.source().report).toEqual(original);
  expect(h.provider).not.toHaveBeenCalled();
  expect(h.reservations.get(submissionKey('alice', 'meeting:final'))?.providerId).toBe('another-run');
});

it.each(sources)('reuses accepted active full-pass retries and rejects source drift (%s)', async (_provider, initial) => {
  const h = await setup(initial);
  const options = { analyze: true, retranscribe: true, regenerate: true };
  await h.submit(options);
  const run = (await h.job())!.run;
  expect((await h.submit(options)).status).toBe(202);
  await h.tick(); // the native paid reservation has now been submitted
  expect((await h.submit(options)).status).toBe(202);
  expect((await h.job())!.run).toBe(run);
  const sibling = initial.home ? { ...initial, home: { ...initial.home, rootId: 'different-root' } } : { ...initial, driveReportId: 'different-json' };
  for (const path of ['/processing/meeting', '/processing/meeting/retranscription-status']) {
    expect((await h.call(path, { report: sibling, ...options })).status).toBe(409);
  }
  expect((await h.finish()).state).toBe('done');
  expect(h.paidSubmit).toHaveBeenCalledTimes(1);
  expect((await h.submit(options)).status).toBe(409); // finished is used, not a pretend new pass
});

it.each(sources)('blocks newer edits both before payment and at replacement export (%s)', async (_provider, initial) => {
  for (const stage of ['before-payment', 'export']) {
    const h = await setup(initial);
    const options = { analyze: true, retranscribe: true, regenerate: true };
    await h.submit(options);
    if (stage === 'export') {
      await h.tick(); await h.tick(); await h.tick();
      expect((await h.job())!.step).toBe('export');
    }
    const edited = { ...initial, summary: 'Neuere menschliche Änderung' };
    h.edit({ report: edited, revision: 'human-source', indexRevision: 'human-index' });
    if (stage === 'before-payment') expect((await h.submit(options)).status).toBe(202); // safely reuses, cannot replace the revision
    expect((await h.finish()).state).toBe('blocked');
    expect(h.source().report).toEqual(edited);
    expect(h.paidSubmit).toHaveBeenCalledTimes(stage === 'export' ? 1 : 0);
    expect(h.io.publish).not.toHaveBeenCalled();
  }
});

it('keeps an uncertain full-pass submission closed across owner retry without replacing the readable result', async () => {
  const h = await setup();
  const provider = h.provider.getMockImplementation()!;
  h.provider.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/transcript')) { h.paidSubmit(); throw Error('acknowledgement lost after submission'); }
    return provider(url, init);
  });
  const options = { analyze: true, retranscribe: true, regenerate: true };
  await h.submit(options);
  expect((await h.finish()).state).toBe('blocked');
  const reservation = structuredClone(h.reservations.get(submissionKey('alice', 'meeting:final')));
  expect(reservation?.state).toBe('reserved');
  expect(h.paidSubmit).toHaveBeenCalledTimes(1);
  const before = await h.job(); const enqueued = h.queue.mock.calls.length;
  expect((await h.submit(options)).status).toBe(409);
  expect(await h.job()).toEqual(before);
  expect(h.queue).toHaveBeenCalledTimes(enqueued);
  expect(h.reservations.get(submissionKey('alice', 'meeting:final'))).toEqual(reservation);
  expect(h.paidSubmit).toHaveBeenCalledTimes(1);
  expect(h.source().report).toEqual(original);
});

it('lets explicit summary regeneration bypass completed canonical reuse without consulting or submitting ASR', async () => {
  const h = await setup();
  await h.submit({ analyze: true }); await h.finish();
  const completed = (await h.job())!; const enqueued = h.queue.mock.calls.length;
  expect((await h.submit({ analyze: true })).body.job.state).toBe('done');
  expect(h.queue).toHaveBeenCalledTimes(enqueued);
  // Exercise the other terminal shortcut too: same source revision rather than canonical export.
  h.edit({ revision: completed.revision });
  expect((await h.submit({ analyze: true, regenerate: true })).body.job.state).toBe('queued');
  expect((await h.job())!.run).not.toBe(completed.run);
  expect((await h.finish()).state).toBe('done');
  expect(h.analyze).toHaveBeenCalledWith(original.transcription, '');
  expect(h.source().report.transcription).toBe(original.transcription);
  expect(h.provider).not.toHaveBeenCalled();
  expect(h.reservations.size).toBe(0);
});

it('enforces active intent again inside the native acceptance mutation after a competing enqueue', async () => {
  const h = await setup();
  let release!: () => void;
  h.io.load.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return h.source();
  });
  const pending = h.submit({ analyze: true, retranscribe: true, regenerate: true });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect((await h.submit({ analyze: true, regenerate: true })).status).toBe(202);
  release();
  expect((await pending).status).toBe(409);
  expect((await h.job())!.retranscribe).toBe(false);
  expect(h.queue).toHaveBeenCalledTimes(1);
  expect(h.provider).not.toHaveBeenCalled();
});
