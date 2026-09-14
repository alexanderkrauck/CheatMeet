import type { MeetingTranscript, SpeechTurn } from "../../shared/transcription";

interface Word {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}
interface Turn {
  turn_order: number;
  end_of_turn: boolean;
  words: Word[];
}
function assignedSpeaker(value: unknown): string | undefined {
  return typeof value === "string" && value !== "PENDING" && value !== "UNKNOWN" && value.trim()
    ? value : undefined;
}
/** Replace provider turn IDs; never stitch or rewrite text through another LLM. */
export class AssemblyEvents {
  private turns = new Map<number, Turn>();
  constructor(
    private namespace: string,
    private mapTime: (ms: number) => number,
    private fixedSpeaker?: string,
  ) {}
  apply(data: any) {
    if (data.type === "Turn") {
      if (
        !Number.isSafeInteger(data.turn_order) ||
        data.turn_order < 0 ||
        !Array.isArray(data.words)
      )
        throw new Error("Ungültiger Live-Beitrag.");
      const words = data.words.map((w: any): Word => {
        if (
          typeof w.text !== "string" ||
          !Number.isFinite(w.start) ||
          !Number.isFinite(w.end) ||
          w.start < 0 ||
          w.end < w.start
        )
          throw new Error("Ungültige Live-Zeitangaben.");
        return {
          start: w.start,
          end: w.end,
          text: w.text,
          // Use the documented turn-level fallback only for omitted word labels.
          // Explicit UNKNOWN/PENDING must never become a guessed identity.
          speaker: assignedSpeaker(w.speaker === undefined && w.word_is_final !== false
            ? data.speaker_label : w.speaker),
        };
      });
      if (
        !words.length &&
        typeof data.transcript === "string" &&
        data.transcript.trim()
      )
        throw new Error("Wortdaten fehlen im Live-Beitrag.");
      // Late partials must not downgrade a finalized turn.
      if (!data.end_of_turn && this.turns.get(data.turn_order)?.end_of_turn)
        return;
      this.turns.set(data.turn_order, {
        turn_order: data.turn_order,
        end_of_turn: data.end_of_turn === true,
        words,
      });
    } else if (data.type === "SpeakerRevision") {
      for (const revision of data.revisions || []) {
        const turn = this.turns.get(revision.turn_order);
        if (!turn) continue;
        for (const word of turn.words) {
          const match = revision.words?.find(
            (w: any) => w.start === word.start && w.end === word.end,
          );
          if (match && typeof match.speaker === "string")
            word.speaker = assignedSpeaker(match.speaker);
        }
      }
    }
  }
  entries(includePartials = true): SpeechTurn[] {
    const entries: SpeechTurn[] = [];
    for (const turn of [...this.turns.values()].sort(
      (a, b) => a.turn_order - b.turn_order,
    )) {
      if (!includePartials && !turn.end_of_turn) continue;
      let group: SpeechTurn | undefined;
      for (const word of turn.words) {
        const speaker = this.fixedSpeaker || `${this.namespace}:${word.speaker || "unknown"}`;
        if (!group || group.speaker !== speaker) {
          group = {
            id: `${this.namespace}:${turn.turn_order}:${word.start}`,
            speaker,
            startMs: this.mapTime(word.start),
            endMs: this.mapTime(word.end),
            text: word.text,
            final: turn.end_of_turn,
          };
          entries.push(group);
        } else {
          group.text += ` ${word.text}`;
          group.endMs = this.mapTime(word.end);
        }
      }
    }
    return entries;
  }
  hasUnfinishedTurns() {
    return [...this.turns.values()].some(turn => !turn.end_of_turn);
  }
}
export function liveDocument(
  languages: string[],
  events: AssemblyEvents[],
  stopped: boolean,
  warning?: string,
): MeetingTranscript {
  return {
    provider: "assemblyai",
    model: "universal-3-5-pro",
    phase: stopped ? "pending" : "live",
    languages,
    turns: events
      .flatMap((e) => e.entries())
      .sort((a, b) => a.startMs - b.startMs),
    speakerNames: {},
    ...(warning ? { liveWarning: warning } : {}),
  };
}
