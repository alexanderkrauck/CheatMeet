import { afterEach, describe, expect, it, vi } from "vitest";
import { audioSourcePreference, setAudioSourcePreference } from "./audioSources";

afterEach(() => vi.unstubAllGlobals());

describe("audioSourcePreference", () => {
  it("defaults to mic+system when nothing is stored", () => {
    vi.stubGlobal("localStorage", { getItem: vi.fn().mockReturnValue(null) });
    expect(audioSourcePreference()).toBe("mic+system");
  });
  it("reads back an explicit mic-only choice", () => {
    vi.stubGlobal("localStorage", { getItem: vi.fn().mockReturnValue("mic") });
    expect(audioSourcePreference()).toBe("mic");
  });
  it("treats anything other than the exact value 'mic' as mic+system", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue("mic+system"),
    });
    expect(audioSourcePreference()).toBe("mic+system");
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue("garbage"),
    });
    expect(audioSourcePreference()).toBe("mic+system");
  });
  it("falls back to mic+system when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(audioSourcePreference()).toBe("mic+system");
  });
});

describe("setAudioSourcePreference", () => {
  it("writes the exact key and value", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    setAudioSourcePreference("mic");
    expect(setItem).toHaveBeenCalledWith("cheatmeet:audio-sources", "mic");
  });
  it("never throws when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => setAudioSourcePreference("mic+system")).not.toThrow();
  });
});
