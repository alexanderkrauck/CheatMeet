import { Loader2, Mic, MonitorSpeaker, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ConsentDecision, ConsentSource } from "../../shared/consent";

/**
 * The screen between opening the devices and starting to record.
 *
 * Two columns on purpose: the notice and the box that rewrites it sit
 * together, so it is obvious what the typing changes, and everything that is
 * merely a setting moves out of the reading path. Nothing scrolls — the step
 * has to be readable at a glance while someone is waiting on the call.
 *
 * The notice is not editable free text: hand-editing would let the retention
 * promise or the processors be deleted out of it, which is exactly the
 * coverage the assembled text guarantees. The wording changes through the
 * settings that feed it, or through a rephrasing that may only reword.
 */
export function ArmedMeeting({
  sources,
  text,
  decision,
  onDecision,
  onDraft,
  onResetDraft,
  drafting,
  draftError,
  chat,
  hasDraft,
}: {
  sources: ConsentSource[];
  text: string;
  decision: ConsentDecision;
  onDecision: (patch: Partial<ConsentDecision>) => void;
  onDraft: (instruction: string) => void;
  onResetDraft: () => void;
  drafting: boolean;
  draftError: string;
  chat: string[];
  hasDraft: boolean;
}) {
  const [instruction, setInstruction] = useState("");
  const submit = () => {
    const asked = instruction.trim();
    if (!asked || drafting) return;
    setInstruction("");
    onDraft(asked);
  };

  const choice = <K extends keyof ConsentDecision>(
    label: string,
    field: K,
    options: [ConsentDecision[K], string][],
  ) => (
    <div className="consent-field">
      <small>{label}</small>
      <div className="consent-choice" role="group" aria-label={label}>
        {options.map(([option, caption]) => (
          <button
            key={String(option)}
            className={decision[field] === option ? "is-selected" : ""}
            onClick={() => onDecision({ [field]: option } as Partial<ConsentDecision>)}
          >
            {caption}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="consent">
      <div className="consent-main">
        <div className="consent-head">
          <strong>Das liest du vor</strong>
          {hasDraft && (
            <button
              className="consent-reset"
              onClick={onResetDraft}
              disabled={drafting}
            >
              <RotateCcw size={14} /> angepasst · Standardtext
            </button>
          )}
        </div>
        <p className="consent-text">{text}</p>

        <div className="consent-ask">
          <input
            value={instruction}
            placeholder="Wer ist dabei, worum geht es? Dann formuliere ich es passend."
            maxLength={500}
            disabled={drafting}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />
          <button
            className="walk-secondary"
            disabled={drafting || !instruction.trim()}
            onClick={submit}
          >
            {drafting ? (
              <Loader2 className="spin" size={17} />
            ) : (
              <Sparkles size={17} />
            )}
            Formulieren
          </button>
        </div>
        {draftError && <p className="consent-error">{draftError}</p>}
        {!!chat.length && (
          <p className="consent-chat">Angepasst für: {chat.join(" · ")}</p>
        )}
      </div>

      <aside className="consent-side">
        <div className="consent-sources">
          <span>
            <Mic size={15} /> Mikrofon
          </span>
          {sources.includes("system") && (
            <span>
              <MonitorSpeaker size={15} /> Systemton
            </span>
          )}
          <small>Bereit — noch wird nichts aufgenommen.</small>
        </div>

        {choice("Sprache", "language", [
          ["de", "Deutsch"],
          ["en", "English"],
        ])}
        {decision.language === "de" &&
          choice("Anrede", "address", [
            ["du", "Du"],
            ["sie", "Sie"],
          ])}
        {choice("So informiert", "method", [
          ["spoken", "Gesprochen"],
          ["chat", "Chat"],
          ["calendar", "Einladung"],
        ])}

        <label className="consent-confirm">
          <input
            type="checkbox"
            checked={decision.allInformed}
            onChange={(event) =>
              onDecision({ allInformed: event.target.checked })
            }
          />
          <span>
            Alle Anwesenden wurden informiert und haben nicht widersprochen
          </span>
        </label>

        <p className="consent-note">
          CheatMeet erstellt eine Dokumentationshilfe, keine rechtliche
          Bewertung. Am Arbeitsplatz und in regulierten Bereichen kann mehr
          nötig sein als die Zustimmung der Anwesenden — etwa eine
          Betriebsvereinbarung.
        </p>
      </aside>
    </div>
  );
}
