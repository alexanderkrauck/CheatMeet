import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

for (const rate of [44100, 48000])
  it(`resamples stereo ${rate} Hz to real 16 kHz mono frames`, () => {
    const output: any[] = [];
    let Processor: any;
    const context = {
      sampleRate: rate,
      currentTime: 0,
      AudioWorkletProcessor: class {
        port = { postMessage: (value: any) => output.push(value) };
      },
      registerProcessor: (_name: string, value: any) => {
        Processor = value;
      },
    };
    vm.runInNewContext(
      readFileSync(new URL("./pcmWorklet.js", import.meta.url), "utf8"),
      context,
    );
    const node = new Processor();
    node.port.onmessage({ data: { active: true } });
    // Ten seconds, L=0.75/R=0.25 => mono 0.5, independent of input rate.
    for (let at = 0; at < rate * 10; at += 128) {
      const n = Math.min(128, rate * 10 - at);
      context.currentTime = at / rate;
      node.process([
        [new Float32Array(n).fill(0.75), new Float32Array(n).fill(0.25)],
      ]);
    }
    expect(output.length).toBe(100);
    expect(output.every((f) => new Int16Array(f.pcm).length === 1600)).toBe(
      true,
    );
    expect(
      [...new Int16Array(output[0].pcm)].every((v) => Math.abs(v - 16384) <= 1),
    ).toBe(true);
    expect(output.at(-1).contextTime).toBeCloseTo(10, 4);
    node.port.onmessage({ data: { active: false } });
    node.process([[new Float32Array(rate).fill(1)]]);
    expect(output.length).toBe(100);
  });
