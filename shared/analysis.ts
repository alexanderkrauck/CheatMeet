import type { RoomReport } from "../src/types";
export const REPORT_TAGS = [
  "Mangel",
  "Fortschritt",
  "Erledigt",
  "Offener Punkt",
  "Sicherheit",
  "Material",
  "Entscheidung",
] as const;
export const MAX_PHOTOS = 30;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const reportSchema = {
  type: "object",
  required: ["title", "summary", "todos", "takeaways"],
  properties: {
    title: { type: "string" },
    transcription: { type: "string", description: "Das vollständige, detaillierte Transkript des Meetings (jedes gesprochene Wort)" },
    summary: { type: "string" },
    todos: {
      type: "array",
      items: { type: "string" }
    },
    takeaways: {
      type: "array",
      items: { type: "string" }
    }
  },
};
export function validateAnalysis(
  value: unknown,
): { title: string; summary: string; transcription: string; todos: string[]; takeaways: string[] } {
  const v = value as any;
  if (
    !v ||
    typeof v.title !== "string" ||
    !v.title.trim() ||
    typeof v.summary !== "string" ||
    
    !Array.isArray(v.todos) ||
    !Array.isArray(v.takeaways)
  )
    throw new Error(
      "Die KI hat keinen vollständigen Bericht geliefert. Bitte erneut versuchen.",
    );
  
  return {
    title: v.title,
    summary: v.summary,
    transcription: typeof v.transcription === "string" ? v.transcription : "",
    todos: v.todos.map((t: any) => String(t)),
    takeaways: v.takeaways.map((t: any) => String(t)),
  };
}
export function audioExtension(mime: string) {
  return mime.includes("flac")
    ? "flac"
    : mime.includes("aac")
      ? "aac"
      : mime.includes("mp4")
        ? "m4a"
        : mime.includes("ogg")
          ? "ogg"
          : mime.includes("wav")
            ? "wav"
            : mime.includes("mpeg")
              ? "mp3"
              : "webm";
}
