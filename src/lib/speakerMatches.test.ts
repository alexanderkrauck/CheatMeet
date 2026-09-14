import { expect, it } from "vitest";
import { reconcileSpeakers, resolveSpeakerIssue } from "./speakerMatches";
import {
  needsSpeakerReview,
  renderTranscript,
  type MeetingTranscript,
  type SpeechTurn,
} from "../../shared/transcription";
const turn = (i: number, speaker: string, text: string): SpeechTurn => ({
  id: `t${i}`,
  speaker,
  text,
  startMs: i * 10000,
  endMs: i * 10000 + 5000,
  final: true,
});
const texts = [
  "Wir haben heute den Vertrag gemeinsam geprüft und noch keine Zusage erteilt",
  "Bitte senden Sie uns die aktualisierte Fassung mit allen neuen Konditionen morgen",
];
const english =
  "We will share the detailed financial results after our next monthly board meeting";
const doc = (turns: SpeechTurn[]): MeetingTranscript => ({
  provider: "assemblyai",
  phase: "live",
  languages: ["de"],
  turns,
  speakerNames: {},
});
const named = (turns: SpeechTurn[]) => ({
  ...doc(turns),
  speakerNames: { "mic:0:A": "Alex", "system:1:A": "Fireship" },
  speakerAliases: { "mic:0:A": "Alex", "system:1:A": "Fireship" },
});
const finalDoc = (turns: SpeechTurn[]) => ({
  ...doc(turns),
  phase: "final" as const,
});
it("automatically preserves names and sources through changed provider labels and batch grouping", () => {
  const live = named([
    turn(0, "mic:0:A", texts[0]),
    turn(1, "mic:0:A", texts[1]),
    turn(3, "system:1:A", english),
  ]);
  const final = finalDoc([
    { ...turn(0, "batch:C", texts.join(" ")), endMs: 15000 },
    turn(3, "batch:B", english),
  ]);
  const result = reconcileSpeakers(live, final);
  expect(result.turns.map((t) => [t.speaker, t.source])).toEqual([
    ["mic:0:A", "mic"],
    ["system:1:A", "system"],
  ]);
  expect(result.speakerAliases).toEqual(live.speakerAliases);
  expect(result.speakerReview).toBe("matched");
  expect(needsSpeakerReview(result)).toBe(false);
  expect(renderTranscript(result)).toContain("Mikrofon · Alex");
  expect(renderTranscript(result)).toContain("Systemaudio · Fireship");
  expect(result.turns.map((t) => [t.id, t.text, t.startMs, t.endMs])).toEqual(
    final.turns.map((t) => [t.id, t.text, t.startMs, t.endMs]),
  );
  expect(final.speakerNames).toEqual({});
});
it("accepts one long utterance for a named speaker, without requiring two batch turns", () => {
  const live = named([turn(0, "mic:0:A", texts[0])]);
  expect(
    reconcileSpeakers(live, finalDoc([turn(0, "batch:X", texts[0])]))
      .speakerReview,
  ).toBe("matched");
});
it("tolerates transcription corrections without matching unrelated times", () => {
  const live = named([turn(0, "mic:0:A", texts.join(" "))]);
  const result = reconcileSpeakers(
    live,
    finalDoc([
      turn(
        0,
        "batch:X",
        texts
          .join(" ")
          .replace("heute", "gestern")
          .replace("morgen", "nächste Woche"),
      ),
    ]),
  );
  expect(result.turns[0].speaker).toBe("mic:0:A");
  expect(
    reconcileSpeakers(live, finalDoc([turn(10, "batch:X", texts.join(" "))]))
      .speakerReview,
  ).toBe("pending");
});
it("reunites final labels split from the same named live identity", () => {
  const live = named(texts.map((text, i) => turn(i, "mic:0:A", text)));
  const result = reconcileSpeakers(
    live,
    finalDoc(live.turns.map((t, i) => ({ ...t, speaker: `batch:${i}` }))),
  );
  expect(new Set(result.turns.map((t) => t.speaker))).toEqual(
    new Set(["mic:0:A"]),
  );
  expect(result.speakerIssues).toEqual([]);
});
it("separates a merged batch speaker by clear per-turn live evidence", () => {
  const live = named([
    turn(0, "mic:0:A", texts[0]),
    turn(1, "system:1:A", english),
  ]);
  const result = reconcileSpeakers(
    live,
    finalDoc(live.turns.map((t) => ({ ...t, speaker: "batch:A" }))),
  );
  expect(result.turns.map((t) => t.source)).toEqual(["mic", "system"]);
  expect(result.speakerIssues).toEqual([]);
});
it("asks only about the unresolved group and retains all original names as choices", () => {
  const live = named([
    turn(0, "mic:0:A", texts[0]),
    turn(1, "system:1:A", english),
  ]);
  const result = reconcileSpeakers(
    live,
    finalDoc([
      turn(0, "batch:A", texts[0]),
      turn(5, "batch:B", "Ganz anderer Inhalt ohne sichere Verbindung"),
    ]),
  );
  expect(result.speakerIssues?.map((i) => i.speaker)).toEqual(["batch:B"]);
  expect(result.liveSpeakers?.["system:1:A"].alias).toBe("Fireship");
  const resolved = resolveSpeakerIssue(result, "batch:B", "system:1:A");
  expect(resolved.speakerIssues).toEqual([]);
  expect(resolved.turns[1]).toMatchObject({
    speaker: "system:1:A",
    source: "system",
    text: result.turns[1].text,
  });
  expect(resolved.speakerNames["system:1:A"]).toBe("Fireship");
});
it("does not silently attribute a mixed-source utterance or echo to the dominant speaker", () => {
  const live = named([
    turn(0, "mic:0:A", texts[0]),
    turn(0, "system:1:A", english),
  ]);
  const mixed = reconcileSpeakers(
    live,
    finalDoc([turn(0, "batch:A", texts[0] + " " + english)]),
  );
  expect(mixed.turns[0].source).toBeUndefined();
  expect(mixed.speakerIssues?.[0].reason).toBe("ambiguous");
  const echo = named([
    turn(0, "mic:0:A", texts[0]),
    turn(0, "system:1:A", texts[0]),
  ]);
  expect(
    reconcileSpeakers(echo, finalDoc([turn(0, "batch:A", texts[0])]))
      .speakerIssues?.[0].reason,
  ).toBe("ambiguous");
});
it("does not infer identities from short acknowledgments or provider letters", () => {
  const live = named([turn(0, "mic:0:A", "Ja danke")]);
  const result = reconcileSpeakers(live, finalDoc([turn(0,"batch:A","Ja danke")]));
  expect(result.speakerAliases).toEqual({});
  expect(result.speakerIssues).toHaveLength(1);
});
it("can confirm a named live partial against final words without copying unfinished live text", () => {
  const live = named([{...turn(0,"mic:0:A",texts[0] + " eventuell erfundener Zusatz"),final:false}]);
  const result = reconcileSpeakers(live,finalDoc([turn(0,"batch:B",texts[0])]));
  expect(result.speakerReview).toBe("matched");
  expect(result.turns[0].speaker).toBe("mic:0:A");
  expect(result.turns[0].text).toBe(texts[0]);
});

it("carries stable identity to short final turns, but does not erase conflicting long-turn evidence", () => {
  const live = named([turn(0, "mic:0:A", texts[0]), turn(1, "mic:0:A", "Ja")]);
  const result = reconcileSpeakers(
    live,
    finalDoc([turn(0, "batch:B", texts[0]), turn(1, "batch:B", "Ja")]),
  );
  expect(result.turns.map((t) => t.speaker)).toEqual(["mic:0:A", "mic:0:A"]);
  expect(result.speakerIssues).toEqual([]);
});
it("skips review when a final result is empty", () => {
  expect(needsSpeakerReview(reconcileSpeakers(named([]), finalDoc([])))).toBe(
    false,
  );
});
