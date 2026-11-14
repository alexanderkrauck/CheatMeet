import { afterEach, expect, it, vi } from 'vitest';
import * as analysis from '../server/analysis';
import { runtimeOptions } from '../server/processing/runtime';
import { withProcessingBudget, boundedFetch } from '../server/processing/budget';
import { createUsageRecorder } from '../server/usage';
import { firestoreUsageStore } from '../server/usage/store';
import type { ProcessingJob } from '../server/processing';

const start = Date.parse('2026-11-14T12:00:00Z');
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function accountingFixture(beginCollisions: number) {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  // Native AbortSignal timers are not controlled by Vitest's fake clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Deadline expired', 'TimeoutError')), ms);
    return controller.signal;
  });
  let document: any = null;
  let checkpointAt: number | undefined;
  const delay = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init: RequestInit = {}) => {
    if (String(url) === 'https://checkpoint.test/analyzed') {
      init.signal?.throwIfAborted(); checkpointAt = Date.now() - start;
      return Response.json({ saved: true });
    }
    if (!String(url).startsWith('https://firestore.googleapis.com/')) throw Error('Unexpected network');
    await delay(9_000, init.signal);
    if (init.method !== 'PATCH') return document ? Response.json(document) : new Response(null, { status: 404 });
    if (document || beginCollisions-- > 0) return new Response(null, { status: 412 });
    document = { ...JSON.parse(String(init.body)),
      name: `projects/fixture/databases/named/documents/usageEvents/${decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1)!)}`,
      updateTime: '2026-11-14T12:01:12.000000Z' };
    return Response.json(document);
  }));
  const store = firestoreUsageStore({ projectId: 'fixture', databaseId: 'named', token: async () => 'synthetic-runtime' });
  const recorder = createUsageRecorder(store);
  const generate = vi.fn(async (_request: any) => ({
    text: JSON.stringify({ title: 'Meeting', summary: 'Paid result', todos: [], takeaways: [] }),
    responseId: 'synthetic-response', modelVersion: 'gemini-3.8-flash',
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
  }));
  const original = analysis.analyzeTranscript;
  vi.spyOn(analysis, 'analyzeTranscript').mockImplementation((text, preferences, options) => original(text, preferences, {
    ...options, usage: recorder, createClient: () => ({ models: { generateContent: generate } }) as any,
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const analyze = runtimeOptions().analyze;
  const job = { owner: 'alice', reportId: 'meeting', refs: {} } as ProcessingJob;
  return { generate, analyze, job, delay, checkpointAt: () => checkpointAt,
    event: () => document ? JSON.parse(document.fields.json.stringValue) : null };
}

it('keeps delayed accounting inside the worker deadline and preserves time to checkpoint the paid result', async () => {
  const f = accountingFixture(3);
  const run = withProcessingBudget(200_000, async () => {
    const result = await f.analyze('Transcript', '', f.job);
    await boundedFetch('https://checkpoint.test/analyzed');
    return result;
  }).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(230_000);
  expect(await run).toMatchObject({ value: { summary: 'Paid result' } });
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.generate.mock.calls[0][0].config.httpOptions.timeout).toBe(108_000);
  expect(f.generate.mock.calls[0][0].config.abortSignal).toBeInstanceOf(AbortSignal);
  expect(f.checkpointAt()).toBe(180_000);
  expect(f.event()).toMatchObject({ state: 'pending', evidence: 'unknown', cost: { usd: null } });
});

it('fails closed before paid dispatch when accounting consumes the available analysis window', async () => {
  const f = accountingFixture(6);
  let endedAt: number | undefined;
  const run = withProcessingBudget(200_000, async () => {
    await f.delay(60_000); // Earlier source/archive work in the same dispatch.
    return f.analyze('Transcript', '', f.job);
  }).then(value => ({ value }), error => { endedAt = Date.now() - start; return { error }; });
  await vi.advanceTimersByTimeAsync(400_000);
  expect(await run).toHaveProperty('error');
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.checkpointAt()).toBeUndefined();
  expect(endedAt).toBe(180_000);
  expect(f.event()).toBeNull();
});
