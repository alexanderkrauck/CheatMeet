import {
  Check,
  Loader2,
  Mic,
  MonitorSpeaker,
  Plus,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { LegalBasis } from "./LegalBasis";
import { PEOPLE_LIST_ID } from "./PeopleDatalist";
import { objectors, type ConsentDecision, type ConsentSource, type ConsentStance } from "../../shared/consent";

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
  const [person, setPerson] = useState("");
  const addPerson = () => {
    const name = person.trim();
    if (!name) return;
    if (decision.participants.some((p) => p.name === name)) return setPerson("");
    setPerson("");
    onDecision({
      participants: [...decision.participants, { name, stance: "silent" }],
    });
  };
  const setStance = (name: string, stance: ConsentStance) =>
    onDecision({
      participants: decision.participants.map((p) =>
        p.name === name ? { ...p, stance } : p,
      ),
    });
  const removePerson = (name: string) =>
    onDecision({
      participants: decision.participants.filter((p) => p.name !== name),
    });
  const refused = objectors(decision.participants);
  const allAgreed = (participants = decision.participants) =>
    onDecision({
      participants: participants.map((p) => ({ ...p, stance: "agreed" as const })),
    });
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

        <div className="consent-roster">
          <small>Wer ist dabei — und hat zugestimmt?</small>
          {!decision.participants.length && (
            <p className="consent-hint">
              Ordne das Meeting einem Kalendertermin zu, dann stehen die
              Eingeladenen hier automatisch.
            </p>
          )}
          {decision.participants.map((entry) => (
            <div className="consent-person" key={entry.name}>
              <strong>{entry.name}</strong>
              <div className="consent-choice">
                {(
                  [
                    ["agreed", "Ja"],
                    ["silent", "—"],
                    ["objected", "Nein"],
                  ] as [ConsentStance, string][]
                ).map(([stance, caption]) => (
                  <button
                    key={stance}
                    className={entry.stance === stance ? `is-${stance}` : ""}
                    onClick={() => setStance(entry.name, stance)}
                    aria-label={`${entry.name}: ${caption}`}
                  >
                    {caption}
                  </button>
                ))}
              </div>
              <button
                className="consent-remove"
                onClick={() => removePerson(entry.name)}
                aria-label={`${entry.name} entfernen`}
              >
                <X size={15} />
              </button>
            </div>
          ))}
          {decision.participants.length === 0 ? (
            // No calendar match, so no guest list to start from. One tap
            // beats typing, and it is still an affirmative statement rather
            // than the absence of an objection.
            <button
              className="consent-all"
              onClick={() =>
                allAgreed([{ name: "Alle Anwesenden", stance: "silent" }])
              }
            >
              <Check size={15} /> Alle Anwesenden haben zugestimmt
            </button>
          ) : (
            !decision.participants.every((p) => p.stance === "agreed") && (
              <button className="consent-all" onClick={() => allAgreed()}>
                <Check size={15} /> Alle haben zugestimmt
              </button>
            )
          )}
          <div className="consent-add">
            <input
              value={person}
              list={PEOPLE_LIST_ID}
              placeholder="Name hinzufügen"
              maxLength={80}
              onChange={(event) => setPerson(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && addPerson()}
            />
            <button onClick={addPerson} disabled={!person.trim()}>
              <Plus size={16} />
            </button>
          </div>
          {refused.length > 0 && (
            <p className="consent-error">
              {refused.map((p) => p.name).join(", ")} hat widersprochen. Ohne
              Zustimmung aller Anwesenden wird nicht aufgezeichnet.
            </p>
          )}
        </div>

        <p className="consent-note">
          Ein „—“ heißt: informiert, aber nicht ausdrücklich zugestimmt. Das
          reicht der DSGVO nicht als Einwilligung, deshalb zählt es hier auch
          nicht als eine. CheatMeet erstellt eine Dokumentationshilfe, keine
          rechtliche Bewertung — am Arbeitsplatz und in regulierten Bereichen
          kann mehr nötig sein, etwa eine Betriebsvereinbarung.
        </p>
        <LegalBasis />
      </aside>
    </div>
  );
}
