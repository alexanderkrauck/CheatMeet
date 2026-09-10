import { describe, expect, it } from "vitest";
import { withWebmDuration } from "./webmDuration";

/** Builds the Info layout MediaRecorder actually emits: no spare Void. */
function webm({
  scale = [0x0f, 0x42, 0x40], // 1_000_000 ns per tick
  withDuration = false,
} = {}) {
  const timecodeScale = [0x2a, 0xd7, 0xb1, 0x80 | scale.length, ...scale];
  const muxingApp = [0x4d, 0x80, 0x86, 67, 104, 114, 111, 109, 101];
  const duration = withDuration
    ? [0x44, 0x89, 0x88, 0x40, 0x8f, 0x40, 0, 0, 0, 0, 0]
    : [];
  const infoBody = [...timecodeScale, ...muxingApp, ...duration];
  const info = [0x15, 0x49, 0xa9, 0x66, 0x80 | infoBody.length, ...infoBody];
  const clusters = [0x1f, 0x43, 0xb6, 0x75, 0x84, 1, 2, 3, 4];
  const segment = [
    0x18, 0x53, 0x80, 0x67,
    0xff, // unknown size, as in a live stream
    ...info,
    ...clusters,
  ];
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 1, 2, 3, 4];
  return new Blob([new Uint8Array([...ebml, ...segment])], {
    type: "audio/webm;codecs=opus",
  });
}

async function bytes(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Locates the 11-byte Duration element and reads its float payload. */
async function readDuration(blob: Blob): Promise<number | null> {
  const data = await bytes(blob);
  for (let i = 0; i < data.length - 10; i++)
    if (data[i] === 0x44 && data[i + 1] === 0x89 && data[i + 2] === 0x88)
      return new DataView(data.buffer, data.byteOffset + i + 3, 8).getFloat64(0);
  return null;
}

describe("webm duration", () => {
  it("inserts a duration a player can seek by, and keeps the audio intact", async () => {
    const original = webm();
    const patched = await withWebmDuration(original, 178_910);

    expect(await readDuration(original)).toBeNull();
    expect(await readDuration(patched)).toBeCloseTo(178_910, 3);
    // Exactly one 11-byte element is added and nothing else moves.
    expect(patched.size).toBe(original.size + 11);
    const before = await bytes(original);
    const after = await bytes(patched);
    expect([...after.slice(-9)]).toEqual([...before.slice(-9)]);
  });

  it("grows the Info element's declared size by the inserted bytes", async () => {
    const patched = await bytes(await withWebmDuration(webm(), 5_000));
    const at = patched.findIndex(
      (_, i) =>
        patched[i] === 0x15 &&
        patched[i + 1] === 0x49 &&
        patched[i + 2] === 0xa9 &&
        patched[i + 3] === 0x66,
    );
    // 16 bytes of TimecodeScale + MuxingApp, plus the 11-byte Duration.
    expect(patched[at + 4]).toBe(0x80 | 27);
  });

  it("scales the value by TimecodeScale rather than assuming milliseconds", async () => {
    // 100_000 ns per tick means ten ticks per millisecond.
    const patched = await withWebmDuration(
      webm({ scale: [0x01, 0x86, 0xa0] }),
      1_000,
    );
    expect(await readDuration(patched)).toBeCloseTo(10_000, 3);
  });

  it("leaves an already seekable file untouched", async () => {
    const already = webm({ withDuration: true });
    expect(await withWebmDuration(already, 99_000)).toBe(already);
  });

  it.each([
    ["a non-webm blob", new Blob(["x"], { type: "audio/mp4" }), 1000],
    ["an unknown duration", new Blob(["x"], { type: "audio/webm" }), 0],
    ["a truncated file", new Blob([new Uint8Array(4)], { type: "audio/webm" }), 1000],
  ])("returns %s unchanged rather than corrupting it", async (_l, blob, ms) => {
    expect(await withWebmDuration(blob as Blob, ms as number)).toBe(blob);
  });
});
