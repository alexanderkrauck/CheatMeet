import { describe, expect, it } from "vitest";
import { buildConsentRecord, consentFacts } from "../../shared/consent";
import { ARCHIVE_VERSION, fromArchive, toArchive } from "./archive";
import type { ReportData } from "../types";

const DATE = "2026-01-01T00:00:00.000Z";
const IDS = { driveFolderId: "ordner", driveReportId: "json" };

const consent = buildConsentRecord(
  consentFacts({
    sources: ["mic"],
    folderName: "Ordner",
    retention: { audioDays: 30, textDays: null },
  }),
  { obtainedAt: DATE, method: "spoken", allInformed: true },
);

const full = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: DATE,
  updatedAt: DATE,
  projectName: "Projekt",
  title: "Meeting",
  suggestedTitle: "Vorschlag",
  summary: "Zusammenfassung",
  transcription: "Alles Gesagte",
  speech: {
    provider: "assemblyai",
    phase: "final",
    languages: ["de"],
    speakerNames: {},
    turns: [
      {
        id: "mic:0:0",
        speaker: "mic:0:A",
        text: "Hallo",
        startMs: 0,
        endMs: 1000,
        final: true,
      },
    ],
  },
  todos: [{ text: "machen", done: false }],
  takeaways: ["Erkenntnis"],
  status: "completed",
  error: "ein Fehler",
  durationMs: 120_000,
  captureState: "stopped",
  transcriptionOrigin: "live",
  captureSources: ["mic", "system"],
  singleSpeakerSources: { mic: true },
  rawAudioUrl: "audio-id",
  driveFolderId: "ordner",
  driveReportId: "json",
  driveMarkdownId: "md",
  driveTranscriptId: "transkript",
  driveConsentId: "einwilligung",
  driveSyncedAt: DATE,
  consent,
  audioDeletedAt: DATE,
  audioDeleteAttempts: 1,
  transcriptChars: 13,
  participants: ["Alex"],
  speakerReviewPending: false,
  calendarEventId: "ev",
  calendarId: "cal",
  calendarLink: "https://example.test",
  calendarSyncedAt: DATE,
  calendarError: "Kalenderfehler",
  ...over,
});

describe("toArchive", () => {
  it("publishes exactly the agreed contract", () => {
    expect(Object.keys(toArchive(full(), DATE)).sort()).toEqual(
      [
        "archive",
        "audioDeleteAttempts",
        "audioDeletedAt",
        "calendarEventId",
        "calendarId",
        "calendarLink",
        "calendarSyncedAt",
        "captureSources",
        "consent",
        "date",
        "driveConsentId",
        "driveMarkdownId",
        "driveSyncedAt",
        "driveTranscriptId",
        "durationMs",
        "id",
        "projectName",
        "rawAudioUrl",
        "singleSpeakerSources",
        "speech",
        "suggestedTitle",
        "summary",
        "takeaways",
        "title",
        "todos",
        "transcription",
        "transcriptionOrigin",
        "updatedAt",
      ].sort(),
    );
  });

  it("omits this session's internals", () => {
    const archived = toArchive(full(), DATE);
    for (const key of [
      "status",
      "error",
      "captureState",
      "calendarError",
      "transcriptChars",
      "participants",
      "speakerReviewPending",
      "driveFolderId",
      "driveReportId",
    ])
      expect(archived, key).not.toHaveProperty(key);
  });

  it("stamps a version an older reader can ignore", () => {
    expect(toArchive(full(), DATE).archive).toEqual({
      version: ARCHIVE_VERSION,
      generator: "cheatmeet",
      generatedAt: DATE,
    });
  });
});

describe("fromArchive round trip", () => {
  it("reads back everything a meeting is made of", () => {
    const original = full();
    const restored = fromArchive(toArchive(original, DATE), IDS);
    expect(restored).toMatchObject({
      id: "r1",
      date: DATE,
      updatedAt: DATE,
      title: "Meeting",
      projectName: "Projekt",
      suggestedTitle: "Vorschlag",
      summary: "Zusammenfassung",
      transcription: "Alles Gesagte",
      takeaways: ["Erkenntnis"],
      durationMs: 120_000,
      transcriptionOrigin: "live",
      captureSources: ["mic", "system"],
      rawAudioUrl: "audio-id",
      driveMarkdownId: "md",
      driveTranscriptId: "transkript",
      driveConsentId: "einwilligung",
      driveSyncedAt: DATE,
      audioDeletedAt: DATE,
      audioDeleteAttempts: 1,
      calendarEventId: "ev",
    });
    expect(restored.speech?.turns).toHaveLength(1);
    // asTodos keeps an unchecked to-do as bare text; `done: false` is implied.
    expect(restored.todos).toEqual([{ text: "machen" }]);
    expect(restored.consent?.text).toBe(consent.text);
    // The ids come from where the file was found, never from the file.
    expect(restored.driveFolderId).toBe("ordner");
    expect(restored.driveReportId).toBe("json");
  });

  it("derives the status the file no longer carries", () => {
    expect(fromArchive(toArchive(full(), DATE), IDS).status).toBe("completed");
    expect(
      fromArchive(toArchive(full({ summary: "" }), DATE), IDS).status,
    ).toBe("pending");
  });
});

describe("documents written before this contract", () => {
  it("reads a v0 file the way it has always been read", () => {
    const legacy = {
      id: "old",
      date: DATE,
      title: "Altes Meeting",
      todos: ["nur ein String"],
      status: "irgendwas",
    };
    const restored = fromArchive(legacy, IDS);
    expect(restored.todos).toEqual([{ text: "nur ein String" }]);
    expect(restored.status).toBe("pending");
    expect(restored.summary).toBe("");
    expect(restored.transcription).toBe("");
    expect(restored.takeaways).toEqual([]);
    expect(restored.consent).toBeUndefined();
  });
});

describe("fromArchive refuses only what it must", () => {
  it("rejects a newer contract without looking like a dead connection", () => {
    let thrown: Error | undefined;
    try {
      fromArchive({ ...full(), archive: { version: 2 } }, IDS);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("neueren Version");
    // "abgelaufen" is read elsewhere as an expired Drive grant, which would
    // abort the whole restore instead of skipping this one file.
    expect(thrown?.message).not.toContain("abgelaufen");
  });

  it("drops an unreadable consent record rather than losing the meeting", () => {
    expect(fromArchive({ ...full(), consent: "ja klar" }, IDS).consent).toBeUndefined();
    expect(
      fromArchive({ ...full(), consent: { ...consent, text: "" } }, IDS).consent,
    ).toBeUndefined();
    // The meeting itself still restores.
    expect(fromArchive({ ...full(), consent: "ja klar" }, IDS).title).toBe(
      "Meeting",
    );
  });

  it("never lets an unknown key out of the file", () => {
    const restored = fromArchive(
      { ...toArchive(full(), DATE), boshaft: "<script>", status: "completed" },
      IDS,
    );
    expect(restored).not.toHaveProperty("boshaft");
    expect(restored).not.toHaveProperty("archive");
  });

  it("still refuses a file that is not a report at all", () => {
    expect(() => fromArchive({ id: 1, title: "x", date: DATE }, IDS)).toThrow(
      /Ungültige Berichtsdaten/,
    );
    expect(() =>
      fromArchive({ ...full(), takeaways: [{ nope: true }] }, IDS),
    ).toThrow(/Ungültige Berichtsinhalte/);
    expect(() =>
      fromArchive({ ...full(), rawAudioUrl: 42 }, IDS),
    ).toThrow(/Ungültige Audioreferenz/);
  });
});
