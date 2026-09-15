import { formatTodoLine } from "../../shared/analysis";
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
