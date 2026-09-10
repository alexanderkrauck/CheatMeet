import { describe, expect, it } from "vitest";
import {
  MAX_ANALYSIS_BYTES,
  MULTIPART_RESERVE,
  photoBudget,
  prepareAnalysisPhotos,
} from "./analysisMedia";
describe("Cloud Run analysis payload", () => {
  it("allocates a bounded budget even with 25 MiB audio and 30 photos", () => {
    const audio = 25 * 1024 * 1024;
    expect(
      audio + photoBudget(audio, 30) * 30 + MULTIPART_RESERVE,
    ).toBeLessThanOrEqual(MAX_ANALYSIS_BYTES);
    expect(() => photoBudget(MAX_ANALYSIS_BYTES, 0)).toThrow();
  });
  it("keeps original media, IDs and timeline while processing images sequentially", async () => {
    const original = new Blob(["original"], { type: "image/png" });
    const photos = [
      { id: "one", blob: original, relativeTimeMs: 100 },
      { id: "two", blob: original, relativeTimeMs: null },
    ];
    let active = 0;
    let maximum = 0;
    const prepared = await prepareAnalysisPhotos(
      new Blob(["audio"]),
      photos,
      async () => {
        maximum = Math.max(maximum, ++active);
        await Promise.resolve();
        active--;
        return new Blob(["small"], { type: "image/jpeg" });
      },
    );
    expect(maximum).toBe(1);
    expect(photos[0].blob).toBe(original);
    expect(prepared.map((p) => [p.id, p.relativeTimeMs])).toEqual([
      ["one", 100],
      ["two", null],
    ]);
    expect(await prepared[0].blob.text()).toBe("small");
  });
  it("rejects a derivative that still exceeds the total upload limit", async () => {
    const large = new Blob([new Uint8Array(MAX_ANALYSIS_BYTES)]);
    await expect(
      prepareAnalysisPhotos(
        new Blob(["a"]),
        [{ id: "one", blob: new Blob(["x"]), relativeTimeMs: 0 }],
        async () => large,
      ),
    ).rejects.toThrow("maximale Größe");
  });
});
