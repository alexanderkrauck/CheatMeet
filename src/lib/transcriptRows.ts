import { speakerLabeler, turnSource, type MeetingTranscript } from "../../shared/transcription";
import { formatTimestamp, parseTranscript, type TranscriptLine } from "./transcriptAssembler";

/** Prefer saved source and identity evidence over lossy display-name parsing. */
export function transcriptRows(transcript: string, speech?: MeetingTranscript): TranscriptLine[] {
  if (!speech) return parseTranscript(transcript);
  const label = speakerLabeler(speech);
  return [...speech.turns].sort((a, b) => a.startMs - b.startMs).map(turn => ({
    id: turn.id,
    at: formatTimestamp(turn.startMs),
    source: turnSource(turn),
    speaker: label(turn),
    speakerId: turn.speaker,
    text: turn.text,
  }));
}
