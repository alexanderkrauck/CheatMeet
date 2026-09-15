import { Loader2, Mic, MonitorSpeaker, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ConsentDecision, ConsentSource } from "../../shared/consent";

/**
 * The screen between opening the devices and starting to record.
 *
 * The notice is not editable free text on purpose: hand-editing would let the
 * retention promise or the processors be deleted out of it, which is exactly
 * the coverage the assembled text guarantees. The wording changes through the
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

  return (
    <div className="consent">
      <div className="consent-sources">
        <small>Bereit — es wird noch nichts aufgenommen.</small>
        <span>
          <Mic size={16} /> Mikrofon
        </span>
        {sources.includes("system") && (
          <span>
            <MonitorSpeaker size={16} /> Systemton
          </span>
        )}
      </div>

      <div className="consent-toggles">
        <div className="consent-choice">
          {(["de", "en"] as const).map((value) => (
            <button
              key={value}
              className={decision.language === value ? "is-selected" : ""}
              onClick={() => onDecision({ language: value })}
            >
              {value === "de" ? "Deutsch" : "English"}
            </button>
          ))}
        </div>
        {decision.language === "de" && (
          <div className="consent-choice">
            {(["du", "sie"] as const).map((value) => (
              <button
                key={value}
                className={decision.address === value ? "is-selected" : ""}
                onClick={() => onDecision({ address: value })}
              >
                {value === "du" ? "Du" : "Sie"}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="consent-text">{text}</p>

      <div className="consent-draft">
        {chat.map((line, index) => (
          <p className="consent-chat" key={index}>
            {line}
          </p>
        ))}
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
            {drafting ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            Formulieren
          </button>
        </div>
        {hasDraft && !drafting && (
          <button className="consent-reset" onClick={onResetDraft}>
            Standardtext verwenden
          </button>
        )}
        {draftError && <p className="consent-error">{draftError}</p>}
      </div>

      <div className="consent-meta">
        <label>
          <input
            type="checkbox"
            checked={decision.allInformed}
            onChange={(event) =>
              onDecision({ allInformed: event.target.checked })
            }
          />
          Alle Anwesenden wurden informiert und haben nicht widersprochen
        </label>
        <div className="consent-choice">
          {(
            [
              ["spoken", "Gesprochen"],
              ["chat", "Chat"],
              ["calendar", "Einladung"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={decision.method === value ? "is-selected" : ""}
              onClick={() => onDecision({ method: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="consent-note">
        CheatMeet erstellt eine Dokumentationshilfe, keine rechtliche
        Bewertung. Am Arbeitsplatz und in regulierten Bereichen kann mehr nötig
        sein als die Zustimmung der Anwesenden — etwa eine Betriebsvereinbarung.
      </p>
    </div>
  );
}
