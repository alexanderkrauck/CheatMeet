import { meetingDurationMs } from "./meetingMeta";
import { ARCHIVE_VERSION } from "./archive";
import type { ReportData } from "../types";

/**
 * One file at the root of the archive that answers "which meetings are there,
 * who was in them, and where do I look" without opening every folder.
 *
 * It is explicitly DERIVED: each meeting's own `bericht_daten.json` is the
 * source of truth, and this is rebuilt wholesale from the writing device's
 * view. Two devices that each hold the full archive write the same thing; a
 * device that holds less writes less, which is why the file says so and why
 * anything reading it can fall back to scanning the folders.
 */

export interface ArchiveIndexEntry {
  id: string;
  date: string;
  title: string;
  folder: string;
  duration_ms: number;
  participants: string[];
  summary: string;
  todos: string[];
  takeaways: string[];
  has_audio: boolean;
  consent_obtained_at: string | null;
  files: Record<string, string>;
}

export interface ArchiveIndex {
  schema: string;
  generator: string;
  generated_at: string;
  derived: true;
  source_of_truth: string;
  meetings: ArchiveIndexEntry[];
}

export const ARCHIVE_INDEX_NAME = "index.json";
export const ARCHIVE_SCHEMA_NAME = "SCHEMA.md";

const folderName = (report: ReportData) =>
  `Meeting ${report.date.slice(0, 10)} – ${report.id}`;

export function archiveIndexEntry(report: ReportData): ArchiveIndexEntry {
  const files: Record<string, string> = {};
  if (report.driveMarkdownId) files["zusammenfassung.md"] = report.driveMarkdownId;
  if (report.driveTranscriptId) files["transkript.md"] = report.driveTranscriptId;
  if (report.driveReportId) files["bericht_daten.json"] = report.driveReportId;
  if (report.driveConsentId) files["einwilligung.md"] = report.driveConsentId;
  if (report.rawAudioUrl) files["aufnahme"] = report.rawAudioUrl;
  return {
    id: report.id,
    date: report.date,
    title: report.title,
    folder: folderName(report),
    duration_ms: meetingDurationMs(report),
    participants: report.participants || [],
    summary: report.summary || "",
    todos: (report.todos || []).map((todo) => todo.text),
    takeaways: report.takeaways || [],
    has_audio: !!report.rawAudioUrl,
    consent_obtained_at: report.consent?.obtainedAt ?? null,
    files,
  };
}

export function buildArchiveIndex(
  reports: ReportData[],
  generatedAt: string,
): ArchiveIndex {
  return {
    schema: `cheatmeet.index/${ARCHIVE_VERSION}`,
    generator: "cheatmeet",
    generated_at: generatedAt,
    derived: true,
    source_of_truth:
      "Jeder Ordner enthält bericht_daten.json — das ist die Quelle. Diese Datei ist nur eine Übersicht und kann unvollständig sein.",
    meetings: reports
      // Only meetings that actually exist in Drive belong in a Drive index.
      .filter((report) => !!report.driveFolderId)
      .map(archiveIndexEntry)
      .sort((a, b) => b.date.localeCompare(a.date)),
  };
}

/** Written once next to the meetings, so the layout explains itself. */
export const ARCHIVE_SCHEMA_DOC = `# CheatMeet-Archiv

Dieser Ordner enthält pro Meeting einen Unterordner. Alles ist reiner Text
oder JSON und gehört dir — CheatMeet wird nicht gebraucht, um es zu lesen.

## Aufbau

    <Wurzelordner>/
      index.json                      Übersicht über alle Meetings (abgeleitet)
      SCHEMA.md                       diese Datei
      Meeting YYYY-MM-DD – <id>/
        aufnahme.webm                 Originalaufnahme (kann nach der
                                      zugesagten Frist gelöscht sein)
        transkript.md                 vollständiges Transkript, mit Frontmatter
        zusammenfassung.md            Zusammenfassung, Aufgaben, Erkenntnisse
        einwilligung.md               was den Anwesenden vor der Aufnahme
                                      gesagt wurde, plus Zeitpunkt und Art
        bericht_daten.json            strukturierte Daten — die Quelle

## Für Agenten und Skripte

* \`bericht_daten.json\` ist maßgeblich. \`index.json\` ist daraus abgeleitet,
  wird vom zuletzt synchronisierenden Gerät geschrieben und kann unvollständig
  sein; im Zweifel die Ordner durchgehen.
* Beide tragen einen \`archive\`- bzw. \`schema\`-Block mit Version. Bei einer
  höheren Hauptversion als der bekannten: nicht raten.
* \`transkript.md\` und \`zusammenfassung.md\` beginnen mit YAML-Frontmatter
  (\`id\`, \`date\`, \`title\`, \`participants\`, …), sodass jede Datei für sich
  allein zugeordnet werden kann.
* Zeiten sind ISO-8601 in UTC. \`duration_ms\` ist in Millisekunden.
* \`einwilligung.md\` ist Dokumentation der aufnehmenden Person, kein Nachweis
  gegenüber Dritten.
`;
