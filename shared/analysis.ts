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

/**
 * An extracted task. A bare sentence in a list is something you read once and
 * lose; who owes it and by when is what makes it actionable — and both are
 * usually said out loud in the meeting.
 */
export interface Todo {
  text: string;
  /** A speaker name from this meeting, only when it was actually stated. */
  owner?: string;
  /** ISO calendar day (YYYY-MM-DD), only when a date was actually stated. */
  due?: string;
  /** Ticked by the user afterwards; never written by the model. */
  done?: boolean;
}

const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Reports written before to-dos had structure hold plain strings, and nothing
 * migrates stored documents, so every read normalises instead.
 */
export function asTodos(value: unknown): Todo[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): Todo | null => {
      if (typeof item === "string")
        return item.trim() ? { text: item.trim() } : null;
      if (!item || typeof item !== "object") return null;
      const t = item as Record<string, unknown>;
      const text = String(t.text ?? "").trim();
      if (!text) return null;
      const owner = String(t.owner ?? "").trim();
      const due = String(t.due ?? "").trim();
      return {
        text,
        ...(owner ? { owner: owner.slice(0, 80) } : {}),
        ...(ISO_DAY.test(due) ? { due } : {}),
        ...(t.done === true ? { done: true } : {}),
      };
    })
    .filter((t): t is Todo => t !== null);
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
    todos: {
      type: "array",
      items: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Die Aufgabe in einem Satz" },
          owner: {
            type: "string",
            description:
              "Name der verantwortlichen Person, nur wenn im Meeting genannt. Sonst weglassen.",
          },
          due: {
            type: "string",
            description:
              "Fälligkeitsdatum als YYYY-MM-DD, nur wenn im Meeting genannt. Sonst weglassen.",
          },
        },
      },
    },
    takeaways: { type: "array", items: { type: "string" } },
  },
};

export interface AnalysisResult {
  title: string;
  summary: string;
  transcription: string;
  todos: Todo[];
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
    todos: asTodos(v.todos),
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

/** The assistant only ever reasons over the recent part of a long meeting. */
export const MAX_ASSIST_CONTEXT_CHARS = 12000;
export const MAX_QUESTION_CHARS = 500;

export interface MeetingInsights {
  /** Things worth raising next, offered without being asked. */
  prompts?: string[];
  /** Questions that were put to the user and are still unanswered. */
  questions: string[];
  /** Things the user appears to have committed to. */
  actions: string[];
  decisions: string[];
  /** Jargon or acronyms used in the meeting, with a short gloss. */
  terms: { term: string; explanation: string }[];
}

export const insightsSchema = {
  type: "object",
  required: ["questions", "actions", "decisions", "terms"],
  properties: {
    questions: { type: "array", items: { type: "string" } },
    prompts: { type: "array", items: { type: "string" } },
    actions: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    terms: {
      type: "array",
      items: {
        type: "object",
        required: ["term", "explanation"],
        properties: {
          term: { type: "string" },
          explanation: { type: "string" },
        },
      },
    },
  },
};

const stringList = (value: unknown, limit = 8): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => String(item).trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];

export function validateInsights(value: unknown): MeetingInsights {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    prompts: stringList(v.prompts, 4),
    questions: stringList(v.questions),
    actions: stringList(v.actions),
    decisions: stringList(v.decisions),
    terms: Array.isArray(v.terms)
      ? v.terms
          .map((item) => {
            const t = (item ?? {}) as Record<string, unknown>;
            return {
              term: String(t.term ?? "").trim(),
              explanation: String(t.explanation ?? "").trim(),
            };
          })
          .filter((t) => t.term && t.explanation)
          .slice(0, 8)
      : [],
  };
}

/**
 * A to-do as one line of text: what is owed, by whom, by when. Used by the
 * Markdown export and by the plain-text edit field, so both round-trip
 * through `parseTodoLine` without losing structure.
 */
export function formatTodoLine(todo: Todo): string {
  return [
    todo.text,
    todo.owner ? `@${todo.owner}` : "",
    todo.due ? `bis ${todo.due}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The checkbox form: the same line plus its completion state. Used by the
 * Markdown export and by the edit field, because a round trip through text
 * that cannot carry `done` silently unticks everything the user ticked.
 */
export const formatTodoEditLine = (todo: Todo) =>
  `- [${todo.done ? "x" : " "}] ${formatTodoLine(todo)}`;

/** Reads the completion state back out of a checkbox line. */
export const todoLineDone = (line: string) => /^\s*[-*]\s*\[[xX]\]/.test(line);

/** The inverse of `formatTodoLine`, so editing as text does not flatten a to-do. */
export function parseTodoLine(line: string, done = false): Todo | null {
  let rest = line.trim().replace(/^[-*]\s*(\[[ xX]\]\s*)?/, "");
  if (!rest) return null;
  // Only strip a trailing date once it is known to be a real day, or
  // "bis 2026-99-01" would vanish from the task it belongs to.
  let due: string | undefined;
  const dated = /\s\bbis\s+(\d{4}-\d{2}-\d{2})$/i.exec(rest);
  if (dated && ISO_DAY.test(dated[1])) {
    due = dated[1];
    rest = rest.slice(0, dated.index);
  }
  // The marker must open a word, so an address like anna@example.com stays
  // part of the sentence.
  let owner: string | undefined;
  const owned = /(?:^|\s)@([^@]{1,80})$/.exec(rest);
  if (owned) {
    owner = owned[1].trim();
    rest = rest.slice(0, owned.index);
  }
  const text = rest.trim();
  if (!text) return null;
  return {
    text,
    ...(owner ? { owner } : {}),
    ...(due ? { due } : {}),
    ...(done ? { done: true } : {}),
  };
}
