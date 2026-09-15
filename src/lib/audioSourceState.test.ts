import { describe, expect, it } from "vitest";
import { describeAudioSources } from "./audioSourceState";

const stream = (audioTracks: number) =>
  ({
    getAudioTracks: () => Array.from({ length: audioTracks }, () => ({})),
  }) as unknown as MediaStream;

describe("describeAudioSources", () => {
  it("records the microphone alone without complaint when that is what was asked", () => {
    expect(
      describeAudioSources({
        requested: "mic",
        displayMediaSupported: true,
        system: undefined,
      }),
    ).toEqual({ sources: ["mic"], warning: "" });
  });

  it("reports both sources when the share actually carries audio", () => {
    expect(
      describeAudioSources({
        requested: "mic+system",
        displayMediaSupported: true,
        system: stream(1),
      }),
    ).toEqual({ sources: ["mic", "system"], warning: "" });
  });

  it("falls back to the microphone when the picker was cancelled", () => {
    const result = describeAudioSources({
      requested: "mic+system",
      displayMediaSupported: true,
      system: undefined,
    });
    expect(result.sources).toEqual(["mic"]);
    expect(result.warning).toBe(
      "Systemaudio wurde nicht freigegeben. Es wird nur das Mikrofon aufgenommen.",
    );
  });

  it("explains a share that carries video but no audio", () => {
    const result = describeAudioSources({
      requested: "mic+system",
      displayMediaSupported: true,
      system: stream(0),
    });
    expect(result.sources).toEqual(["mic"]);
    expect(result.warning).toBe(
      "Die Freigabe enthält kein Systemaudio. Es wird nur das Mikrofon aufgenommen. Prüfe beim nächsten Mal „Audio teilen“ und ob dein Browser Audio für den gewählten Tab oder Bildschirm unterstützt.",
    );
  });

  it("explains a browser that cannot share a screen at all", () => {
    const result = describeAudioSources({
      requested: "mic+system",
      displayMediaSupported: false,
      system: undefined,
    });
    expect(result.sources).toEqual(["mic"]);
    expect(result.warning).toBe(
      "Dieser Browser unterstützt keine Bildschirmfreigabe. Es wird nur das Mikrofon aufgenommen.",
    );
  });
});
