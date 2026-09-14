import { type MeetingTranscript } from "../../shared/transcription";
import { transcriptRows } from "../lib/transcriptRows";
import { useMemo, useState } from "react";
import { Check, Copy, Search, X } from "lucide-react";
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

/** Final view shares source placement, names and filters with the live view. */
export default function TranscriptTimeline({
  transcript,
  speech,
  startedAt,
  onRename,
  empty = "Kein Transkript vorhanden.",
}: {
  transcript: string;
  speech?: MeetingTranscript;
  startedAt?: string;
  onRename?: (id: string, name: string) => void;
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
    <div className="final-transcript-panel">
      <div className="final-transcript-tools no-print">
        {speech && (
          <LiveSpeakers speech={speech} filter={filter} onFilter={setFilter} />
        )}
        <div className="timeline-tools">
          <label className="timeline-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Im Transkript suchen …"
              aria-label="Im Transkript suchen"
            />
            {query && (
              <button onClick={() => setQuery("")} aria-label="Suche löschen">
                <X size={14} />
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
            onClick={copyAll}
          >
            {copied === true ? <Check size={15} /> : <Copy size={15} />}
            {copied === true
              ? "Kopiert"
              : copied === "failed"
                ? "Kopieren nicht erlaubt"
                : "Kopieren"}
          </button>
        </div>
      </div>
      <div className="final-transcript-scroll">
        <TranscriptChat
          transcript={transcript}
          speech={speech}
          startedAt={startedAt}
          filter={filter}
          query={query}
          onRename={onRename}
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
    </div>
  );
}
