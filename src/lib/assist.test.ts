import { describe, expect, it } from "vitest";
import { speechOnly } from "./assist";

const twoSource = [
  "[0:00] (Andere) Yesterday, Nvidia CEO Jensen Huang logged in to X.",
  "[1:00] (Du) Ich habe da ein paar Fragen zum Budget.",
  "[1:50] (Andere) Make me feel real cool and, make me feel real cool and.",
  "[2:40] (Du) Wir verschieben den Launch auf den 14. Oktober.",
].join("\n\n");

describe("assistant context", () => {
  it("drops system audio so music and video are not reasoned over", () => {
    const result = speechOnly(twoSource);
    expect(result).toContain("Budget");
    expect(result).toContain("14. Oktober");
    expect(result).not.toContain("Nvidia");
    expect(result).not.toContain("Make me feel real cool");
  });

  it("keeps the timestamps, so answers can still cite a moment", () => {
    expect(speechOnly(twoSource)).toBe(
      "[1:00] Ich habe da ein paar Fragen zum Budget.\n\n" +
        "[2:40] Wir verschieben den Launch auf den 14. Oktober.",
    );
  });

  it("leaves a single-source recording untouched", () => {
    // A phone recording is all microphone; there is nothing to strip.
    const micOnly = "[0:00] Nur ich rede hier.\n\n[0:50] Und weiter.";
    expect(speechOnly(micOnly)).toBe(micOnly);
  });

  it("falls back to the full transcript rather than sending nothing", () => {
    // Only system audio captured: stripping it would leave no context at all.
    const systemOnly = "[0:00] (Andere) Only the video is talking.";
    expect(speechOnly(systemOnly)).toBe(systemOnly);
  });
});
