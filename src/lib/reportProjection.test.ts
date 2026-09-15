import { describe, expect, it } from "vitest";
import { buildConsentRecord, consentFacts } from "../../shared/consent";
import {
  mergeRemoteReport,
  mergeRestoredReport,
  projectReport,
  transcriptIsElsewhere,
} from "./reportProjection";
import type { ReportData } from "../types";
import type { MeetingTranscript } from "../../shared/transcription";

const DATE = "2026-01-01T00:00:00.000Z";

const speech = (over: Partial<MeetingTranscript> = {}): MeetingTranscript => ({
  provider: "assemblyai",
  phase: "final",
  languages: ["de"],
  speakerNames: { "mic:0:A": "Alex" },
  turns: [
    {
      id: "mic:0:0",
      speaker: "mic:0:A",
      text: "Hallo",
      startMs: 0,
      endMs: 90_000,
      final: true,
    },
  ],
  ...over,
});

const full = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: DATE,
  updatedAt: DATE,
  projectName: "Projekt",
  title: "Meeting",
  suggestedTitle: "Vorschlag",
  summary: "Zusammenfassung",
  transcription: "Alles Gesagte",
  speech: speech(),
  todos: [{ text: "machen", done: false }],
  takeaways: ["Erkenntnis"],
  status: "completed",
  error: "",
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
  consent: buildConsentRecord(
    consentFacts({
      sources: ["mic"],
      folderName: "Ordner",
      retention: { audioDays: 30, textDays: null },
    }),
    { obtainedAt: DATE, method: "spoken", allInformed: true },
  ),
  audioDeletedAt: undefined,
  calendarEventId: "ev",
  calendarId: "cal",
  calendarLink: "https://example.test",
  calendarSyncedAt: DATE,
  ...over,
});

describe("projectReport", () => {
  it("keeps every field except the two unbounded ones", () => {
    // A golden key set: a field added to ReportData later fails here until
    // somebody decides, deliberately, whether the cloud index carries it.
    expect(Object.keys(projectReport(full())).sort()).toEqual(
      [
        "audioDeletedAt",
        "calendarEventId",
        "calendarId",
        "calendarLink",
        "calendarSyncedAt",
        "captureSources",
        "captureState",
        "consent",
        "date",
        "driveConsentId",
        "driveFolderId",
        "driveMarkdownId",
        "driveReportId",
        "driveSyncedAt",
        "driveTranscriptId",
        "durationMs",
        "error",
        "id",
        "participants",
        "projectName",
        "rawAudioUrl",
        "singleSpeakerSources",
        "speakerReviewPending",
        "status",
        "suggestedTitle",
        "summary",
        "takeaways",
        "title",
        "todos",
        "transcriptChars",
        "transcription",
        "transcriptionOrigin",
        "updatedAt",
      ].sort(),
    );
  });

  it("keeps the Drive file ids, so a second device updates files instead of duplicating them", () => {
    const projected = projectReport(full());
    expect(projected.rawAudioUrl).toBe("audio-id");
    expect(projected.driveFolderId).toBe("ordner");
    expect(projected.driveReportId).toBe("json");
    expect(projected.driveMarkdownId).toBe("md");
    expect(projected.driveTranscriptId).toBe("transkript");
    expect(projected.driveConsentId).toBe("einwilligung");
    expect(projected.driveSyncedAt).toBe(DATE);
    expect(projected.consent?.text).toContain("Google Drive");
    expect(projected.calendarEventId).toBe("ev");
  });

  it("drops the transcript but records that one exists", () => {
    const projected = projectReport(full());
    expect(projected.transcription).toBe("");
    expect(projected.speech).toBeUndefined();
    expect(projected.transcriptChars).toBe("Alles Gesagte".length);
  });

  it("resolves what cannot be recomputed without the turns", () => {
    const imported = projectReport(
      full({
        durationMs: 0,
        speech: speech({ speakerReview: "pending" }),
      }),
    );
    // An imported recording stores durationMs 0, so the turns are the clock.
    expect(imported.durationMs).toBe(90_000);
    expect(imported.participants).toEqual(["Alex"]);
    expect(imported.speakerReviewPending).toBe(true);
  });
});

describe("mergeRemoteReport", () => {
  it("keeps the local transcript when the cloud echo omits it at the same revision", () => {
    const local = full();
    const echo = projectReport(local);
    expect(echo.updatedAt).toBe(local.updatedAt);

    const merged = mergeRemoteReport(local, echo);
    expect(merged.transcription).toBe("Alles Gesagte");
    expect(merged.speech?.turns).toHaveLength(1);
    // Everything else still comes from the remote document.
    expect(merged.transcriptChars).toBe("Alles Gesagte".length);
  });

  it("takes the remote transcript when this device has none", () => {
    const merged = mergeRemoteReport(
      full({ transcription: "", speech: undefined }),
      full({ transcription: "Vom anderen Gerät" }),
    );
    expect(merged.transcription).toBe("Vom anderen Gerät");
  });

  it("does not resurrect a transcript neither side has", () => {
    const merged = mergeRemoteReport(
      full({ transcription: "", speech: undefined }),
      projectReport(full({ transcription: "", speech: undefined })),
    );
    expect(merged.transcription).toBe("");
    expect(merged.speech).toBeUndefined();
  });

  it("accepts a remote report for a meeting this device has never seen", () => {
    expect(mergeRemoteReport(undefined, full()).transcription).toBe(
      "Alles Gesagte",
    );
  });
});

describe("transcriptIsElsewhere", () => {
  it("is false for a meeting that genuinely contained no speech", () => {
    expect(
      transcriptIsElsewhere(full({ transcription: "", speech: speech() })),
    ).toBe(false);
  });

  it("is true for a projection", () => {
    expect(transcriptIsElsewhere(projectReport(full()))).toBe(true);
  });
});

describe("mergeRestoredReport", () => {
  it("brings the transcript back even though the local copy looks newer", () => {
    // Syncing writes the Drive file and then bumps the local revision twice,
    // so a timestamp comparison would skip every restore forever.
    const projected = {
      ...projectReport(full()),
      updatedAt: "2026-12-31T23:59:59.000Z",
    };

    const merged = mergeRestoredReport(
      { report: projected, dirty: false },
      full(),
    );

    expect(merged?.transcription).toBe("Alles Gesagte");
    expect(merged?.speech?.turns).toHaveLength(1);
    // The local metadata is still the newer one.
    expect(merged?.updatedAt).toBe("2026-12-31T23:59:59.000Z");
    expect(merged?.transcriptChars).toBeUndefined();
  });

  it("never overwrites work this device has not synced yet", () => {
    expect(
      mergeRestoredReport(
        { report: projectReport(full()), dirty: true },
        full(),
      ),
    ).toBeNull();
  });

  it("leaves a device that already has the meeting alone", () => {
    expect(
      mergeRestoredReport({ report: full(), dirty: false }, full()),
    ).toBeNull();
  });

  it("takes a meeting this device has never seen", () => {
    expect(mergeRestoredReport(undefined, full()).transcription).toBe(
      "Alles Gesagte",
    );
  });
});
