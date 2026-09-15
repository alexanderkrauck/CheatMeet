import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LANGUAGES } from "../../shared/transcription";
import {
  defaultLanguages,
  ownSpeakerName,
  setDefaultLanguages,
  setOwnSpeakerName,
} from "./meetingDefaults";

// The test env has no DOM; the repo stubs storage rather than pulling in jsdom.
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("defaultLanguages", () => {
  it("falls back to the shipped set when nothing is stored", () => {
    expect(defaultLanguages()).toEqual([...DEFAULT_LANGUAGES]);
  });
  it("round-trips a chosen set", () => {
    setDefaultLanguages(["de"]);
    expect(defaultLanguages()).toEqual(["de"]);
    setDefaultLanguages(["de", "it"]);
    expect(defaultLanguages()).toEqual(["de", "it"]);
  });
  it("ignores a stored value that is no longer valid", () => {
    memory.set("cheatmeet:languages", "klingon");
    expect(defaultLanguages()).toEqual([...DEFAULT_LANGUAGES]);
  });
  it("refuses to store an empty or invalid set", () => {
    setDefaultLanguages(["de"]);
    setDefaultLanguages([]);
    expect(defaultLanguages()).toEqual([...DEFAULT_LANGUAGES]);
  });
  it("returns a fresh array so a caller cannot mutate the default", () => {
    const first = defaultLanguages();
    first.push("xx");
    expect(defaultLanguages()).toEqual([...DEFAULT_LANGUAGES]);
  });
  it("survives storage being unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    expect(defaultLanguages()).toEqual([...DEFAULT_LANGUAGES]);
    expect(() => setDefaultLanguages(["de"])).not.toThrow();
  });
});

describe("ownSpeakerName", () => {
  it("prefers what you chose over the account name", () => {
    setOwnSpeakerName("Alex");
    expect(ownSpeakerName("Alexander Krauck")).toBe("Alex");
  });
  it("falls back to the account name, then to a neutral label", () => {
    expect(ownSpeakerName("Alexander Krauck")).toBe("Alexander Krauck");
    expect(ownSpeakerName(null)).toBe("Ich");
    expect(ownSpeakerName("   ")).toBe("Ich");
  });
  it("clears back to the account name when emptied", () => {
    setOwnSpeakerName("Alex");
    setOwnSpeakerName("  ");
    expect(ownSpeakerName("Alexander")).toBe("Alexander");
  });
  it("bounds the length, as the transcript field does", () => {
    setOwnSpeakerName("x".repeat(200));
    expect(ownSpeakerName()).toHaveLength(80);
  });
});
