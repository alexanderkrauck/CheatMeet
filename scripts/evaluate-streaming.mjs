// Explicit, paid evaluation runner. Never imported by the application.
// Usage: node scripts/evaluate-streaming.mjs /absolute/path/to/config.json
// Config contains keyFile, outputDir and cases [{name, pcmFile, sourceOffsetSeconds}].
// PCM must be 16 kHz, signed 16-bit little-endian mono. Each file is sent once.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parse } from 'dotenv';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const apiKey = process.env.ASSEMBLYAI_API_KEY || parse(fs.readFileSync(config.keyFile)).ASSEMBLYAI_API_KEY;
if (!apiKey) throw new Error('AssemblyAI key is not configured');
const base = 'streaming.eu.assemblyai.com';
const pricePerHour = 0.57;
const budget = Math.min(config.budgetUSD ?? 5, 5);
fs.mkdirSync(config.outputDir, { recursive: true, mode: 0o700 });
const ledgerPath = path.join(config.outputDir, 'ledger.json');
const ledger = fs.existsSync(ledgerPath)
  ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  : { budgetUSD: budget, pricePerHour, reservations: [] };
const saveLedger = () => {
  fs.writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  fs.renameSync(`${ledgerPath}.tmp`, ledgerPath);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(test) {
  const speechModel = test.speechModel ?? 'universal-3-5-pro';
  if (!['universal-3-5-pro', 'universal-streaming-multilingual'].includes(speechModel))
    throw new Error('Model is outside this evaluation');
  const pricePerHour = speechModel === 'universal-3-5-pro' ? 0.57 : 0.27;
  if (!/^[a-z0-9-]+$/.test(test.name)) throw new Error('Invalid case name');
  if (ledger.reservations.some(r => r.name === test.name))
    throw new Error(`Case already reserved; refusing automatic replay: ${test.name}`);
  const pcm = fs.readFileSync(test.pcmFile);
  if (!pcm.length || pcm.length % 2) throw new Error('Invalid PCM size');
  const duration = pcm.length / 32000;
  const maxDuration = Math.max(60, Math.ceil(duration + 45));
  if (maxDuration > 10800) throw new Error('Case exceeds session duration limit');
  // Reserve the full token-limited session cost, including an abnormal disconnect.
  // Never refund an uncertain reservation or retry it automatically.
  const reserve = maxDuration / 3600 * pricePerHour;
  if (ledger.reservations.reduce((sum, r) => sum + r.reservedUSD, 0) + reserve > budget)
    throw new Error('Budget would be exceeded');
  const entry = { name: test.name, speechModel, pricePerHour, duration, maxDuration, reservedUSD: reserve, status: 'reserved' };
  ledger.reservations.push(entry);
  saveLedger();

  const tokenParams = new URLSearchParams({ expires_in_seconds: '60', max_session_duration_seconds: String(maxDuration) });
  const response = await fetch(`https://${base}/v3/token?${tokenParams}`, {
    headers: { Authorization: apiKey }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Token request failed: HTTP ${response.status}`);
  const tokenBody = await response.json();
  if (typeof tokenBody.token !== 'string') throw new Error('Token response missing token');
  const parameters = {
    speech_model: speechModel, speaker_labels: 'true',
    sample_rate: '16000', encoding: 'pcm_s16le',
    session_heartbeat: 'true', inactivity_timeout: '20',
  };
  if (speechModel === 'universal-3-5-pro') {
    parameters.mode = 'max_accuracy';
    parameters.continuous_partials = 'true';
  } else {
    parameters.format_turns = 'true';
  }
  if (test.languageCodes) {
    if (speechModel !== 'universal-3-5-pro') throw new Error('Language guidance is only supported for Pro in this evaluation');
    if (!Array.isArray(test.languageCodes) || test.languageCodes.some(code => !['de', 'en'].includes(code)))
      throw new Error('This evaluation only permits the approved German/English guidance');
    parameters.language_codes = JSON.stringify(test.languageCodes);
  }
  const url = new URL(`wss://${base}/v3/ws`);
  url.search = new URLSearchParams({ ...parameters, token: tokenBody.token }).toString();
  const start = performance.now();
  const eventsPath = path.join(config.outputDir, `${test.name}.events.jsonl`);
  const events = [];
  const socket = new WebSocket(url);
  let begun = false, terminated = false, closed = false;
  let sentBytes = 0, terminateAt, beginAt;
  let resolveBegin, rejectBegin, resolveDone, rejectDone;
  const begin = new Promise((resolve, reject) => { resolveBegin = resolve; rejectBegin = reject; });
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Attach handlers immediately so a failed handshake cannot cause an unhandled rejection.
  begin.catch(() => {}); done.catch(() => {});
  const fail = message => { rejectBegin(new Error(message)); rejectDone(new Error(message)); };
  socket.addEventListener('message', event => {
    try {
      const data = JSON.parse(String(event.data));
      const envelope = { receivedMs: performance.now() - start, sentAudioMs: sentBytes / 32, data };
      events.push(envelope);
      fs.appendFileSync(eventsPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
      if (data.type === 'Begin') {
        if (data.configuration?.model !== parameters.speech_model || (parameters.mode && data.configuration?.mode !== parameters.mode)) {
          fail('Applied model/mode did not match; no audio submitted');
          return;
        }
        begun = true;
        beginAt = performance.now();
        resolveBegin();
      } else if (data.type === 'Termination') {
        terminated = true;
        resolveDone();
      } else if (data.type === 'Error') {
        fail(`Provider error code ${data.error_code ?? 'unknown'}; see saved event`);
      }
    } catch { fail('Malformed provider message'); }
  });
  socket.addEventListener('error', () => fail('WebSocket transport failed'));
  socket.addEventListener('close', event => {
    closed = true;
    if (!terminated) fail(`Socket closed before Termination, code ${event.code}`);
  });
  const watchdog = setTimeout(() => {
    fail('Case deadline reached');
    socket.close();
  }, (maxDuration + 10) * 1000);
  const beginTimeout = setTimeout(() => fail('Begin timeout'), 15000);
  try {
    await begin;
    clearTimeout(beginTimeout);
    entry.status = 'streaming'; saveLedger();
    console.log(`${test.name}: streaming ${duration.toFixed(1)}s, cap $${reserve.toFixed(3)}`);
    const blockBytes = 3200;
    let nextProgress = 30;
    for (let offset = 0; offset < pcm.length; offset += blockBytes) {
      if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('Stream interrupted; no replay');
      const due = beginAt + offset / 32;
      await sleep(Math.max(0, due - performance.now()));
      // Avoid catching up in a burst after a machine stall.
      if (performance.now() - due > 1000) throw new Error('Sender stalled; no burst replay');
      let block = pcm.subarray(offset, Math.min(offset + blockBytes, pcm.length));
      if (block.length < 1600) { const padded = Buffer.alloc(1600); block.copy(padded); block = padded; }
      socket.send(block);
      sentBytes += block.length;
      if (offset / 32000 >= nextProgress) {
        console.log(`${test.name}: ${nextProgress}s sent, ${events.filter(e => e.data.type === 'Turn').length} turn updates`);
        nextProgress += 30;
      }
    }
    await sleep(Math.max(0, beginAt + sentBytes / 32 - performance.now()));
    terminateAt = performance.now();
    socket.send(JSON.stringify({ type: 'Terminate' }));
    await done;
    entry.status = 'completed';
  } catch (error) {
    entry.status = 'failed';
    entry.error = error.message;
    throw error;
  } finally {
    clearTimeout(watchdog); clearTimeout(beginTimeout);
    if (socket.readyState === WebSocket.OPEN) {
      if (!terminateAt) socket.send(JSON.stringify({ type: 'Terminate' }));
      socket.close();
    }
    entry.sentAudioSeconds = sentBytes / 32000;
    entry.wallSeconds = (performance.now() - start) / 1000;
    const totals = events.find(e => e.data.type === 'Termination')?.data;
    if (totals) {
      entry.providerTotals = totals;
      entry.estimatedUSD = totals.session_duration_seconds / 3600 * pricePerHour;
    }
    const finalTurns = new Map();
    for (const event of events) {
      const d = event.data;
      if (d.type === 'Turn' && d.end_of_turn) finalTurns.set(d.turn_order, structuredClone(d));
      if (d.type === 'SpeakerRevision') for (const revision of d.revisions || []) {
        const turn = finalTurns.get(revision.turn_order);
        if (turn) {
          turn.speaker_label = revision.speaker_label;
          for (const word of turn.words || []) {
            const revised = revision.words?.find(w => w.start === word.start && w.end === word.end);
            if (revised) word.speaker = revised.speaker;
          }
        }
      }
    }
    const result = {
      test, parameters, endpoint: base, ...entry,
      finalizeMs: terminateAt && terminated ? performance.now() - terminateAt : null,
      turnUpdateCount: events.filter(e => e.data.type === 'Turn').length,
      speakerRevisionCount: events.filter(e => e.data.type === 'SpeakerRevision').length,
      turns: [...finalTurns.values()],
    };
    fs.writeFileSync(path.join(config.outputDir, `${test.name}.result.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
    saveLedger();
    console.log(`${test.name}: ${entry.status}, ${result.turns.length} final turns`);
  }
}

// Sequential sessions make the budget ledger deterministic and prevent overlap.
for (const test of config.cases) await run(test);
