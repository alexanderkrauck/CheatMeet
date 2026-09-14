/** Compact utterances are persisted; provider word events stay in memory. */
export interface SpeechTurn {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  final: boolean;
  source?: "mic" | "system";
}
export interface MeetingTranscript {
  provider: "assemblyai";
  model?: "universal-3-5-pro";
  phase: "live" | "pending" | "final";
  languages: string[];
  turns: SpeechTurn[];
  speakerNames: Record<string, string>;
  /** Only names explicitly entered by the user, separate from generated labels. */
  speakerAliases?: Record<string, string>;
  speakerNameSuggestions?: Record<string, string>;
  speakerReview?: "pending" | "reviewed" | "skipped";
  liveWarning?: string;
  liveStartDelayed?: boolean;
}
export const DEFAULT_LANGUAGES = ["de", "en"];
export const LANGUAGES: Record<string, string> = {
  de: "Deutsch",
  en: "Englisch",
  es: "Spanisch",
  fr: "Französisch",
  it: "Italienisch",
  pt: "Portugiesisch",
  nl: "Niederländisch",
  pl: "Polnisch",
};
export function validLanguages(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every((v) => typeof v === "string" && Object.hasOwn(LANGUAGES, v)) &&
    new Set(value).size === value.length
  );
}
function stamp(ms: number) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export const CAPTURE_SOURCE_LABELS = { mic: "Mikrofon", system: "Systemaudio" };
/** Source is capture evidence, independent of a provider's changing identity. */
export function turnSource(turn: SpeechTurn): "mic" | "system" | null {
  if (turn.source) return turn.source;
  const prefix = /^(mic|system):/.exec(turn.id)?.[1]
    || /^(mic|system):/.exec(turn.speaker)?.[1];
  return prefix === "mic" || prefix === "system" ? prefix : null;
}
export function speakerLabel(doc: MeetingTranscript, turn: SpeechTurn): string {
  if (turn.speaker.endsWith(":unknown"))
    return "Stimme nicht zugeordnet";
  const speakers = [...new Set(doc.turns.map((t) => t.speaker))];
  return doc.speakerNames[turn.speaker] || `Sprecher ${speakers.indexOf(turn.speaker) + 1}`;
}
export function renderTranscript(doc: MeetingTranscript): string {
  return [...doc.turns]
    .sort((a, b) => a.startMs - b.startMs)
    .map((t) => {
      const source = turnSource(t);
      const name = `${source ? CAPTURE_SOURCE_LABELS[source] + " · " : ""}${speakerLabel(doc, t)}`;
      return `[${stamp(t.startMs)}] (${name.replace(/[()\r\n]/g, " ")}) ${t.text}`;
    })
    .join("\n\n");
}
export function renameSpeaker(
  doc: MeetingTranscript,
  speaker: string,
  name: string,
): MeetingTranscript {
  return {
    ...doc,
    speakerNames: { ...doc.speakerNames, [speaker]: name.slice(0, 80) },
    speakerAliases: { ...doc.speakerAliases, [speaker]: name.slice(0, 80) },
  };
}
export function mergeSpeaker(
  doc: MeetingTranscript,
  from: string,
  into: string,
): MeetingTranscript {
  if (from === into || !doc.turns.some((t) => t.speaker === into)) return doc;
  const speakerNames = { ...doc.speakerNames };
  const speakerAliases = { ...doc.speakerAliases };
  delete speakerNames[from];
  delete speakerAliases[from];
  return {
    ...doc,
    speakerNames,
    speakerAliases,
    turns: doc.turns.map((t) =>
      t.speaker === from ? { ...t, speaker: into } : t,
    ),
  };
}
export function needsSpeakerReview(speech?: MeetingTranscript): boolean {
  return speech?.phase === "final" && speech.speakerReview === "pending" && speech.turns.length > 0;
}
/** Validate provider output without silently dropping malformed utterances. */
export function batchTranscript(
  data: any,
  languages: string[],
): MeetingTranscript {
  if (
    data.status === "completed" &&
    !data.text?.trim() &&
    data.utterances == null
  )
    data = { ...data, utterances: [] };
  if (data.status !== "completed" || !Array.isArray(data.utterances))
    throw new Error("Kein vollständiges Sprechertranskript erhalten.");
  const turns: SpeechTurn[] = data.utterances.map((u: any, i: number) => {
    if (
      typeof u.text !== "string" ||
      !Number.isFinite(u.start) ||
      !Number.isFinite(u.end) ||
      u.start < 0 ||
      u.end < u.start
    )
      throw new Error("Ungültige Transkript-Zeitangaben erhalten.");
    return {
      id: `batch:${i}`,
      startMs: u.start,
      endMs: u.end,
      speaker: `batch:${typeof u.speaker === "string" ? u.speaker : "unknown"}`,
      text: u.text,
      final: true,
    };
  });
  if (data.text?.trim() && !turns.length)
    throw new Error("Sprecherbeiträge fehlen im Transkript.");
  return {
    provider: "assemblyai",
    model: "universal-3-5-pro",
    phase: "final",
    languages,
    turns,
    speakerNames: {},
  };
}
