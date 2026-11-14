import { type MeetingTranscript } from "../../shared/transcription";
import { transcriptRows } from "../lib/transcriptRows";
import { useMemo, useState } from "react";
import { Check, Copy, Play, Search, X } from "lucide-react";
import TranscriptChat from "./TranscriptChat";
import LiveSpeakers, { type SpeakerFilter } from "./LiveSpeakers";

/** Splits a line so matches can be marked without dangerously setting HTML. */
function highlight(text: string, query: string) {
  if (!query) return [text];
  const parts: (string | { match: string })[] = [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let at = 0;
  for (;;) {
    const found = haystack.indexOf(needle, at);
    if (found < 0) break;
    if (found > at) parts.push(text.slice(at, found));
    parts.push({ match: text.slice(found, found + needle.length) });
    at = found + needle.length;
  }
  parts.push(text.slice(at));
  return parts;
}

/** Finished transcript is a reading workspace; capture provenance stays intact. */
export default function TranscriptTimeline({
  transcript,
  speech,
  startedAt,
  onRename,
  onEditing,
  editingDisabled,
  onListen,
  onEditTurn,
  positionMs,
  playing = false,
  empty = "Kein Transkript vorhanden.",
}: {
  transcript: string;
  speech?: MeetingTranscript;
  startedAt?: string;
  onRename?: (id: string, name: string) => void;
  onEditing?: (editing: boolean) => void;
  editingDisabled?: boolean;
  onListen?: (atMs: number) => void;
  onEditTurn?: (turnId: string) => void;
  positionMs?: number;
  playing?: boolean;
  empty?: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SpeakerFilter>("all");
  const [copied, setCopied] = useState<boolean | "failed">(false);
  const rows = useMemo(
    () => transcriptRows(transcript, speech),
    [transcript, speech],
  );
  const needle = query.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      (!needle || row.text.toLowerCase().includes(needle)) &&
      (filter === "all" ||
        row.source === filter ||
        `speaker:${row.speakerId}` === filter),
  );

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Denied permission or an insecure context: say so rather than nothing.
      setCopied("failed");
      setTimeout(() => setCopied(false), 2600);
    }
  }

  if (!rows.length) return <p className="timeline-empty">{empty}</p>;
  return (
    <div className="final-transcript-panel transcript-workspace">
      <div className="final-transcript-tools no-print">
        {speech && (
          <LiveSpeakers speech={speech} filter={filter} onFilter={setFilter} />
        )}
        <div className="timeline-tools">
          <label className="timeline-search">
            <Search size={15} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Im Transkript suchen …"
              aria-label="Im Transkript suchen"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Suche löschen"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </label>
          <span className="timeline-count">
            {needle || filter !== "all"
              ? `${visible.length} von ${rows.length} Beiträgen`
              : `${rows.length} ${rows.length === 1 ? "Beitrag" : "Beiträge"}`}
          </span>
          <button
            className={`timeline-copy${copied === "failed" ? " is-failed" : ""}`}
            type="button"
            onClick={copyAll}
          >
            {copied === true ? (
              <Check size={15} aria-hidden="true" />
            ) : (
              <Copy size={15} aria-hidden="true" />
            )}
            {copied === true
              ? "Kopiert"
              : copied === "failed"
                ? "Kopieren nicht erlaubt"
                : "Gesamtes Transkript kopieren"}
          </button>
        </div>
      </div>
      {onListen && (
        <p className="transcript-listen-hint no-print">
          <Play size={12} aria-hidden="true" /> Jede Zeitmarke spielt die
          Aufnahme ab dieser Passage.
        </p>
      )}
      <p className="muted small transcript-export-note no-print">
        Kopieren und PDF enthalten das gesamte verfügbare Transkript. Suche und
        Sprecherfilter ändern nur die Bildschirmansicht.
      </p>
      <div className="final-transcript-scroll no-print">
        <TranscriptChat
          transcript={transcript}
          speech={speech}
          startedAt={startedAt}
          filter={filter}
          variant="document"
          positionMs={positionMs}
          playing={playing}
          query={query}
          onRename={onRename}
          onEditing={onEditing}
          editingDisabled={editingDisabled}
          onListen={onListen}
          onEditTurn={onEditTurn}
          empty="Keine Beiträge für diese Auswahl."
          renderText={(text) =>
            highlight(text, needle).map((part, i) =>
              typeof part === "string" ? (
                part
              ) : (
                <mark key={i}>{part.match}</mark>
              ),
            )
          }
        />
      </div>
      <div className="report-transcript-print">
        <p>Vollständiges verfügbares Transkript · {rows.length} Beiträge</p>
        <TranscriptChat
          transcript={transcript}
          speech={speech}
          startedAt={startedAt}
          variant="document"
        />
      </div>
    </div>
  );
}
