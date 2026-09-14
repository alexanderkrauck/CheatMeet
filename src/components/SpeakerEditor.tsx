import {
  mergeSpeaker,
  renameSpeaker,
  type MeetingTranscript,
} from "../../shared/transcription";

export default function SpeakerEditor({
  speech,
  onChange,
}: {
  speech: MeetingTranscript;
  onChange: (speech: MeetingTranscript) => void;
}) {
  const speakers = [...new Set(speech.turns.map((t) => t.speaker))];
  const label = (id: string) =>
    speech.speakerNames[id] || `Sprecher ${speakers.indexOf(id) + 1}`;
  return (
    <div className="speaker-editor">
      <p className="muted">
        Namen ändern oder doppelt erkannte Sprecher zusammenführen. Die
        Zusammenfassung kann anschließend aus dem korrigierten Transkript neu
        erstellt werden.
      </p>
      {speakers.map((speaker) => (
        <div className="speaker-editor-row" key={speaker}>
          <label>
            Name für {label(speaker)}
            <input
              className="field"
              maxLength={80}
              value={speech.speakerNames[speaker] || ""}
              placeholder={label(speaker)}
              onChange={(event) =>
                onChange(renameSpeaker(speech, speaker, event.target.value))
              }
            />
          </label>
          <label>
            Gleiche Person wie
            <select
              className="field"
              value=""
              onChange={(event) =>
                event.target.value &&
                onChange(mergeSpeaker(speech, speaker, event.target.value))
              }
            >
              <option value="">Getrennt lassen</option>
              {speakers
                .filter((id) => id !== speaker)
                .map((id) => (
                  <option key={id} value={id}>
                    {label(id)}
                  </option>
                ))}
            </select>
          </label>
        </div>
      ))}
      <details>
        <summary>Text und Sprecher einzelner Beiträge korrigieren</summary>
        {speech.turns.map((turn, index) => (
          <div className="speaker-turn-edit" key={turn.id}>
            <label>
              Beitrag {index + 1} · {Math.floor(turn.startMs / 60000)}:
              {String(Math.floor(turn.startMs / 1000) % 60).padStart(2, "0")}
              <select
                className="field"
                value={turn.speaker}
                onChange={(event) =>
                  onChange({
                    ...speech,
                    turns: speech.turns.map((t) =>
                      t.id === turn.id
                        ? { ...t, speaker: event.target.value }
                        : t,
                    ),
                  })
                }
              >
                {speakers.map((id) => (
                  <option key={id} value={id}>
                    {label(id)}
                  </option>
                ))}
              </select>
              <textarea
                className="field"
                value={turn.text}
                onChange={(event) =>
                  onChange({
                    ...speech,
                    turns: speech.turns.map((t) =>
                      t.id === turn.id ? { ...t, text: event.target.value } : t,
                    ),
                  })
                }
              />
            </label>
          </div>
        ))}
      </details>
    </div>
  );
}
