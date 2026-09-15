import { useState } from "react";
import { PEOPLE_LIST_ID } from "./PeopleDatalist";
import {
  mergeSpeaker,
  renameSpeaker,
  turnSource,
  type MeetingTranscript,
} from "../../shared/transcription";

export default function SpeakerEditor({
  speech,
  onChange,
  onListen,
}: {
  speech: MeetingTranscript;
  onChange: (speech: MeetingTranscript) => void;
  onListen?: (atMs: number) => void;
}) {
  const [cuts, setCuts] = useState<Record<string, number>>({});
  const speakers = [...new Set(speech.turns.map((t) => t.speaker))];
  const label = (id: string) =>
    speech.speakerNames[id] || `Sprecher ${speakers.indexOf(id) + 1}`;
  return (
    <div className="speaker-editor">
      <p className="muted">
        Die Sprechererkennung kann zwei Personen unter einem Label zusammenfassen
        oder eine Person auf mehrere Labels verteilen. Prüfe die Beiträge: Namen
        vergeben, gleiche Personen zusammenführen oder einzelne Beiträge einer
        neuen Person zuordnen. Auch innerhalb eines Beitrags kann ein Wechsel fehlen.
      </p>
      {speakers.map((speaker) => (
        <div className="speaker-editor-row" key={speaker}>
          <label>
            Name für {label(speaker)}
            <input
              className="field"
              list={PEOPLE_LIST_ID}
              maxLength={80}
              value={speech.speakerNames[speaker] || ""}
              placeholder={label(speaker)}
              onChange={(event) =>
                onChange(renameSpeaker(speech, speaker, event.target.value))
              }
            />
          </label>
          <p className="speaker-example">{speech.turns.find(t => t.speaker === speaker)?.text.slice(0, 180)}</p>
          {onListen && <button className="btn" onClick={() => onListen(speech.turns.find(t => t.speaker === speaker)!.startMs)}>Stimme anhören</button>}
          {speech.speakerNameSuggestions?.[speaker] && !speech.speakerAliases?.[speaker] && (
            <button className="btn btn-ghost" onClick={() => onChange(renameSpeaker(speech, speaker, speech.speakerNameSuggestions![speaker]))}>
              Vorschlag aus passenden Live-Beiträgen: {speech.speakerNameSuggestions[speaker]}
            </button>
          )}
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
            {onListen && <button className="btn" onClick={() => onListen(turn.startMs)}>Beitrag anhören</button>}
            <label>
              Beitrag {index + 1} · {Math.floor(turn.startMs / 60000)}:
              {String(Math.floor(turn.startMs / 1000) % 60).padStart(2, "0")}
              <select
                className="field"
                value={turn.speaker}
                onChange={(event) => {
                  const selected = event.target.value;
                  const speaker = selected === "new" ? `manual:${crypto.randomUUID()}` : selected;
                  onChange({
                    ...speech,
                    ...(selected === "new" ? { speakerNames: { ...speech.speakerNames, [speaker]: `Neue Person ${speakers.length + 1}` } } : {}),
                    turns: speech.turns.map((t) =>
                      t.id === turn.id
                        ? { ...t, speaker }
                        : t,
                    ),
                  });
                }}
              >
                {speakers.map((id) => (
                  <option key={id} value={id}>
                    {label(id)}
                  </option>
                ))}
                <option value="new">Neue Person für diesen Beitrag …</option>
              </select>
              <textarea
                className="field"
                value={turn.text}
                onSelect={event => { const at = event.currentTarget.selectionStart; setCuts(previous => ({ ...previous, [turn.id]: at })); }}
                onChange={(event) =>
                  onChange({
                    ...speech,
                    turns: speech.turns.map((t) =>
                      t.id === turn.id ? { ...t, text: event.target.value } : t,
                    ),
                  })
                }
              />
              <button className="btn" disabled={!cuts[turn.id] || cuts[turn.id] >= turn.text.length}
                onClick={() => {
                  const at = cuts[turn.id];
                  if (!at || !turn.text.slice(0, at).trim() || !turn.text.slice(at).trim()) return;
                  const speaker = `manual:${crypto.randomUUID()}`;
                  onChange({ ...speech,
                    speakerNames: { ...speech.speakerNames, [speaker]: `Neue Person ${speakers.length + 1}` },
                    turns: speech.turns.flatMap(t => t.id === turn.id ? [
                      { ...t, text: t.text.slice(0, at).trim() },
                      { ...t, id: `manual:${crypto.randomUUID()}`, speaker, text: t.text.slice(at).trim(), ...(turnSource(t) ? { source: turnSource(t)! } : {}) },
                    ] : [t]),
                  });
                }}>Ab Textcursor einer neuen Person zuordnen</button>
              <small>Zum Aufteilen den Cursor an den Sprecherwechsel setzen. Beide Teile behalten den ursprünglichen Zeitbereich.</small>
            </label>
          </div>
        ))}
      </details>
    </div>
  );
}
