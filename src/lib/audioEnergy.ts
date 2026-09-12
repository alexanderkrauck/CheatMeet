/**
 * Detects near-silence so a segment carrying no real signal is never sent for
 * transcription. Handed digital silence, the model does not return an empty
 * string -- it invents fluent, confident speech. Verified on a real recording
 * (`3b7c8f25`): a shared tab produced no audio at all, and the system-audio
 * segments came back as six minutes of invented lecture, election results and
 * football scores. Gating removes the input that causes this, rather than
 * asking the model not to do it.
 */

/** RMS level of a PCM buffer in dBFS. True digital silence is -Infinity, not 0. */
export function dbfsOf(samples: Float32Array): number {
  if (!samples.length) return -Infinity;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * Below this, a reading counts as silence. Calibrated against `3b7c8f25`: its
 * shared tab carried no audio, and that stretch measured -50 to -61 dBFS,
 * while the same file's real speech (the microphone, which the same file also
 * carries) never dropped below -44 dBFS even in its quietest, most hesitant
 * moments. -48 sits between the two with margin on both sides, biased toward
 * never cutting real speech: a missed silent segment costs one wasted API
 * call and matches today's shipped behaviour; a dropped real segment loses
 * speech permanently. Derived from one recording/device/browser -- if a
 * different setup's "silence" ever measures louder than this, the gate simply
 * stops filtering it, rather than starting to cut real speech.
 */
export const SILENCE_DBFS = -48;

export function hasSignal(samples: Float32Array, thresholdDb = SILENCE_DBFS): boolean {
  return dbfsOf(samples) > thresholdDb;
}

/** What `segmentHasSignal` needs from a decoded segment. Matches the subset
 * of AudioBuffer it actually reads, so a test can fake one without jsdom. */
export interface DecodedAudio {
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

let decodeContext: AudioContext | undefined;
async function decodeWithWebAudio(buffer: ArrayBuffer): Promise<DecodedAudio> {
  if (typeof AudioContext === "undefined")
    throw new Error("Web Audio is not available");
  decodeContext ??= new AudioContext();
  return decodeContext.decodeAudioData(buffer);
}

/**
 * Decodes a segment's own recorded audio and checks whether any channel ever
 * carried real signal.
 *
 * This decides from the segment's own bytes rather than from a live analyser
 * sampled on a timer, on purpose: a backgrounded tab throttles `setInterval`
 * to once a minute, which is the exact reason segment *boundaries* are
 * decided by `tick()` and not by timers (see segmentCapture.ts) -- a
 * timer-sampled monitor would go blind in the same way. Deciding from the
 * segment's own audio also needs no correlation between a live monitor's
 * wall-clock readings and which segment they belonged to, which is a class of
 * bug in itself once recorders can overlap or be discarded mid-flight.
 *
 * Each segment is independently decodable (segmentCapture.ts gives every
 * segment its own recorder for exactly this reason), so decoding one in
 * isolation is reliable.
 *
 * Any failure -- no Web Audio support, a segment that fails to decode -- fails
 * open. This is a cost and quality safeguard, not a correctness-critical one:
 * failing open reproduces today's shipped behaviour; failing closed could
 * silently drop real speech.
 */
export async function segmentHasSignal(
  segment: Blob,
  decode: (buffer: ArrayBuffer) => Promise<DecodedAudio> = decodeWithWebAudio,
): Promise<boolean> {
  try {
    const audio = await decode(await segment.arrayBuffer());
    for (let channel = 0; channel < audio.numberOfChannels; channel++)
      if (hasSignal(audio.getChannelData(channel))) return true;
    return false;
  } catch (error) {
    console.warn(
      "Could not decode a segment to check for silence; sending it anyway",
      error,
    );
    return true;
  }
}
