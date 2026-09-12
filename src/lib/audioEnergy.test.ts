import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type DecodedAudio,
  dbfsOf,
  hasSignal,
  segmentHasSignal,
  SILENCE_DBFS,
} from "./audioEnergy";

/**
 * Real PCM cut from the real `3b7c8f25` recording with ffmpeg (`-ss 35 -t 0.5
 * -ac 1 -ar 16000 -f f32le` / `-ss 99 ...`), not synthesised: 0.5s at 0:35,
 * which is the recording's actual measured silence, and 0.5s at 1:39, its
 * loudest real speech. Loaded as raw float32 PCM so the test exercises the
 * real classification decision (dbfsOf/hasSignal) on real bytes without
 * needing a browser's decodeAudioData, which this Node test process has no
 * access to -- that container/codec layer stays outside what this suite can
 * exercise; only the decision made from decoded samples is what these
 * fixtures verify.
 */
function realPcm(name: string): Float32Array {
  const buffer = readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url));
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

/**
 * Builds a sine wave scaled to hit an exact target dBFS, the way a real PCM
 * buffer at that level looks. Levels below are not synthesised guesses: they
 * are the actual per-second RMS measured (via ffmpeg + a raw PCM scan) on the
 * real `3b7c8f25` recording, whose stored audio is effectively pure
 * microphone (the shared tab it also carries produced no audio at all, so
 * mixing added nothing). -53.8 dBFS is that recording's silence, at 0:35;
 * -15.9 is its loudest real speech, at 1:39; -43.7 is its quietest real
 * speech, at 0:30 -- a hesitant pause, not silence.
 */
function sineAt(dbfs: number, length = 2048): Float32Array {
  const amplitude = 10 ** (dbfs / 20) * Math.SQRT2;
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++)
    samples[i] = amplitude * Math.sin((2 * Math.PI * 40 * i) / length);
  return samples;
}

/** A DecodedAudio backed by fixed channel data, for injecting into segmentHasSignal. */
function decodedAudio(...channels: Float32Array[]): DecodedAudio {
  return {
    numberOfChannels: channels.length,
    getChannelData: (channel) => channels[channel],
  };
}

describe("dbfsOf", () => {
  it("reads a constant buffer's RMS directly", () => {
    // A flat buffer's RMS is its own value, so this checks the formula itself
    // rather than the sine-wave approximation above.
    expect(dbfsOf(new Float32Array(100).fill(0.1))).toBeCloseTo(-20, 1);
  });
  it("is -Infinity for true digital silence, never 0", () => {
    expect(dbfsOf(new Float32Array(100))).toBe(-Infinity);
  });
  it("is -Infinity for an empty buffer", () => {
    expect(dbfsOf(new Float32Array(0))).toBe(-Infinity);
  });
});

describe("hasSignal against real audio cut from the recording", () => {
  it("rejects the recording's actual silence", () => {
    expect(hasSignal(realPcm("real-silence.f32le"))).toBe(false);
  });
  it("accepts the recording's loudest real speech", () => {
    expect(hasSignal(realPcm("real-speech.f32le"))).toBe(true);
  });
});

describe("hasSignal against the recording's measured levels (calibration check)", () => {
  it("rejects the recording's actual silence (-53.8 dBFS)", () => {
    expect(hasSignal(sineAt(-53.8))).toBe(false);
  });
  it("accepts the recording's loudest real speech (-15.9 dBFS)", () => {
    expect(hasSignal(sineAt(-15.9))).toBe(true);
  });
  it("accepts the recording's quietest real speech (-43.7 dBFS)", () => {
    // The threshold must clear real speech with margin: a hesitant pause is
    // not the same thing as a shared tab playing nothing.
    expect(hasSignal(sineAt(-43.7))).toBe(true);
  });
  it("the threshold itself sits strictly between the two", () => {
    expect(SILENCE_DBFS).toBeLessThan(-43.7);
    expect(SILENCE_DBFS).toBeGreaterThan(-53.8);
  });
});

describe("segmentHasSignal", () => {
  it("decodes the segment and classifies it by its real audio", async () => {
    // The injected `decode` stands in for the browser's decodeAudioData
    // (unavailable in this Node test process) and hands back the real PCM
    // fixtures directly, so everything past that boundary -- reading channel
    // data, running dbfsOf/hasSignal, the fail-open plumbing -- runs on real
    // recorded bytes rather than synthesised ones.
    const silent = decodedAudio(realPcm("real-silence.f32le"));
    const speech = decodedAudio(realPcm("real-speech.f32le"));
    await expect(
      segmentHasSignal(new Blob(["x"]), async () => silent),
    ).resolves.toBe(false);
    await expect(
      segmentHasSignal(new Blob(["x"]), async () => speech),
    ).resolves.toBe(true);
  });

  it("accepts a segment if any channel has signal, not only the first", () => {
    const oneLoudChannel = decodedAudio(sineAt(-53.8), sineAt(-15.9));
    return expect(
      segmentHasSignal(new Blob(["x"]), async () => oneLoudChannel),
    ).resolves.toBe(true);
  });

  it("rejects only when every channel is silent", () => {
    const bothSilent = decodedAudio(sineAt(-53.8), sineAt(-58));
    return expect(
      segmentHasSignal(new Blob(["x"]), async () => bothSilent),
    ).resolves.toBe(false);
  });

  it("fails open when the segment cannot be decoded", async () => {
    // A missing Web Audio API, a corrupt or too-short segment, anything --
    // never silently drop real speech over a decode failure.
    await expect(
      segmentHasSignal(new Blob(["x"]), async () => {
        throw new Error("cannot decode");
      }),
    ).resolves.toBe(true);
  });
});
