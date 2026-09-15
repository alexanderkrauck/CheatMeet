import {
  speakerLabel,
  CAPTURE_SOURCE_LABELS,
  type MeetingTranscript,
} from "../../shared/transcription";
import { resolveSpeakerIssue } from "../lib/speakerMatches";

/** Only unresolved groups are shown; accepted live names never need re-entry. */
export default function SpeakerReview({
  speech,
  onChange,
  onListen,
}: {
  speech: MeetingTranscript;
  onChange: (speech: MeetingTranscript) => void;
  onListen: (atMs: number) => void;
}) {
  const issues =
    speech.speakerIssues ||
    [...new Set(speech.turns.map((t) => t.speaker))].map((speaker) => ({
      speaker,
      turnIds: speech.turns
        .filter((t) => t.speaker === speaker)
        .map((t) => t.id),
      candidates: [],
      reason: "unmatched" as const,
    }));
  const candidates = Object.entries(speech.liveSpeakers || {});
  return (
    <div className="speaker-quick-review">
      {issues.length === 0 ? (
        <p>Alles zugeordnet. Du kannst fortfahren.</p>
      ) : (
        issues.map((issue) => {
          const turn = speech.turns.find((t) => issue.turnIds.includes(t.id));
          if (!turn) return null;
          const label = speakerLabel(speech, turn);
          return (
            <div className="speaker-quick-row" key={issue.speaker}>
              <div>
                <strong>{label}</strong>
                <small>
                  {issue.reason === "ambiguous"
                    ? "Mehrere Stimmen passen"
                    : "Noch kein eindeutiger Live-Treffer"}
                </small>
              </div>
              <p>
                „{turn.text.slice(0, 180)}
                {turn.text.length > 180 ? "…" : ""}“
              </p>
              <div className="speaker-quick-actions">
                <button className="btn" onClick={() => onListen(turn.startMs)}>
                  Anhören
                </button>
                {candidates.length > 0 && (
                  <select
                    className="field"
                    aria-label={`Zuordnung für ${label}`}
                    value=""
                    onChange={(event) => {
                      if (event.target.value)
                        onChange(
                          resolveSpeakerIssue(
                            speech,
                            issue.speaker,
                            event.target.value,
                          ),
                        );
                    }}
                  >
                    <option value="">Person auswählen …</option>
                    {[...candidates]
                      .sort(
                        ([a], [b]) =>
                          Number(issue.candidates.includes(b)) -
                          Number(issue.candidates.includes(a)),
                      )
                      .map(([id, person]) => (
                        <option key={id} value={id}>
                          {person.source
                            ? `${CAPTURE_SOURCE_LABELS[person.source]} · `
                            : ""}
                          {person.name}
                        </option>
                      ))}
                  </select>
                )}
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    onChange(
                      resolveSpeakerIssue(
                        { ...speech, speakerIssues: issues },
                        issue.speaker,
                        issue.speaker,
                      ),
                    )
                  }
                >
                  So lassen
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
