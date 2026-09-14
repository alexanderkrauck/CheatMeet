// Paid synthetic evaluation only. No production imports or meeting registration.
// Usage: node scripts/evaluate-final-batch.mjs CONFIG.json
// Shares the streaming ledger; run sequentially, never alongside another runner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'dotenv';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const output = config.outputDir;
const key = process.env.ASSEMBLYAI_API_KEY || parse(fs.readFileSync(config.keyFile)).ASSEMBLYAI_API_KEY;
if (!key) throw new Error('AssemblyAI key is not configured');
const reference = JSON.parse(fs.readFileSync(path.join(output, 'three-speaker-ground-truth.json'), 'utf8'));
const pcm = fs.readFileSync(path.join(output, 'three-speaker-fresh.pcm'));
const wav = fs.readFileSync(path.join(output, 'three-speaker-fresh.wav'));
// Our generator writes a canonical 44-byte PCM WAV header. Verify exact same audio.
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE'
    || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16
    || wav.toString('ascii', 36, 40) !== 'data' || !wav.subarray(44).equals(pcm)
    || crypto.createHash('sha256').update(pcm).digest('hex') !== reference.pcmSha256)
  throw new Error('WAV does not match the immutable synthetic PCM reference');
const name = 'three-speaker-fresh-batch';
const ledgerPath = path.join(output, 'ledger.json');
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
if (ledger.reservations.some(r => r.name === name)) throw new Error('Already reserved; no automatic resubmission');
const first = ledger.reservations.find(r => r.name === 'three-speaker-fresh-stream');
if (first?.status !== 'completed') throw new Error('Complete the approved streaming pass first');
const duration = pcm.length / 32000;
const pricePerHour = 0.23; // Pro async $0.21 + speaker labels $0.02.
const reservedUSD = (Math.ceil(duration) + 1) / 3600 * pricePerHour;
const budget = Math.min(config.budgetUSD ?? 5, ledger.budgetUSD, 5);
if (!Number.isFinite(budget) || ledger.reservations.reduce((s, r) => s + r.reservedUSD, 0) + reservedUSD > budget)
  throw new Error('Budget would be exceeded');
const entry = { name, kind: 'batch', pcmSha256: reference.pcmSha256, duration, pricePerHour, reservedUSD, status: 'reserved' };
const save = () => {
  fs.writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  fs.renameSync(`${ledgerPath}.tmp`, ledgerPath);
};
ledger.reservations.push(entry); save();
const base = 'https://api.eu.assemblyai.com';
const request = async (endpoint, init = {}) => {
  const res = await fetch(`${base}${endpoint}`, { ...init, headers: { authorization: key, ...init.headers }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`AssemblyAI ${init.method || 'GET'} ${endpoint}: HTTP ${res.status}; no submission retry`);
  return res.json();
};
try {
  const upload = await request('/v2/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: wav });
  entry.status = 'uploaded'; save();
  const parameters = {
    speech_models: ['universal-3-5-pro'], language_detection: true,
    speaker_labels: true, speaker_options: { advanced_speaker_segmentation: true },
    punctuate: true, format_text: true, remove_audio_tags: 'all',
  };
  fs.writeFileSync(path.join(output, `${name}.parameters.json`), JSON.stringify(parameters, null, 2), { mode: 0o600 });
  const started = Date.now();
  entry.status = 'submitting'; save();
  const submitted = await request('/v2/transcript', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio_url: upload.upload_url, ...parameters }) });
  if (typeof submitted.id !== 'string') throw new Error('Submission response missing ID; do not retry');
  entry.transcriptId = submitted.id; entry.status = 'processing'; save();
  console.log(`${name}: submitted once, budget reservation $${reservedUSD.toFixed(4)}`);
  for (;;) {
    const result = await request(`/v2/transcript/${encodeURIComponent(entry.transcriptId)}`);
    if (result.status === 'completed' || result.status === 'error') {
      // Preserve provider evidence locally before cleanup; no text is fed to a summary model.
      fs.writeFileSync(path.join(output, `${name}.provider.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
      entry.status = result.status;
      entry.wallSeconds = (Date.now() - started) / 1000;
      entry.providerAudioSeconds = result.audio_duration;
      if (result.audio_duration != null) entry.estimatedUSD = result.audio_duration / 3600 * pricePerHour;
      save();
      if (result.status === 'error') throw new Error('Provider failed; see saved result. No resubmission');
      await request(`/v2/transcript/${encodeURIComponent(entry.transcriptId)}`, { method: 'DELETE' });
      entry.remoteTranscriptDeleted = true; save();
      console.log(`${name}: completed in ${entry.wallSeconds.toFixed(1)}s, ${result.utterances?.length ?? 0} utterances; remote experiment deleted`);
      break;
    }
    if (Date.now() - started > 10 * 60 * 1000) throw new Error('Polling deadline; resume GET using saved ID, never resubmit');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
} catch (error) {
  entry.error = error.message; save();
  throw error;
}
