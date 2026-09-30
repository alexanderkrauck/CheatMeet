// PROTOTYPE, measurement only. The plan's real change is tested against the repo's own function.
// Same output as shared/transcription.ts renderTranscript, but the speaker numbering is built once per render.
import { renderTranscript, turnSource, CAPTURE_SOURCE_LABELS, type MeetingTranscript } from "./shared/transcription";
import { AssemblyEvents, liveDocument } from "./src/lib/assemblyEvents";

const stamp = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
function renderFast(doc: MeetingTranscript): string {
  const order = new Map<string, number>();
  for (const t of doc.turns) if (!order.has(t.speaker)) order.set(t.speaker, order.size + 1);
  const label = (speaker: string) =>
    speaker.endsWith(":unknown") ? "Stimme nicht zugeordnet"
      : doc.speakerNames[speaker] || doc.speakerNameSuggestions?.[speaker] || `Sprecher ${order.get(speaker)}`;
  return [...doc.turns].sort((a, b) => a.startMs - b.startMs).map((t) => {
    const source = turnSource(t);
    const name = `${source ? CAPTURE_SOURCE_LABELS[source] + " · " : ""}${label(t.speaker)}`;
    return `[${stamp(t.startMs)}] (${name.replace(/[()\r\n]/g, " ")}) ${t.text}`;
  }).join("\n\n");
}

const WORDS = "Das ist ein Satz mit ungefähr zwölf Wörtern und einer Zeitangabe dabei".split(" ");
const build = (turns: number, sources: string[]) => {
  const evs = sources.map((s) => new AssemblyEvents(`${s}:0`, (ms) => ms));
  for (const [k, ev] of evs.entries())
    for (let i = 0; i < turns; i++)
      ev.apply({ type: "Turn", turn_order: i, end_of_turn: true,
        words: WORDS.map((text, w) => ({ text, start: i * 5000 + k * 137 + w * 300, end: i * 5000 + k * 137 + w * 300 + 250, speaker: "ABCD"[(i + k) % 4] })) });
  return evs;
};
const median = (fn: () => unknown, runs = 9) => {
  const t: number[] = [];
  for (let r = 0; r < runs; r++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
  return t.sort((a, b) => a - b)[Math.floor(runs / 2)];
};
console.log("entries | renderTranscript today | prototype | speed-up | identical output");
for (const perSource of [250, 500, 1000, 2000]) {
  const evs = build(perSource, ["mic", "system"]);
  let doc = liveDocument(["de"], evs, false);
  const names: Record<string, string> = {};
  for (const t of doc.turns) names[t.speaker] ||= `Sprecher ${Object.keys(names).length + 1}`;
  doc = { ...doc, speakerNames: { ...names, [Object.keys(names)[0]]: "" } }; // one unnamed speaker exercises the numbering path
  const today = median(() => renderTranscript(doc), 5);
  const fast = median(() => renderFast(doc));
  console.log(`${String(doc.turns.length).padStart(7)} | ${today.toFixed(1).padStart(19)} ms | ${fast.toFixed(2).padStart(6)} ms | ${(today / fast).toFixed(0).padStart(6)}x | ${renderTranscript(doc) === renderFast(doc)}`);
}
