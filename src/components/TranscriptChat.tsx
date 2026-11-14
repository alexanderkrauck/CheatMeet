import {
  CAPTURE_SOURCE_LABELS,
  type MeetingTranscript,
} from "../../shared/transcription";
import { transcriptRows } from "../lib/transcriptRows";
import type { SpeakerFilter } from "./LiveSpeakers";
import type { ReactNode } from "react";
import { Play } from "lucide-react";
import InlineSpeakerName from "./InlineSpeakerName";
import { SOURCE_LABELS, parseTimestamp } from "../lib/transcriptAssembler";
import "./meeting-audio.css";

/** Live capture keeps its source placement; finished reports opt into document rows. */
export default function TranscriptChat({
  transcript,
  speech,
  filter = "all",
  onRename,
  onEditing,
  editingDisabled = false,
  onListen,
  onEditTurn,
  query = "",
  renderText,
  startedAt,
  variant = "live",
  positionMs,
  playing = false,
  empty = "Kein Transkript vorhanden.",
}: {
  transcript: string;
  speech?: MeetingTranscript;
  filter?: SpeakerFilter;
  onRename?: (id: string, name: string) => void;
  onEditing?: (editing: boolean) => void;
  editingDisabled?: boolean;
  onListen?: (atMs: number) => void;
  onEditTurn?: (turnId: string) => void;
  query?: string;
  renderText?: (text: string) => ReactNode;
  /** Recording start, so a relative offset can also be shown as a wall clock. */
  startedAt?: string;
  variant?: "live" | "document";
  positionMs?: number;
  playing?: boolean;
  empty?: string;
}) {
  const began = startedAt ? Date.parse(startedAt) : NaN;
  const wallClock = (atMs: number | null) => {
    if (!Number.isFinite(began) || atMs === null) return "";
    return new Date(began + atMs).toLocaleTimeString("de-AT", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };
  const turns = new Map(speech?.turns.map((turn) => [turn.id, turn]));
  const allRows = transcriptRows(transcript, speech).map(
    (row, originalIndex) => {
      const turn = row.id ? turns.get(row.id) : undefined;
      // Do not turn malformed legacy stamps such as 0:99 into a new seek time.
      const validStamp = row.at
        .split(":")
        .slice(1)
        .every((part) => Number(part) < 60);
      const parsed = turn
        ? turn.startMs
        : validStamp
          ? parseTimestamp(row.at)
          : null;
      const atMs =
        parsed !== null && Number.isFinite(parsed) && parsed >= 0
          ? parsed
          : null;
      return {
        row,
        originalIndex,
        atMs,
        untilMs:
          turn &&
          Number.isFinite(turn.endMs) &&
          atMs !== null &&
          turn.endMs > atMs
            ? turn.endMs
            : Infinity,
      };
    },
  );
  // Compute bounds BEFORE filtering: a hidden next speaker must stop the
  // previous passage being presented as current. Retain exact saved offsets.
  let nextStart = Infinity;
  for (let index = allRows.length - 1; index >= 0; index--) {
    const entry = allRows[index];
    if (entry.atMs === null) continue;
    entry.untilMs = Math.min(entry.untilMs, nextStart);
    nextStart = entry.atMs;
  }
  const rows = allRows.filter(
    ({ row }) =>
      (filter === "all" ||
        row.source === filter ||
        `speaker:${row.speakerId}` === filter) &&
      row.text.toLowerCase().includes(query.trim().toLowerCase()),
  );
  if (!rows.length)
    return <p className="live-empty transcript-empty">{empty}</p>;
  const labelled = rows.some(
    ({ row }) => row.speaker || row.source === "system",
  );
  return (
    <div className={`chat transcript-chat is-${variant}`}>
      {rows.map(({ row, originalIndex, atMs, untilMs }, index) => {
        const continued =
          index > 0 &&
          rows[index - 1].row.source === row.source &&
          (rows[index - 1].row.speakerId ||
            rows[index - 1].row.speaker ||
            rows[index - 1].row.source) ===
            (row.speakerId || row.speaker || row.source);
        const active =
          positionMs !== undefined &&
          Number.isFinite(positionMs) &&
          atMs !== null &&
          positionMs >= atMs &&
          positionMs < untilMs;
        const clock = wallClock(atMs);
        return (
          <div
            className={`chat-turn is-${labelled ? row.source || "unknown" : "single"}${continued && variant === "live" ? " is-continued" : ""}${active ? " is-current" : ""}${active && playing ? " is-playing" : ""}`}
            key={row.id || originalIndex}
            aria-current={active ? "time" : undefined}
          >
            <div className="transcript-passage-time">
              {onListen && atMs !== null ? (
                <button
                  type="button"
                  className="transcript-play no-print"
                  aria-label={`Aufnahme ab ${(atMs / 1000).toLocaleString("de-AT", { maximumFractionDigits: 3 })} ${atMs === 1000 ? "Sekunde" : "Sekunden"} abspielen`}
                  onClick={() => onListen(atMs)}
                >
                  <Play size={13} aria-hidden="true" />
                  <time>{row.at}</time>
                  <span className="transcript-play-label">Abspielen</span>
                </button>
              ) : atMs !== null ? (
                <time className="transcript-stamp">{row.at}</time>
              ) : variant === "document" ? (
                <span className="transcript-untimed">Ohne Zeitmarke</span>
              ) : null}
              {clock && <span className="transcript-clock">{clock} Uhr</span>}
              {active && (
                <span className="transcript-current no-print">
                  {playing ? "Läuft" : "Aktuelle Position"}
                </span>
              )}
            </div>
            <div className="transcript-passage-body">
              {labelled &&
                (row.speaker || row.source) &&
                (variant === "document" || !continued || row.source) && (
                  <div className="chat-meta">
                    {row.source && (
                      <span className={`transcript-source is-${row.source}`}>
                        {CAPTURE_SOURCE_LABELS[row.source]}
                      </span>
                    )}
                    {!row.source && speech?.phase === "final" && (
                      <span className="transcript-source is-unknown">
                        Audioquelle offen
                      </span>
                    )}
                    {onRename &&
                    row.speakerId &&
                    !row.speakerId.endsWith(":unknown") ? (
                      <InlineSpeakerName
                        key={row.speakerId}
                        id={row.speakerId}
                        name={row.speaker!}
                        source={
                          row.source
                            ? CAPTURE_SOURCE_LABELS[row.source]
                            : "Audio"
                        }
                        onRename={onRename}
                        onEditing={onEditing}
                        disabled={editingDisabled}
                      />
                    ) : (
                      row.speaker || SOURCE_LABELS[row.source!]
                    )}
                  </div>
                )}
              <p className="chat-bubble">
                <span>{renderText ? renderText(row.text) : row.text}</span>
              </p>
              {onEditTurn && row.id && (
                <button
                  type="button"
                  className="btn btn-ghost transcript-edit no-print"
                  disabled={editingDisabled}
                  aria-label={`Beitrag ${originalIndex + 1} korrigieren`}
                  onClick={() => onEditTurn(row.id!)}
                >
                  Korrigieren
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
