import { expect, it } from 'vitest';
import { createUsageRecorder } from '../server/usage';
import { memoryUsageStore } from '../server/usage/store';
import type { UsageFinish, UsageStart } from '../shared/usage';

async function settle(input: UsageStart, finish: UsageFinish, startedAt = '2026-11-14T12:00:00.000Z') {
  const recorder = createUsageRecorder(memoryUsageStore(), { now: () => Date.parse(startedAt) });
  const id = await recorder.begin(input);
  await recorder.finish(input.owner, id, finish);
  return (await recorder.get(input.owner, id))!;
}

it('snapshots a verified Gemini rate at settlement, subtracting cached input and adding distinct thinking output', async () => {
  const store = memoryUsageStore();
  const recorder = createUsageRecorder(store, { now: () => Date.parse('2026-11-14T12:00:00.000Z') });
  const id = await recorder.begin({ owner: 'alice', operation: 'summary', provider: 'gemini', kind: 'tokens', model: 'gemini-3.7-flash' });
  await recorder.finish('alice', id, { state: 'completed', evidence: 'provider', modelVersion: 'gemini-3.8-flash',
    tokens: { input: 1_000_000, cached: 200_000, output: 100_000, thinking: 50_000, total: 1_150_000 } });
  const event = await recorder.get('alice', id);
  expect(event!.cost.usd).toBeCloseTo(((1_000_000 - 200_000) * 0.75 + 200_000 * 0.075 + (100_000 + 50_000) * 3.75) / 1_000_000, 12);
  expect(event!.cost).toMatchObject({ currency: 'USD', rateId: 'gemini-3.8-flash:standard:2026-11-14',
    rateSource: 'https://aistudio.google.com/docs/pricing?generate-content=true', rateCheckedAt: '2026-11-14' });
  expect(event!.model).toBe('gemini-3.7-flash');
  expect(event!.modelVersion).toBe('gemini-3.8-flash');
});

it.each(['streaming', 'batch'] as const)('prices actual AssemblyAI %s units including its distinct speaker-labels add-on', async kind => {
  const event = await settle({ owner: 'alice', operation: kind === 'streaming' ? 'live-transcription' : 'batch-transcription', provider: 'assemblyai', kind,
    model: 'universal-3-5-pro', features: ['speaker-labels'] }, { state: 'completed', evidence: kind === 'streaming' ? 'browser' : 'provider', audioSeconds: 1800, sessionSeconds: 3600 });
  const hourly = kind === 'streaming' ? 0.45 + 0.12 : 0.21 + 0.02;
  expect(event.cost.usd).toBeCloseTo(hourly * (kind === 'streaming' ? 3600 : 1800) / 3600, 12);
  expect(event.cost.rateId).toContain(`${kind}:2026-11-14:speaker-labels`);
  expect(event.cost.rateCheckedAt).toBe('2026-11-14');
  expect(event.cost.rateSource).toBe(kind === 'streaming'
    ? 'https://www.assemblyai.com/blog/universal-3-5-pro-realtime' : 'https://www.assemblyai.com/pricing');
  if (kind === 'streaming') expect(event.evidence).toBe('browser');
});

const gemini: UsageStart = { owner: 'alice', operation: 'summary', provider: 'gemini', kind: 'tokens', model: 'gemini-3.8-flash' };
const tokenFinish: UsageFinish = { state: 'completed', evidence: 'provider', tokens: { input: 1000, output: 100, thinking: 20, cached: 0, total: 1120 } };
const batch: UsageStart = { owner: 'alice', operation: 'batch-transcription', provider: 'assemblyai', kind: 'batch', model: 'universal-3-5-pro', features: ['speaker-labels'] };
const stream: UsageStart = { ...batch, operation: 'live-transcription', kind: 'streaming' };

it('uses the operation-start Vienna day for the announced 2027 price step, not settlement time', async () => {
  let now = Date.parse('2026-12-31T22:59:59.000Z');
  const store = memoryUsageStore();
  const recorder = createUsageRecorder(store, { now: () => now });
  const old = await recorder.begin(gemini, 'intro');
  now = Date.parse('2027-01-01T12:00:00.000Z');
  await recorder.finish('alice', old, tokenFinish);
  const oldEvent = (await recorder.get('alice', old))!;
  const future = await settle(gemini, tokenFinish, '2026-12-31T23:00:00.000Z');
  expect(future.cost.usd).toBeCloseTo(oldEvent.cost.usd! * 2, 12);
  expect(oldEvent.cost.rateId).toContain('2026-11-14');
  expect(future.cost.rateId).toContain('2027-01-01');
  await store.mutate(old, current => ({ ...current!, cost: { ...current!.cost, usd: 42, rateId: 'fixture-original-snapshot' } }));
  await recorder.finish('alice', old, tokenFinish);
  expect((await recorder.get('alice', old))!.cost).toMatchObject({ usd: 42, rateId: 'fixture-original-snapshot' });
  expect((await store.query({ owner: 'alice', start: '2026-12-31', end: '2027-01-01', limit: 250 })).events[0].cost.usd).toBe(42);
});

it.each(['gemini-3.7-flash', 'gemini-3.8-flash'])('prices only explicitly verified requested model %s without changing it', async model => {
  const event = await settle({ ...gemini, model }, tokenFinish);
  expect(event.cost.usd).toBeCloseTo((1000 * 0.75 + (100 + 20) * 3.75) / 1_000_000, 12);
  expect(event.model).toBe(model);
});

it.each([
  { input: { ...gemini, model: 'gemini-3.8-flash-custom' }, finish: tokenFinish },
  { input: gemini, finish: { ...tokenFinish, modelVersion: 'gemini-4-flash' } },
  { input: { ...gemini, features: ['audio-input'] }, finish: tokenFinish },
  { input: { ...gemini, features: ['grounding'] }, finish: tokenFinish },
  { input: gemini, finish: { ...tokenFinish, evidence: 'browser' as const } },
  { input: gemini, finish: { state: 'completed' as const, evidence: 'provider' as const } },
  { input: gemini, finish: { ...tokenFinish, tokens: { ...tokenFinish.tokens!, cached: 1001 } } },
  { input: gemini, finish: { ...tokenFinish, tokens: { ...tokenFinish.tokens!, total: 1119 } } },
  { input: gemini, finish: { ...tokenFinish, tokens: { ...tokenFinish.tokens!, total: 1121 } } },
])('retains visible counts but declines unsupported model/modality/evidence/inconsistent pricing: %j', async ({ input, finish }) => {
  const event = await settle(input, finish);
  expect(event.cost.usd).toBeNull();
  expect(event.cost.reason).toBeTruthy();
  if (finish.tokens) expect(event.tokens).toEqual(finish.tokens);
});

it.each(['input', 'output', 'thinking', 'cached'] as const)('does not invent zero for missing Gemini %s', async key => {
  const event = await settle(gemini, { ...tokenFinish, tokens: { ...tokenFinish.tokens!, [key]: null } });
  expect(event.cost.usd).toBeNull();
  expect(event.tokens![key]).toBeNull();
});

it('prices known token components without requiring total and distinguishes measured zero from missing usage', async () => {
  const partialTotal = await settle(gemini, { ...tokenFinish, tokens: { ...tokenFinish.tokens!, total: null } });
  expect(partialTotal.cost.usd).toBeCloseTo((1000 * 0.75 + (100 + 20) * 3.75) / 1_000_000, 12);
  const zero = await settle(gemini, { ...tokenFinish, tokens: { input: 0, output: 0, thinking: 0, cached: 0, total: 0 } });
  expect(zero.cost.usd).toBe(0);
  const missing = await settle(gemini, { ...tokenFinish, tokens: { input: null, output: null, thinking: null, cached: null, total: null } });
  expect(missing.cost.usd).toBeNull();
});

it('does not apply newly verified prices to older events', async () => {
  expect((await settle(gemini, tokenFinish, '2026-11-13T12:00:00.000Z')).cost.usd).toBeNull();
  expect((await settle(batch, { state: 'completed', evidence: 'provider', audioSeconds: 3600 }, '2026-11-13T12:00:00.000Z')).cost.usd).toBeNull();
});

it('uses zero only for provider-confirmed failed batch transcripts, not uncertain or browser-reported failures', async () => {
  const confirmed = await settle(batch, { state: 'failed', evidence: 'provider' });
  expect(confirmed.cost.usd).toBe(0);
  expect(confirmed.cost.rateSource).toBe('https://www.assemblyai.com/docs/billing-and-pricing.md');
  const uncertain = await settle(batch, { state: 'unknown', evidence: 'unknown' });
  expect(uncertain.cost.usd).toBeNull();
  const browserFailed = await settle(batch, { state: 'failed', evidence: 'browser', audioSeconds: 3600 });
  expect(browserFailed.cost.usd).toBeNull();
});

it('uses live session time rather than audio time and prices the verified optional live add-ons separately', async () => {
  const event = await settle({ ...stream, features: ['speaker-labels', 'prompting', 'voice-isolation'] }, { state: 'completed', evidence: 'browser', sessionSeconds: 3600, audioSeconds: 100 });
  expect(event.cost.usd).toBeCloseTo(0.45 + 0.12 + 0.05 + 0.10, 12);
  expect((await settle({ ...stream, features: [] }, { state: 'completed', evidence: 'provider', sessionSeconds: 3600 })).cost.usd).toBeCloseTo(0.45, 12);
  expect((await settle({ ...batch, features: [] }, { state: 'completed', evidence: 'provider', audioSeconds: 3600 })).cost.usd).toBeCloseTo(0.21, 12);
});

it.each([
  { input: stream, finish: { state: 'completed', evidence: 'browser', audioSeconds: 0 } },
  { input: batch, finish: { state: 'completed', evidence: 'provider', sessionSeconds: 10 } },
  { input: batch, finish: { state: 'completed', evidence: 'browser', audioSeconds: 10 } },
  { input: { ...stream, features: undefined }, finish: { state: 'completed', evidence: 'provider', sessionSeconds: 10 } },
  { input: { ...stream, features: ['unverified-addon'] }, finish: { state: 'completed', evidence: 'provider', sessionSeconds: 10 } },
  { input: { ...stream, model: 'universal-3-5-pro-preview' }, finish: { state: 'completed', evidence: 'provider', sessionSeconds: 10 } },
  { input: { ...batch }, finish: { state: 'completed', evidence: 'provider', modelVersion: 'universal-other', audioSeconds: 10 } },
] as { input: UsageStart; finish: UsageFinish }[])('does not infer missing ASR duration/features/model pricing: %j', async ({ input, finish }) => {
  expect((await settle(input, finish)).cost.usd).toBeNull();
});
