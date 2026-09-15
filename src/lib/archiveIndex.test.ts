import { describe, expect, it } from "vitest";
import { buildConsentRecord, consentFacts } from "../../shared/consent";
import { archiveIndexEntry, buildArchiveIndex } from "./archiveIndex";
import type { ReportData } from "../types";

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: "2026-09-15T12:00:00.000Z",
  title: "Weekly Sync",
  summary: "Roadmap besprochen.",
  transcription: "Gesagtes",
  todos: [{ text: "Angebot senden" }],
  takeaways: ["Launch verschiebt sich"],
  participants: ["Alex", "Sergio"],
  durationMs: 120_000,
  driveFolderId: "folder-id",
  driveReportId: "json-id",
  driveMarkdownId: "md-id",
  driveTranscriptId: "transkript-id",
  driveConsentId: "einwilligung-id",
  rawAudioUrl: "audio-id",
  consent: buildConsentRecord(
    consentFacts({
      sources: ["mic"],
      folderName: "Ordner",
      retention: { audioDays: 30, textDays: null },
    }),
    { obtainedAt: "2026-09-15T11:59:00.000Z", method: "spoken", participants: [{ name: "Sergio", stance: "agreed" as const }] },
  ),
  ...over,
});

describe("archiveIndexEntry", () => {
  it("answers who was there and where to look without opening the folder", () => {
    const entry = archiveIndexEntry(report());

    expect(entry).toMatchObject({
      id: "r1",
      title: "Weekly Sync",
      folder: "Meeting 2026-09-15 – r1",
      participants: ["Alex", "Sergio"],
      todos: ["Angebot senden"],
      takeaways: ["Launch verschiebt sich"],
      has_audio: true,
      consent_obtained_at: "2026-09-15T11:59:00.000Z",
      duration_ms: 120_000,
    });
    expect(entry.files).toEqual({
      "zusammenfassung.md": "md-id",
      "transkript.md": "transkript-id",
      "bericht_daten.json": "json-id",
      "einwilligung.md": "einwilligung-id",
      aufnahme: "audio-id",
    });
  });

  it("says when the audio is gone and when there was never consent", () => {
    const entry = archiveIndexEntry(
      report({ rawAudioUrl: undefined, consent: undefined }),
    );

    expect(entry.has_audio).toBe(false);
    expect(entry.consent_obtained_at).toBeNull();
    expect(entry.files).not.toHaveProperty("aufnahme");
  });

  it("falls back to the transcript's clock for an imported recording", () => {
    const entry = archiveIndexEntry(
      report({
        durationMs: 0,
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
              endMs: 90_000,
              final: true,
            },
          ],
        },
      }),
    );

    expect(entry.duration_ms).toBe(90_000);
  });
});

describe("buildArchiveIndex", () => {
  it("lists only what is actually in Drive, newest first", () => {
    const index = buildArchiveIndex(
      [
        report({ id: "old", date: "2026-01-01T00:00:00.000Z" }),
        // Never synced: it has no folder in the archive to point at.
        report({ id: "local-only", driveFolderId: undefined }),
        report({ id: "new", date: "2026-09-15T12:00:00.000Z" }),
      ],
      "2026-09-15T12:00:00.000Z",
    );

    expect(index.meetings.map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(index.schema).toBe("cheatmeet.index/1");
    expect(index.generated_at).toBe("2026-09-15T12:00:00.000Z");
  });

  it("says outright that it is derived", () => {
    const index = buildArchiveIndex([report()], "2026-09-15T12:00:00.000Z");

    // Anything reading this must know to fall back to the folders.
    expect(index.derived).toBe(true);
    expect(index.source_of_truth).toContain("bericht_daten.json");
  });
});
