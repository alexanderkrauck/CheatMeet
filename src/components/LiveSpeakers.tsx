import { CAPTURE_SOURCE_LABELS, speakerLabel, turnSource, type MeetingTranscript } from "../../shared/transcription";

export type SpeakerFilter = "all" | "mic" | "system" | `speaker:${string}`;
export default function LiveSpeakers({ speech, filter, onFilter, onRename }: {
  speech: MeetingTranscript;
  filter: SpeakerFilter;
  onFilter: (value: SpeakerFilter) => void;
  onRename: (id: string, name: string) => void;
}) {
  const speakers = [...new Map(speech.turns.map(t => [t.speaker, t])).values()];
  return <div className="live-speakers">
    <div className="speaker-filters" role="group" aria-label="Transkript filtern">
      {([['all', 'Alle'], ['mic', 'Mikrofon'], ['system', 'Systemaudio']] as const).map(([id, label]) =>
        <button key={id} aria-pressed={filter === id} onClick={() => onFilter(id)}>{label}</button>)}
      {speakers.filter(t => !t.speaker.endsWith(":unknown")).map(t => {
        const id = `speaker:${t.speaker}` as const;
        const source = turnSource(t);
        return <button key={id} aria-pressed={filter === id} onClick={() => onFilter(id)}>
          {source && `${CAPTURE_SOURCE_LABELS[source]} · `}{speakerLabel(speech, t)}
        </button>;
      })}
    </div>
    <details>
      <summary>Sprecher benennen</summary>
      <p>Die Audioquelle bleibt sichtbar. Noch nicht zugeordnete Stimmen behalten ihre Quelle.</p>
      {speakers.filter(t => !t.speaker.endsWith(":unknown")).map(t => {
        const source = turnSource(t);
        return <label key={t.speaker}>
          <span>{source ? CAPTURE_SOURCE_LABELS[source] : "Audio"} · {speech.speakerNames[t.speaker] || "Sprecher"}</span>
          <input aria-label={`Name für ${source ? CAPTURE_SOURCE_LABELS[source] : "Audio"} ${t.speaker}`}
            placeholder={speech.speakerNames[t.speaker] || "Name"}
            value={speech.speakerAliases?.[t.speaker] || ""} maxLength={80}
            onChange={event => onRename(t.speaker, event.target.value)} />
        </label>;
      })}
    </details>
  </div>;
}
