import { CAPTURE_SOURCE_LABELS, speakerLabel, turnSource, type MeetingTranscript } from "../../shared/transcription";

export type SpeakerFilter = "all" | "mic" | "system" | `speaker:${string}`;
export default function LiveSpeakers({ speech, filter, onFilter }: {
  speech: MeetingTranscript;
  filter: SpeakerFilter;
  onFilter: (value: SpeakerFilter) => void;
}) {
  const speakers = [...new Map(speech.turns.map(t => [t.speaker, t])).values()];
  return <div className="live-speakers">
    <div className="speaker-filters" role="group" aria-label="Transkript filtern">
      {([['all', 'Alle'], ['mic', 'Mikrofon'], ['system', 'Systemaudio']] as const).map(([id, label]) =>
        <button key={id} aria-pressed={filter === id} onClick={() => onFilter(id)}>{label}</button>)}
    </div>
    <label className="speaker-picker">
      <span className="sr-only">Einzelne Stimme filtern</span>
      <select aria-label="Einzelne Stimme filtern" value={filter.startsWith('speaker:') ? filter : ''}
        onChange={event => onFilter(event.target.value ? event.target.value as SpeakerFilter : 'all')}>
        <option value="">Alle Stimmen</option>
        {speakers.filter(t => !t.speaker.endsWith(':unknown')).map(t => {
          const source = turnSource(t);
          return <option key={t.speaker} value={`speaker:${t.speaker}`}>
            {source && `${CAPTURE_SOURCE_LABELS[source]} · `}{speakerLabel(speech, t)}
          </option>;
        })}
      </select>
    </label>
  </div>;
}
