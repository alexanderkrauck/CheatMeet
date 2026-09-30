import { describe, expect, it } from "vitest";
import {
  CAPTURE_SOURCE_LABELS,
  renderTranscript,
  speakerLabel,
  speakerLabeler,
  turnSource,
  type MeetingTranscript,
  type SpeechTurn,
} from "./transcription";

// The implementation this replaced, kept verbatim as the reference: a
// quadratic speaker-order lookup per turn. Output must stay byte-identical.
function referenceLabel(doc: MeetingTranscript, turn: SpeechTurn): string {
  if (turn.speaker.endsWith(":unknown")) return "Stimme nicht zugeordnet";
  const speakers = [...new Set(doc.turns.map((t) => t.speaker))];
  return (
    doc.speakerNames[turn.speaker] ||
    doc.speakerNameSuggestions?.[turn.speaker] ||
    `Sprecher ${speakers.indexOf(turn.speaker) + 1}`
  );
}
function referenceRender(doc: MeetingTranscript): string {
  const stamp = (ms: number) => {
    const s = Math.floor(Math.max(0, ms) / 1000);
    return s >= 3600
      ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
      : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return [...doc.turns]
    .sort((a, b) => a.startMs - b.startMs)
    .map((t) => {
      const source = turnSource(t);
      const name = `${source ? CAPTURE_SOURCE_LABELS[source] + " · " : ""}${referenceLabel(doc, t)}`;
      return `[${stamp(t.startMs)}] (${name.replace(/[()\r\n]/g, " ")}) ${t.text}`;
    })
    .join("\n\n");
}

/** Small deterministic generator so a failure is reproducible from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function document(seed: number): MeetingTranscript {
  const next = random(seed);
  const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)];
  const speakers = ["mic:0:A", "mic:0:B", "mic:single", "system:0:A", "system:1:C", "mic:unknown", "system:unknown", "x"];
  const turns: SpeechTurn[] = Array.from({ length: Math.floor(next() * 40) }, (_, i) => ({
    id: `t${i}`,
    startMs: Math.floor(next() * 4_000_000),
    endMs: 0,
    speaker: pick(speakers),
    text: pick(["Hallo", "Guten Tag (kurz)", "zwei\nZeilen", "", "Ende"]),
    final: next() > 0.2,
  }));
  const names: Record<string, string> = {};
  const suggestions: Record<string, string> = {};
  for (const speaker of speakers) {
    if (next() > 0.6) names[speaker] = pick(["Anna", "", "Bob (Chef)", "Cem"]);
    if (next() > 0.7) suggestions[speaker] = pick(["Dora", "Eva"]);
  }
  return {
    provider: "assemblyai",
    phase: "live",
    languages: ["de"],
    turns,
    speakerNames: names,
    ...(next() > 0.5 ? { speakerNameSuggestions: suggestions } : {}),
  };
}

describe("speakerLabeler", () => {
  it("labels every turn exactly as the one-call function always did, over 300 random documents", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const doc = document(seed);
      const label = speakerLabeler(doc);
      for (const turn of doc.turns)
        expect(label(turn), `seed ${seed}`).toBe(referenceLabel(doc, turn));
    }
  });

  it("renders byte-identical transcripts over the same documents", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const doc = document(seed);
      expect(renderTranscript(doc), `seed ${seed}`).toBe(referenceRender(doc));
    }
  });

  it("keeps speakerLabel(doc, turn) working for single-turn callers", () => {
    const doc = document(7);
    for (const turn of doc.turns) expect(speakerLabel(doc, turn)).toBe(referenceLabel(doc, turn));
  });

  it("numbers unnamed speakers by first appearance in the turn list, not by time", () => {
    const doc: MeetingTranscript = {
      provider: "assemblyai", phase: "live", languages: ["de"], speakerNames: {},
      turns: [
        { id: "a", startMs: 9000, endMs: 0, speaker: "s1", text: "spät", final: true },
        { id: "b", startMs: 1000, endMs: 0, speaker: "s2", text: "früh", final: true },
      ],
    };
    const label = speakerLabeler(doc);
    expect([label(doc.turns[0]), label(doc.turns[1])]).toEqual(["Sprecher 1", "Sprecher 2"]);
  });

  it("renders 4000 entries fast enough for a live transcript (was ~200 ms per render)", () => {
    const turns: SpeechTurn[] = Array.from({ length: 4000 }, (_, i) => ({
      id: `t${i}`, startMs: i * 1000, endMs: i * 1000 + 900, speaker: `mic:0:${"ABCD"[i % 4]}`,
      text: "Das ist ein Satz mit ungefähr zwölf Wörtern und einer Zeitangabe dabei", final: true,
    }));
    const doc: MeetingTranscript = { provider: "assemblyai", phase: "live", languages: ["de"], turns, speakerNames: {} };
    renderTranscript(doc); // warm-up
    const runs = Array.from({ length: 5 }, () => {
      const start = performance.now();
      renderTranscript(doc);
      return performance.now() - start;
    }).sort((a, b) => a - b);
    expect(runs[2]).toBeLessThan(40);
  });
});
