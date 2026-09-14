import {
  SOURCE_LABELS,
  parseTimestamp,
  parseTranscript,
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
  startedAt,
  empty = "Kein Transkript vorhanden.",
}: {
  transcript: string;
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
  const rows = parseTranscript(transcript);
  if (!rows.length) return <p className="live-empty">{empty}</p>;
  const labelled = rows.some((row) => row.speaker || row.source === "system");
  return (
    <div className="chat">
      {rows.map((row, index) => {
        // Only label a change of speaker, so a run of turns reads as one voice.
        const continued = index > 0 && (rows[index - 1].speaker || rows[index - 1].source) === (row.speaker || row.source);
        return (
          <div
            className={`chat-turn is-${labelled ? row.source || "unknown" : "single"}${continued ? " is-continued" : ""}`}
            key={index}
          >
            {labelled && (row.speaker || row.source) && !continued && (
              <span className="chat-meta">{row.speaker || SOURCE_LABELS[row.source!]}</span>
            )}
            <p className="chat-bubble">
              <span>{row.text}</span>
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
