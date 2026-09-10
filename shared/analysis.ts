/** Audio container types both the import picker and the upload endpoints accept. */
export const AUDIO_MIME_TYPES = [
  "audio/webm",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/aac",
  "audio/flac",
  "audio/x-flac",
] as const;

/** Gemini's Files API accepts up to 2 GB. Recording is not cut short below that. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** One transcription segment is bounded by wall-clock length, not by meeting length. */
export const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

/** The glue step only ever needs the tail of the running transcript. */
export const MAX_TRANSCRIPT_CONTEXT_CHARS = 4000;

export function isAudioMimeType(mime: string): boolean {
  return (AUDIO_MIME_TYPES as readonly string[]).includes(
    mime.split(";")[0].trim().toLowerCase(),
  );
}

export const reportSchema = {
  type: "object",
  required: ["title", "summary", "todos", "takeaways"],
  properties: {
    title: { type: "string" },
    transcription: {
      type: "string",
      description:
        "Das vollständige, detaillierte Transkript des Meetings (jedes gesprochene Wort)",
    },
    summary: { type: "string" },
    todos: { type: "array", items: { type: "string" } },
    takeaways: { type: "array", items: { type: "string" } },
  },
};

export interface AnalysisResult {
  title: string;
  summary: string;
  transcription: string;
  todos: string[];
  takeaways: string[];
}

export function validateAnalysis(value: unknown): AnalysisResult {
  const v = value as Record<string, unknown> | null;
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
    todos: v.todos.map(String),
    takeaways: v.takeaways.map(String),
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
