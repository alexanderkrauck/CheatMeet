import { useMemo, useState } from "react";
import { Check, Copy, Search, X } from "lucide-react";
import {
  SOURCE_LABELS,
  parseTimestamp,
  parseTranscript,
} from "../lib/transcriptAssembler";

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

/**
 * The finished transcript, as a scannable timeline rather than a chat.
 *
 * Reading a transcript afterwards is a different task from following one live:
 * the reader scans for a moment, so time runs down a fixed gutter and the text
 * gets the full column width. The chat view stays on the recording screen,
 * where following along is what matters.
 */
export default function TranscriptTimeline({
  transcript,
  startedAt,
  empty = "Kein Transkript vorhanden.",
}: {
  transcript: string;
  startedAt?: string;
  empty?: string;
}) {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<boolean | "failed">(false);
  const rows = useMemo(() => parseTranscript(transcript), [transcript]);
  const began = startedAt ? Date.parse(startedAt) : NaN;

  const clock = (at: string) => {
    const offset = parseTimestamp(at);
    if (!Number.isFinite(began) || offset === null) return "";
    return new Date(began + offset).toLocaleTimeString("de-AT", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter((row) => row.text.toLowerCase().includes(needle))
    : rows;
  const labelled = rows.some((row) => row.source === "system");

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
    <>
      <div className="timeline-tools no-print">
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
          {needle
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

      {visible.length === 0 ? (
        <p className="timeline-empty">
          Keine Stelle im Transkript enthält „{query.trim()}“.
        </p>
      ) : (
        <ol className="timeline">
          {visible.map((row, index) => {
            const previous = visible[index - 1];
            const sameSpeaker = previous && previous.source === row.source;
            return (
              <li
                key={index}
                className={`timeline-row is-${row.source || "single"}${sameSpeaker ? " is-continued" : ""}`}
              >
                <div className="timeline-time">
                  <time>{row.at}</time>
                  {clock(row.at) && <small>{clock(row.at)}</small>}
                </div>
                <div className="timeline-body">
                  {labelled && row.source && !sameSpeaker && (
                    <span className="timeline-speaker">
                      {SOURCE_LABELS[row.source]}
                    </span>
                  )}
                  <p>
                    {highlight(row.text, needle).map((part, i) =>
                      typeof part === "string" ? (
                        part
                      ) : (
                        <mark key={i}>{part.match}</mark>
                      ),
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
