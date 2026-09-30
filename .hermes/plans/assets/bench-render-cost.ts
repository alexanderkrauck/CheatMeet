// Cost of ONE published live event as the meeting grows, using the repo's real functions.
// Per event the app runs liveDocument() (assemblyLive.doc) and renderTranscript() (capture.ts callback).
import { renderTranscript } from "./shared/transcription";
import { AssemblyEvents, liveDocument } from "./src/lib/assemblyEvents";

const WORDS = "Das ist ein Satz mit ungefähr zwölf Wörtern und einer Zeitangabe dabei".split(" ");
function build(turns: number) {
  const ev = new AssemblyEvents("mic:0", (ms) => ms);
  for (let i = 0; i < turns; i++)
    ev.apply({
      type: "Turn", turn_order: i, end_of_turn: true,
      words: WORDS.map((text, k) => ({ text, start: i * 5000 + k * 300, end: i * 5000 + k * 300 + 250, speaker: "ABCD"[i % 4] })),
    });
  return ev;
}
const median = (fn: () => void, runs = 7) => {
  const t: number[] = [];
  for (let r = 0; r < runs; r++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
  return t.sort((a, b) => a - b)[Math.floor(runs / 2)];
};
console.log("turns | liveDocument ms | renderTranscript ms | per event ms | max events/s the main thread can absorb");
for (const n of [250, 500, 1000, 2000, 4000]) {
  const ev = build(n);
  let doc = liveDocument(["de"], [ev], false);
  const names: Record<string, string> = {};
  for (const t of doc.turns) names[t.speaker] ||= `Sprecher ${Object.keys(names).length + 1}`;
  doc = { ...doc, speakerNames: names }; // as assemblyLive.doc() does, so the fast lookup path is exercised
  const a = median(() => liveDocument(["de"], [ev], false));
  const b = median(() => renderTranscript(doc));
  console.log(`${String(doc.turns.length).padStart(5)} | ${a.toFixed(2).padStart(15)} | ${b.toFixed(2).padStart(19)} | ${(a + b).toFixed(2).padStart(12)} | ${(1000 / (a + b)).toFixed(1)}`);
}
