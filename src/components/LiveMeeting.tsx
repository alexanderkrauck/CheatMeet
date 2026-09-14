import type { MeetingTranscript } from "../../shared/transcription";
import { useEffect, useRef, useState } from "react";
import {
  CornerDownLeft,
  HelpCircle,
  Lightbulb,
  ListChecks,
  Loader2,
  ScrollText,
  Sparkles,
  Gavel,
} from "lucide-react";
import type { MeetingInsights } from "../../shared/analysis";
import TranscriptChat from "./TranscriptChat";
import { askMeeting, emptyInsights, hasInsights, meetingInsights } from "../lib/assist";
import { setCaptureHint, setCaptureSpeakerName } from "../lib/capture";
import LiveSpeakers, { type SpeakerFilter } from "./LiveSpeakers";
import { startInsightRefresh } from "../lib/insightRefresh";
import { renderTranscript } from "../../shared/transcription";

interface Exchange {
  question: string;
  answer: string;
  failed?: boolean;
}

function InsightGroup({
  icon,
  title,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  items: string[];
}) {
  if (!items.length) return null;
  return (
    <section className="insight-group">
      <h3>
        {icon}
        {title}
      </h3>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The live meeting surface: the transcript is the main content, with a rolling
 * read of what is being asked of you and a box to ask anything about what has
 * already been said.
 */
export default function LiveMeeting({
  transcript,
  speech,
  pending,
  paused,
  timer,
  startedAt,
}: {
  transcript: string;
  speech?: MeetingTranscript;
  pending: number;
  paused: boolean;
  timer: string;
  startedAt?: string;
}) {
  const [tab, setTab] = useState<"transcript" | "assist">("transcript");
  const [insights, setInsights] = useState<MeetingInsights>(emptyInsights);
  const [thinking, setThinking] = useState(false);
  const [thread, setThread] = useState<Exchange[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const [insightError, setInsightError] = useState(false);
  const [speakerFilter, setSpeakerFilter] = useState<SpeakerFilter>("all");

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const editingName = useRef(false);
  const latest = useRef(transcript);
  latest.current = speech ? renderTranscript(speech) : transcript;

  // Follow the conversation, unless the user has scrolled back to re-read.
  useEffect(() => {
    const node = scroller.current;
    if (node && pinned.current && !editingName.current) node.scrollTop = node.scrollHeight;
  }, [transcript]);

  useEffect(() => {
    return startInsightRefresh({
      read: () => latest.current,
      request: meetingInsights,
      thinking: setThinking,
      received: (next) => {
        setInsights(next);
        setInsightError(false);
        setCaptureHint(next.prompts?.[0] || next.questions[0] || "");
      },
      failed: () => setInsightError(true),
    });
  }, [startedAt]);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    if (!asked || asking) return;
    setQuestion("");
    setError("");
    setAsking(true);
    setThread((previous) => [...previous, { question: asked, answer: "" }]);
    try {
      const answer = await askMeeting(asked, latest.current);
      setThread((previous) =>
        previous.map((item, index) =>
          index === previous.length - 1
            ? { ...item, answer: answer || "Dazu steht nichts im Transkript." }
            : item,
        ),
      );
    } catch (e) {
      setThread((previous) =>
        previous.map((item, index) =>
          index === previous.length - 1
            ? {
                ...item,
                answer: (e as Error).message,
                failed: true,
              }
            : item,
        ),
      );
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  }

  const empty = !transcript.trim();

  return (
    <div className="live">
      <div className="live-bar">
        <span className={`live-dot ${paused ? "is-paused" : ""}`} />
        <strong>{paused ? "Pausiert" : "Live"}</strong>
        <span className="live-time">{timer}</span>
        <span className="live-sync">
          {paused
            ? "Transkription pausiert"
            : pending > 0
              ? "Live-Verbindung wird aufgebaut …"
              : speech?.liveStartDelayed ? "Live-Start leicht verzögert" : "Vorläufiges Live-Transkript"}
        </span>
      </div>

      <div className="live-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "transcript"}
          className={tab === "transcript" ? "active" : ""}
          onClick={() => setTab("transcript")}
        >
          <ScrollText size={16} />
          Transkript
        </button>
        <button
          role="tab"
          aria-selected={tab === "assist"}
          className={tab === "assist" ? "active" : ""}
          onClick={() => setTab("assist")}
        >
          <Sparkles size={16} />
          Assistent
          {hasInsights(insights) && <i className="live-badge" />}
        </button>
      </div>

      {(insights.prompts?.[0] || insights.questions[0]) && (
        <button className="live-suggestion" onClick={() => setTab("assist")}>
          <Sparkles size={16} />
          <span><strong>Frage oder Hinweis zum Gespräch</strong>{insights.prompts?.[0] || insights.questions[0]}</span>
        </button>
      )}
      {insightError && <p className="live-error" role="status">Hinweise konnten nicht geladen werden. Der Assistent versucht es erneut.</p>}

      <div className="live-panes" data-tab={tab}>
        <div className="live-pane live-transcript">
          {speech && <LiveSpeakers speech={speech} filter={speakerFilter} onFilter={setSpeakerFilter} />}
          <div className="live-transcript-scroll" ref={scroller}
            onScroll={(e) => {
              const node = e.currentTarget;
              pinned.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            }}
          >
            <TranscriptChat
              transcript={transcript}
              speech={speech}
              filter={speakerFilter}
              onRename={setCaptureSpeakerName}
              onEditing={editing => { editingName.current = editing; }}
              startedAt={startedAt}
              empty="Sobald gesprochen wird, erscheint hier das laufende Transkript. Das Live-Transkript ist vorläufig; beim Abschluss wird es durch den finalen Text ersetzt."
            />
          </div>
        </div>

        <div className="live-pane live-assist">
          <div className="live-insights">
            {thinking && (
              <span className="live-thinking">
                <Loader2 className="spin" size={13} /> Assistent liest mit …
              </span>
            )}
            {hasInsights(insights) ? (
              <>
                <InsightGroup
                  icon={<Sparkles size={15} />}
                  title="Vorschläge"
                  items={insights.prompts || []}
                />
                <InsightGroup
                  icon={<HelpCircle size={15} />}
                  title="An dich gerichtet"
                  items={insights.questions}
                />
                <InsightGroup
                  icon={<ListChecks size={15} />}
                  title="Du hast zugesagt"
                  items={insights.actions}
                />
                <InsightGroup
                  icon={<Gavel size={15} />}
                  title="Entschieden"
                  items={insights.decisions}
                />
                {insights.terms.length > 0 && (
                  <section className="insight-group">
                    <h3>
                      <Lightbulb size={15} />
                      Begriffe
                    </h3>
                    <dl>
                      {insights.terms.map((term) => (
                        <div key={term.term}>
                          <dt>{term.term}</dt>
                          <dd>{term.explanation}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}
              </>
            ) : (
              !thinking && (
                <p className="live-empty">
                  Der Assistent meldet sich, sobald es offene Fragen, Zusagen
                  oder Entscheidungen gibt.
                </p>
              )
            )}

            {thread.map((item, index) => (
              <section className="live-exchange" key={index}>
                <p className="live-question">{item.question}</p>
                {item.answer ? (
                  <p className={item.failed ? "live-answer is-error" : "live-answer"}>
                    {item.answer}
                  </p>
                ) : (
                  <p className="live-answer">
                    <Loader2 className="spin" size={13} /> Suche im Transkript …
                  </p>
                )}
              </section>
            ))}
          </div>

          <form className="live-ask" onSubmit={ask}>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Frag das Meeting … z. B. „Was wurde zum Budget gesagt?“"
              aria-label="Frage zum bisherigen Meeting"
              disabled={empty}
            />
            <button type="submit" disabled={empty || asking || !question.trim()}>
              {asking ? (
                <Loader2 className="spin" size={17} />
              ) : (
                <CornerDownLeft size={17} />
              )}
            </button>
          </form>
          {error && <p className="live-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
