import type { UsageCost, UsageEvent } from '../../shared/usage';
import { usageDate } from './store';

const CHECKED_AT = '2026-11-14';
const GEMINI_SOURCE = 'https://aistudio.google.com/docs/pricing?generate-content=true';
const ASSEMBLY_BATCH_SOURCE = 'https://www.assemblyai.com/pricing';
const ASSEMBLY_LIVE_SOURCE = 'https://www.assemblyai.com/blog/universal-3-5-pro-realtime';
const ASSEMBLY_BILLING_SOURCE = 'https://www.assemblyai.com/docs/billing-and-pricing.md';
export const USAGE_RATE_SOURCES: readonly string[] = Object.freeze([GEMINI_SOURCE, ASSEMBLY_BATCH_SOURCE, ASSEMBLY_LIVE_SOURCE, ASSEMBLY_BILLING_SOURCE]);
const GEMINI_MODELS = new Set(['gemini-3.7-flash', 'gemini-3.8-flash']);
const unknown = (reason: string): UsageCost => ({ usd: null, currency: 'USD', reason });

/**
 * USD public standard PAYG estimates, excluding credits, discounts, tax, FX and
 * shared infrastructure. Effective dates use the operation's Vienna start day.
 * Exact model IDs only: 3.7 is officially routed to 3.8; unknown versions are not
 * guessed from prefixes. No context-cache storage or grounding fees are invented.
 * This function is called only on settlement, never to reprice ledger reads.
 */
export function priceUsage(event: UsageEvent): UsageCost {
  if (event.state === 'pending' || event.state === 'unknown') return unknown('Verbrauch noch unbekannt.');
  const day = usageDate(event.startedAt);
  if (day < CHECKED_AT) return unknown('Für den Starttag ist kein verifizierter Tarif hinterlegt.');
  if (event.provider === 'assemblyai' && ['streaming', 'batch'].includes(event.kind)) {
    if (event.model !== 'universal-3-5-pro' || (event.modelVersion !== undefined && event.modelVersion !== 'universal-3-5-pro')) return unknown('Kein verifizierter Tarif für dieses Modell.');
    const streaming = event.kind === 'streaming';
    if (!streaming && event.state === 'failed' && event.evidence === 'provider') {
      return { usd: 0, currency: 'USD', rateId: 'assemblyai:batch:provider-confirmed-failed:2026-11-14',
        rateSource: ASSEMBLY_BILLING_SOURCE, rateCheckedAt: CHECKED_AT, reason: 'Vom Provider bestätigte fehlgeschlagene Batch-Transkription: laut Tarif nicht berechnet.' };
    }
    const addOns: Record<string, number> = streaming
      ? { 'speaker-labels': 0.12, prompting: 0.05, 'voice-isolation': 0.10 } : { 'speaker-labels': 0.02 };
    const features = event.features;
    if (!features || features.some(feature => !Object.hasOwn(addOns, feature))) return unknown('Zusatzfunktionen sind nicht vollständig bepreist.');
    const snapshot: UsageCost = { usd: null, currency: 'USD', rateId: `assemblyai:${event.model}:${event.kind}:2026-11-14:${features.join('+') || 'base'}`,
      rateSource: streaming ? ASSEMBLY_LIVE_SOURCE : ASSEMBLY_BATCH_SOURCE, rateCheckedAt: CHECKED_AT };
    const seconds = streaming ? event.sessionSeconds : event.audioSeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || event.evidence === 'unknown' || (!streaming && event.evidence !== 'provider')) return { ...snapshot, reason: 'Abrechenbare Dauer unbekannt oder nicht bestätigt.' };
    const hourly = [...new Set(features)].reduce((rate, feature) => rate + addOns[feature], streaming ? 0.45 : 0.21);
    return { ...snapshot, usd: seconds / 3600 * hourly,
      ...(event.evidence === 'browser' ? { reason: 'Schätzung aus Browser-Relay; nicht serverseitig vom Provider bestätigt.' } : {}) };
  }
  if (event.provider !== 'gemini' || event.kind !== 'tokens') return unknown('Kein verifizierter Tarif für dieses Modell.');
  const model = event.modelVersion ?? event.model;
  if (!GEMINI_MODELS.has(event.model) || !GEMINI_MODELS.has(model)) return unknown('Kein verifizierter Tarif für dieses Modell.');
  const standard = day >= '2027-01-01';
  const rate = standard ? { input: 1.50, cached: 0.15, output: 7.50 } : { input: 0.75, cached: 0.075, output: 3.75 };
  const snapshot: UsageCost = { usd: null, currency: 'USD', rateId: `${model}:standard:${standard ? '2027-01-01' : '2026-11-14'}`, rateSource: GEMINI_SOURCE, rateCheckedAt: CHECKED_AT };
  if (event.features?.length) return { ...snapshot, reason: event.features.includes('audio-input')
    ? 'Audio-Eingabe ohne getrennte Modalitätszählung: Kosten unbekannt.' : 'Zusatzfunktionen sind nicht vollständig bepreist.' };
  const tokens = event.tokens;
  if (event.evidence !== 'provider' || !tokens || [tokens.input, tokens.output, tokens.thinking, tokens.cached].some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
    return { ...snapshot, reason: 'Token-Verbrauch unvollständig oder nicht vom Provider bestätigt.' };
  }
  const sum = tokens.input + tokens.output + tokens.thinking;
  if (!Number.isSafeInteger(sum) || tokens.cached > tokens.input || (tokens.total !== null && tokens.total !== sum)) {
    return { ...snapshot, reason: 'Token-Zählungen widersprüchlich oder mit zusätzlichen unbekannten Anteilen.' };
  }
  return { ...snapshot, usd: ((tokens.input - tokens.cached) * rate.input + tokens.cached * rate.cached + (tokens.output + tokens.thinking) * rate.output) / 1_000_000 };
}
