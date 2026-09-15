import { formatTodoLine } from "../../shared/analysis";
import {
  CONSENT_REQUIRED,
  consentSentences,
  type ConsentRecord,
} from "../../shared/consent";
import type { ReportData } from "../types";

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, "\\$1");
}
function heading(text: string): string {
  return escapeText(text.replace(/[\r\n]+/g, " "));
}
function time(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}
const driveLink = (id: string) =>
  `https://drive.google.com/file/d/${encodeURIComponent(id).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}/view`;
function verbatim(text: string): string {
  // A longer fence keeps literal Markdown/HTML in the original transcript intact.
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) || []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Portable human-readable export. Drive links retain the files' existing private permissions. */
export function reportToMarkdown(report: ReportData): string {
  const when = new Date(report.date);
  const lines = [
    `# ${heading(report.title)}`,
    "",
    `Datum: ${heading(
      Number.isFinite(when.getTime())
        ? when.toLocaleString("de-AT", {
            dateStyle: "long",
            timeStyle: "short",
          })
        : report.date,
    )}`,
  ];
  if (Number.isFinite(report.durationMs))
    lines.push(`Aufnahmedauer: ${time(report.durationMs!)}`);
  if (report.rawAudioUrl)
    lines.push(
      "",
      `[Originalaufnahme in Google Drive](${driveLink(report.rawAudioUrl)})`,
    );
  if (report.driveTranscriptId)
    lines.push(
      "",
      `[Vollständiges Transkript](${driveLink(report.driveTranscriptId)})`,
    );
  if (report.driveConsentId)
    lines.push("", `[Einwilligung](${driveLink(report.driveConsentId)})`);
  
  lines.push("", "## Zusammenfassung", "", escapeText(report.summary));
  
  if (report.todos && report.todos.length > 0) {
    lines.push("", "## Aufgaben (To-Dos)", "");
    report.todos.forEach(todo => {
      // A checked box in Markdown is the same state the report page shows.
      // The marker is syntax, not content: escaping it produced "\- \[x\]".
      lines.push(`- [${todo.done ? "x" : " "}] ${escapeText(formatTodoLine(todo))}`);
    });
  }
  
  if (report.takeaways && report.takeaways.length > 0) {
    lines.push("", "## Wichtigste Erkenntnisse", "");
    report.takeaways.forEach(takeaway => {
      lines.push(`- ${escapeText(takeaway)}`);
    });
  }

  if (report.transcription.trim())
    lines.push("", "## Transkript", "", verbatim(report.transcription));

  return `${lines.join("\n")}\n`;
}

/** The short form a person pastes into a chat or a mail, not the full export. */
export function reportShareText(report: ReportData): string {
  const lines = [report.title || "Meeting", ""];
  if (report.summary) lines.push(report.summary, "");
  if (report.todos?.length) {
    lines.push("Aufgaben:");
    for (const todo of report.todos)
      lines.push(`- ${formatTodoLine(todo)}${todo.done ? " (erledigt)" : ""}`);
    lines.push("");
  }
  if (report.driveFolderId)
    lines.push(
      `Dateien: https://drive.google.com/drive/folders/${encodeURIComponent(report.driveFolderId)}`,
    );
  return lines.join("\n").trim();
}

/**
 * YAML scalars, not Markdown. escapeText() is the wrong grammar here — it
 * escapes Markdown metacharacters, which a YAML reader would hand back
 * verbatim including the backslashes.
 */
function yamlValue(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return value.length ? `[${value.map(yamlValue).join(", ")}]` : "[]";
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")}"`;
}

const ELEMENT_HEADINGS: Record<string, string> = {
  purpose: "Zweck",
  means: "Technische Mittel",
  recipients: "Speicherort und Empfänger",
  retention: "Aufbewahrung",
  ask: "Frage nach der Zustimmung",
};

/**
 * The record of what was actually said, as a file a person can read.
 *
 * Fidelity is the whole point, so the notice goes through the same fence the
 * transcript uses rather than a blockquote: a quoted notice containing `#` or
 * `-` would re-render as headings and lists and stop reproducing the words.
 * Absent optionals are written as literal `null` so a reader can tell "nobody
 * objected" from "this writer never recorded objections".
 */
export function consentToMarkdown(consent: ConsentRecord): string {
  const { facts } = consent;
  const sentences = consentSentences(facts);
  const frontmatter: [string, unknown][] = [
    ["schema", "cheatmeet.consent/1"],
    ["generator", "cheatmeet"],
    ["template_version", consent.templateVersion],
    ["obtained_at", consent.obtainedAt],
    ["language", facts.language],
    ["address", facts.address],
    ["method", consent.method],
    ["all_informed", consent.allInformed],
    ["participants", consent.participants ?? null],
    ["objections", consent.objections ?? null],
    ["sources", facts.sources],
    ["processors", facts.processors.map((p) => p.name)],
    ["storage_folder", facts.storage.folder],
    ["recipients", facts.recipients],
    ["retention_audio_days", facts.retention.audioDays],
    ["retention_text_days", facts.retention.textDays],
  ];
  const lines = [
    "---",
    ...frontmatter.map(([key, value]) => `${key}: ${yamlValue(value)}`),
    "---",
    "",
    "# Einwilligung zur Aufzeichnung",
    "",
    "## Wortlaut",
    "",
    verbatim(consent.text),
  ];
  // One heading per required element, so coverage is checkable without
  // parsing the prose back apart.
  for (const key of CONSENT_REQUIRED)
    lines.push(
      "",
      `## ${ELEMENT_HEADINGS[key] || key}`,
      "",
      escapeText((consent.parts?.[key] || "").trim() || sentences[key]),
    );
  lines.push(
    "",
    "## Dokumentation",
    "",
    `- Zeitpunkt: ${escapeText(consent.obtainedAt)}`,
    `- Art der Aufklärung: ${escapeText(consent.method)}`,
    `- Alle Anwesenden informiert: ${consent.allInformed ? "ja" : "nein"}`,
    `- Fassung der Vorlage: ${escapeText(consent.templateVersion)}`,
  );
  if (consent.participants?.length)
    lines.push(`- Anwesende: ${escapeText(consent.participants.join(", "))}`);
  if (consent.objections)
    lines.push(`- Widerspruch: ${escapeText(consent.objections)}`);
  return lines.join("\n");
}
