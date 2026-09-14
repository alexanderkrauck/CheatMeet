import type { MeetingTranscript } from "../../shared/transcription";

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
/** Suggestions only: independent live/batch labels are never equated by letter.
 * Require repeated, distinctive text at matching times and reject competing
 * identities, including a final speaker that appears to merge live speakers. */
export function suggestSpeakerNames(live: MeetingTranscript, final: MeetingTranscript): Record<string, string> {
  const votes = new Map<string, Map<string, { words: number; turns: number }>>();
  for (const turn of final.turns) {
    const target = words(turn.text);
    if (target.size < 5) continue;
    const candidates = new Map<string, Set<string>>();
    for (const prior of live.turns) {
      if (prior.endMs < turn.startMs - 2000 || prior.startMs > turn.endMs + 2000 || prior.speaker.endsWith(":unknown")) continue;
      const set = candidates.get(prior.speaker) || new Set<string>();
      for (const word of words(prior.text)) set.add(word);
      candidates.set(prior.speaker, set);
    }
    const ranked = [...candidates].map(([id, tokens]) => ({ id, common: [...target].filter(w => tokens.has(w)).length }))
      .sort((a, b) => b.common - a.common);
    const best = ranked[0];
    if (!best || best.common / target.size < 0.8 || (ranked[1]?.common || 0) / target.size > 0.4) continue;
    const tally = votes.get(turn.speaker) || new Map();
    const prior = tally.get(best.id) || { words: 0, turns: 0 };
    tally.set(best.id, { words: prior.words + best.common, turns: prior.turns + 1 });
    votes.set(turn.speaker, tally);
  }
  const result: Record<string, string> = {};
  for (const [id, tally] of votes) {
    if (tally.size !== 1) continue;
    const [speaker, evidence] = [...tally][0];
    const name = live.speakerAliases?.[speaker]?.trim();
    if (!name || evidence.words < 12 || evidence.turns < 2) continue;
    // A split live identity needs review too; don't suggest its name twice.
    if ([...votes].some(([other, candidates]) => other !== id && candidates.has(speaker))) continue;
    result[id] = name;
  }
  return result;
}
