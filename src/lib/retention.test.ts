import { describe, expect, it } from "vitest";
import {
  assembleConsentText,
  buildConsentRecord,
  consentFacts,
  type RetentionPolicy,
} from "../../shared/consent";
import {
  MAX_ATTEMPTS,
  audioExpiresAt,
  dueAudio,
  sweepable,
} from "./retention";
import type { ReportData } from "../types";

const DATE = "2026-01-01T00:00:00.000Z";
const DAY = 86_400_000;

const consent = (retention: RetentionPolicy) =>
  buildConsentRecord(
    consentFacts({ sources: ["mic"], folderName: "Ordner", retention }),
    { obtainedAt: DATE, method: "spoken", participants: [{ name: "Sergio", stance: "agreed" as const }] },
  );

/** A meeting that is safe to sweep, so each test can break exactly one thing. */
const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: DATE,
  title: "Meeting",
  summary: "Zusammenfassung",
  transcription: "Gesagtes",
  todos: [],
  takeaways: [],
  rawAudioUrl: "audio-id",
  driveSyncedAt: DATE,
  consent: consent({ audioDays: 30, textDays: null }),
  ...over,
});

describe("audioExpiresAt", () => {
  it("never expires a meeting recorded before consent existed", () => {
    expect(audioExpiresAt(report({ consent: undefined }))).toBeNull();
  });

  it("never expires audio the participants were told is kept indefinitely", () => {
    expect(
      audioExpiresAt(
        report({ consent: consent({ audioDays: null, textDays: null }) }),
      ),
    ).toBeNull();
  });

  it("never expires a meeting whose date cannot be read", () => {
    expect(audioExpiresAt(report({ date: "irgendwann" }))).toBeNull();
  });

  it("counts the promised days from the meeting date", () => {
    expect(audioExpiresAt(report())).toBe(Date.parse(DATE) + 30 * DAY);
  });
});

describe("dueAudio", () => {
  const deadline = Date.parse(DATE) + 30 * DAY;
  const busy = new Set<string>();

  it("sweeps a millisecond past the deadline and not a millisecond before", () => {
    expect(dueAudio([report()], deadline - 1, busy)).toEqual([]);
    expect(dueAudio([report()], deadline + 1, busy)).toHaveLength(1);
  });

  it("refuses to destroy the audio of a meeting that has no transcript yet", () => {
    const pending = report({ transcription: "  ", speech: undefined });
    expect(sweepable(pending)).toBe(false);
    expect(dueAudio([pending], deadline + 1, busy)).toEqual([]);
  });

  it("skips a report another operation is already working on", () => {
    expect(dueAudio([report()], deadline + 1, new Set(["r1"]))).toEqual([]);
  });

  it("skips audio that is already gone", () => {
    expect(
      dueAudio([report({ audioDeletedAt: DATE })], deadline + 1, busy),
    ).toEqual([]);
  });

  it("stops retrying a file that keeps failing", () => {
    expect(
      dueAudio(
        [report({ audioDeleteAttempts: MAX_ATTEMPTS })],
        deadline + 1,
        busy,
      ),
    ).toEqual([]);
  });

  it("skips a recording that was never uploaded", () => {
    expect(
      dueAudio([report({ driveSyncedAt: undefined })], deadline + 1, busy),
    ).toEqual([]);
  });
});

describe("the promise and the deletion come from one number", () => {
  it("names the same number of days it enforces", () => {
    const retention: RetentionPolicy = { audioDays: 7, textDays: null };
    const facts = consentFacts({
      sources: ["mic"],
      folderName: "Ordner",
      retention,
    });
    const meeting = report({
      consent: buildConsentRecord(facts, {
        obtainedAt: DATE,
        method: "spoken",
        participants: [{ name: "Sergio", stance: "agreed" as const }],
      }),
    });

    expect(assembleConsentText(facts)).toContain("nach 7 Tagen");
    expect(audioExpiresAt(meeting)).toBe(Date.parse(DATE) + 7 * DAY);
  });
});
