import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import TranscriptChat from "../components/TranscriptChat";
import { transcriptRows } from "./transcriptRows";
import { renameSpeaker, renderTranscript, type MeetingTranscript } from "../../shared/transcription";
const speech: MeetingTranscript = {
  provider: "assemblyai", phase: "live", languages: ["de", "en"],
  speakerNames: { "mic:0:A": "Sprecher 1", "system:1:A": "Sprecher 1" },
  turns: [
    { id: "mic:0:0", speaker: "mic:0:A", startMs: 0, endMs: 1000, text: "Meine Antwort", final: true },
    { id: "system:1:0", speaker: "system:1:A", startMs: 1000, endMs: 2000, text: "Frage aus Teams", final: true },
    { id: "mic:0:1", speaker: "mic:0:unknown", startMs: 2000, endMs: 2500, text: "Ja", final: false },
  ],
};
it("renders microphone and system on distinct sides even with identical or unknown speaker names", () => {
  const rows = transcriptRows("old generic labels", speech);
  expect(rows.map(r => r.source)).toEqual(["mic", "system", "mic"]);
  expect(rows[2].speaker).toBe("Stimme nicht zugeordnet");
  const markup = renderToStaticMarkup(createElement(TranscriptChat, { transcript: "", speech }));
  expect(markup.match(/chat-turn is-mic/g)).toHaveLength(2);
  expect(markup.match(/chat-turn is-system/g)).toHaveLength(1);
  expect(markup).toContain("Mikrofon"); expect(markup).toContain("Systemaudio");
  expect(markup).not.toContain("is-continued");
});
it("filters by reliable source and keeps source labels through exports and renamed speakers", () => {
  const named = renameSpeaker(speech, "mic:0:A", "Alex");
  expect(named.speakerAliases).toEqual({ "mic:0:A": "Alex" });
  const text = renderTranscript(named);
  expect(text).toContain("Mikrofon · Alex");
  expect(transcriptRows(text).map(r => r.source)).toEqual(["mic", "system", "mic"]);
  const markup = renderToStaticMarkup(createElement(TranscriptChat, { transcript: "", speech: named, filter: "system" }));
  expect(markup).toContain("Frage aus Teams"); expect(markup).not.toContain("Meine Antwort");
});
