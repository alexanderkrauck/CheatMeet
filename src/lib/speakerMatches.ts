import {
  turnSource,
  type MeetingTranscript,
  type SpeechTurn,
  type SpeakerIssue,
} from "../../shared/transcription";

const words = (text: string) =>
  new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [],
  );
const known = (id: string) => !id.endsWith(":unknown");
const MIN_COVERAGE = 0.7;
interface Match {
  id: string;
  common: number;
  coverage: number;
}
interface Evidence {
  turn: SpeechTurn;
  ranked: Match[];
  winner?: Match;
  conflict: boolean;
}

/** Match text within the same time window; provider letters never imply identity.
 * Coverage is lexical overlap, not a calibrated probability of correctness.
 * Long batch utterances may combine several shorter live utterances. */
export function reconcileSpeakers(
  live: MeetingTranscript,
  final: MeetingTranscript,
): MeetingTranscript {
  const roster = Object.fromEntries(
    [
      ...new Map(
        live.turns.filter((t) => known(t.speaker)).map((t) => [t.speaker, t]),
      ).values(),
    ].map((t) => [
      t.speaker,
      {
        name:
          live.speakerAliases?.[t.speaker] ||
          live.speakerNames[t.speaker] ||
          "Stimme",
        ...(turnSource(t) ? { source: turnSource(t)! } : {}),
        ...(live.speakerAliases?.[t.speaker]
          ? { alias: live.speakerAliases[t.speaker] }
          : {}),
      },
    ]),
  );
  // Live partials are valid identity evidence when the final text confirms them;
  // their wording is never copied into the final transcript or summary.
  const prior = live.turns
    .filter((t) => known(t.speaker))
    .map((t) => ({ ...t, tokens: words(t.text) }));
  const evidence: Evidence[] = final.turns.map((turn) => {
    const target = words(turn.text);
    const candidates = new Map<string, Set<string>>();
    for (const p of prior) {
      if (p.endMs < turn.startMs - 2000 || p.startMs > turn.endMs + 2000)
        continue;
      const set = candidates.get(p.speaker) || new Set<string>();
      for (const word of p.tokens) if (target.has(word)) set.add(word);
      candidates.set(p.speaker, set);
    }
    const ranked = [...candidates]
      .map(([id, tokens]) => ({
        id,
        common: tokens.size,
        coverage: tokens.size / Math.max(1, target.size),
      }))
      .filter((m) => m.common >= 4)
      .sort((a, b) => b.common - a.common);
    const best = ranked[0];
    const runner = ranked[1];
    // Significant competing text can mean overlap, echo, or a mixed utterance.
    const conflict =
      !!runner &&
      runner.coverage >= 0.25 &&
      runner.common >= best.common * 0.35;
    return {
      turn,
      ranked,
      conflict,
      winner:
        best && !conflict && best.coverage >= MIN_COVERAGE ? best : undefined,
    };
  });
  const votes = new Map<string, Map<string, number>>();
  for (const e of evidence)
    if (e.winner) {
      const tally = votes.get(e.turn.speaker) || new Map<string, number>();
      tally.set(e.winner.id, (tally.get(e.winner.id) || 0) + e.winner.common);
      votes.set(e.turn.speaker, tally);
    }
  const stable = new Map<string, string>();
  for (const [id, tally] of votes) {
    // Do not let a majority erase an independently evidenced second person.
    if (tally.size !== 1 || !known(id)) continue;
    const [speaker, count] = [...tally][0];
    if (
      count >= 12 &&
      !evidence.some((e) => e.turn.speaker === id && e.conflict)
    )
      stable.set(id, speaker);
  }
  const names = { ...final.speakerNames };
  const aliases = { ...final.speakerAliases };
  const issues = new Map<string, SpeakerIssue>();
  const turns = evidence.map((e) => {
    // Twelve distinctive words suffice even if batch combined the whole voice
    // into one utterance. Short phrases need repeated evidence for that label.
    const match =
      !e.conflict &&
      (e.winner &&
      (e.winner.common >= 12 || stable.get(e.turn.speaker) === e.winner.id)
        ? e.winner.id
        : !e.winner &&
            !e.ranked.some(
              (candidate) =>
                candidate.id !== stable.get(e.turn.speaker) &&
                candidate.coverage >= 0.4,
            )
          ? stable.get(e.turn.speaker)
          : undefined);
    if (match) {
      const person = roster[match];
      names[match] = person.name;
      if (person.alias) aliases[match] = person.alias;
      return {
        ...e.turn,
        providerSpeaker: e.turn.speaker,
        speaker: match,
        ...(person.source ? { source: person.source } : {}),
        sourceEvidence: "live-match" as const,
      };
    }
    const id = e.turn.speaker;
    const issue = issues.get(id) || {
      speaker: id,
      turnIds: [],
      candidates: [],
      reason: e.conflict ? "ambiguous" : "unmatched",
    };
    issue.turnIds.push(e.turn.id);
    if (e.conflict) issue.reason = "ambiguous";
    for (const candidate of e.ranked)
      if (!issue.candidates.includes(candidate.id))
        issue.candidates.push(candidate.id);
    issues.set(id, issue);
    return { ...e.turn };
  });
  return {
    ...final,
    turns,
    speakerNames: names,
    speakerAliases: aliases,
    liveSpeakers: roster,
    speakerIssues: [...issues.values()],
    speakerReview: issues.size ? "pending" : "matched",
    speakerMatchingVersion: 1,
  };
}

/** Resolve only the flagged contributions, preserving their final wording/times. */
export function resolveSpeakerIssue(
  doc: MeetingTranscript,
  speaker: string,
  target: string,
): MeetingTranscript {
  const issue = doc.speakerIssues?.find((i) => i.speaker === speaker);
  if (!issue) return doc;
  const person = doc.liveSpeakers?.[target];
  const source = person?.source;
  return {
    ...doc,
    turns: doc.turns.map((t) =>
      issue.turnIds.includes(t.id)
        ? {
            ...t,
            speaker: target,
            ...(source ? { source, sourceEvidence: "manual" as const } : {}),
          }
        : t,
    ),
    speakerNames: {
      ...doc.speakerNames,
      ...(person ? { [target]: person.name } : {}),
    },
    speakerAliases: {
      ...doc.speakerAliases,
      ...(person?.alias ? { [target]: person.alias } : {}),
    },
    speakerIssues: doc.speakerIssues!.filter((i) => i !== issue),
  };
}
