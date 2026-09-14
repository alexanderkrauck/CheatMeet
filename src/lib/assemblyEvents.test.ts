import { describe, expect, it } from "vitest";
import { AssemblyEvents, liveDocument } from "./assemblyEvents";
import {
  batchTranscript,
  mergeSpeaker,
  renameSpeaker,
  renderTranscript,
} from "../../shared/transcription";

const word = (text: string, start: number, speaker = "A") => ({
  text,
  start,
  end: start + 100,
  speaker,
});
describe("AssemblyAI transcript assembly", () => {
  it("replaces partials and duplicate finals; a late partial cannot undo a final", () => {
    const events = new AssemblyEvents("mic:0", (t) => t + 1000);
    const update = (words: any[], final: boolean) =>
      events.apply({ type: "Turn", turn_order: 0, words, end_of_turn: final });
    update([word("nicht", 0)], false);
    expect(events.entries(false)).toEqual([]);
    update([word("nicht", 0), word("freigegeben", 100)], true);
    update([word("nicht", 0), word("freigegeben", 100)], true);
    update([word("freigegeben", 0)], false);
    expect(events.entries()).toEqual([
      {
        id: "mic:0:0:0",
        speaker: "mic:0:A",
        startMs: 1000,
        endMs: 1200,
        text: "nicht freigegeben",
        final: true,
      },
    ]);
  });
  it("applies word-level speaker revisions without copying revised text", () => {
    const events = new AssemblyEvents("system:0", (t) => t);
    events.apply({
      type: "Turn",
      turn_order: 7,
      end_of_turn: true,
      words: [word("Frage", 0), word("Antwort", 100)],
    });
    events.apply({
      type: "SpeakerRevision",
      revisions: [
        {
          turn_order: 7,
          speaker_label: "B",
          words: [{ ...word("erfunden", 100, "B") }],
        },
      ],
    });
    expect(events.entries().map((t) => [t.speaker, t.text])).toEqual([
      ["system:0:A", "Frage"],
      ["system:0:B", "Antwort"],
    ]);
  });
  it("keeps source/session identities distinct and unknown attribution explicit", () => {
    const events = ["mic:0", "system:0", "mic:1"].map(
      (id) => new AssemblyEvents(id, (t) => t),
    );
    for (const e of events)
      e.apply({
        type: "Turn",
        turn_order: 0,
        end_of_turn: true,
        words: [word("Hallo", 0)],
      });
    expect(
      new Set(liveDocument(["de"], events, true).turns.map((t) => t.speaker))
        .size,
    ).toBe(3);
    events[0].apply({
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      words: [word("Ja", 500, "PENDING")],
    });
    expect(events[0].entries().at(-1)?.speaker).toBe("mic:0:unknown");
  });
  it("rejects malformed provider times instead of silently dropping speech", () => {
    expect(() =>
      batchTranscript(
        {
          status: "completed",
          utterances: [{ text: "Hallo", start: -1, end: 10 }],
        },
        ["de"],
      ),
    ).toThrow();
  });
  it("renames and merges final speakers while preserving turn IDs, timing and wording", () => {
    const doc = batchTranscript(
      {
        status: "completed",
        utterances: [
          { text: "Keine Zusage.", start: 100, end: 200, speaker: "A" },
          { text: "Ich prüfe das.", start: 1000, end: 2000, speaker: "B" },
        ],
      },
      ["de"],
    );
    const renamed = renameSpeaker(doc, "batch:A", "Nina");
    const merged = mergeSpeaker(renamed, "batch:B", "batch:A");
    expect(doc.turns[1].speaker).toBe("batch:B");
    expect(merged.turns[1]).toEqual({ ...doc.turns[1], speaker: "batch:A" });
    expect(renderTranscript(merged)).toBe(
      "[0:00] (Nina) Keine Zusage.\n\n[0:01] (Nina) Ich prüfe das.",
    );
  });
});
