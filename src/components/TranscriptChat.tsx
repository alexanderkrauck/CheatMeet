import { CAPTURE_SOURCE_LABELS, type MeetingTranscript } from "../../shared/transcription";
import { transcriptRows } from "../lib/transcriptRows";
import type { SpeakerFilter } from "./LiveSpeakers";
import type { ReactNode } from "react";
import InlineSpeakerName from "./InlineSpeakerName";
import {
  SOURCE_LABELS,
  parseTimestamp,
} from "../lib/transcriptAssembler";

/**
 * Renders a stored transcript as a conversation: microphone on one side,
 * system audio on the other, each turn stamped with its time. Shared by the
 * live meeting screen and the finished report so both read the same way.
 *
 * A recording with a single source carries no speaker labels, because on a
 * phone there is only one channel and claiming "Du" would assert a speaker
 * separation that does not exist.
 */
export default function TranscriptChat({
  transcript,
  speech,
  filter = "all",
  onRename,
  onEditing,
  query = "",
  renderText,
  startedAt,
  empty = "Kein Transkript vorhanden.",
}: {
  transcript: string;
  speech?: MeetingTranscript;
  filter?: SpeakerFilter;
  onRename?: (id: string, name: string) => void;
  onEditing?: (editing: boolean) => void;
  query?: string;
  renderText?: (text: string) => ReactNode;
  /** Recording start, so a relative offset can also be shown as a wall clock. */
  startedAt?: string;
  empty?: string;
}) {
  const began = startedAt ? Date.parse(startedAt) : NaN;
  const wallClock = (at: string) => {
    const offset = parseTimestamp(at);
    if (!Number.isFinite(began) || offset === null) return "";
    return new Date(began + offset).toLocaleTimeString("de-AT", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };
  const rows = transcriptRows(transcript, speech).filter(row =>
    (filter === "all" || row.source === filter || `speaker:${row.speakerId}` === filter)
    && row.text.toLowerCase().includes(query.trim().toLowerCase()));
  if (!rows.length) return <p className="live-empty">{empty}</p>;
  const labelled = rows.some((row) => row.speaker || row.source === "system");
  return (
    <div className="chat">
      {rows.map((row, index) => {
        // Only label a change of speaker, so a run of turns reads as one voice.
        const continued = index > 0 && rows[index - 1].source === row.source && (rows[index - 1].speakerId || rows[index - 1].speaker || rows[index - 1].source) === (row.speakerId || row.speaker || row.source);
        return (
          <div
            className={`chat-turn is-${labelled ? row.source || "unknown" : "single"}${continued ? " is-continued" : ""}`}
            key={row.id || index}
          >
            {labelled && (row.speaker || row.source) && (!continued || row.source) && (
              <span className="chat-meta">{row.source && <span className={`transcript-source is-${row.source}`}>{CAPTURE_SOURCE_LABELS[row.source]}</span>}
                {!row.source && speech?.phase === "final" && <span className="transcript-source is-unknown">Audioquelle offen</span>}
                {onRename && row.speakerId && !row.speakerId.endsWith(":unknown")
                  ? <InlineSpeakerName key={row.speakerId} id={row.speakerId} name={row.speaker!}
                      source={row.source ? CAPTURE_SOURCE_LABELS[row.source] : "Audio"}
                      onRename={onRename} onEditing={onEditing} />
                  : row.speaker || SOURCE_LABELS[row.source!]}</span>
            )}
            <p className="chat-bubble">
              <span>{renderText ? renderText(row.text) : row.text}</span>
              {row.at && (
                <time className="chat-time">
                  {row.at}
                  {wallClock(row.at) && (
                    <span className="chat-clock"> · {wallClock(row.at)}</span>
                  )}
                </time>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
