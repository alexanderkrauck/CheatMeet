import { useState } from "react";
import { savedRetention, setSavedRetention } from "../lib/meetingDefaults";
import type { RetentionPolicy } from "../../shared/consent";

const CHOICES: { label: string; days: number | null }[] = [
  { label: "30 Tage", days: 30 },
  { label: "90 Tage", days: 90 },
  { label: "1 Jahr", days: 365 },
  { label: "unbegrenzt", days: null },
];

/**
 * How long a NEW meeting promises to keep its files.
 *
 * Each meeting enforces the number stated in its own consent notice, so
 * changing this can never break a promise already made — it only decides what
 * the next notice says.
 */
export function RetentionSettings() {
  const [policy, setPolicy] = useState<RetentionPolicy>(savedRetention);

  const choose = (patch: Partial<RetentionPolicy>) => {
    const next = { ...policy, ...patch };
    setPolicy(next);
    setSavedRetention(next);
  };

  const row = (
    field: keyof RetentionPolicy,
    label: string,
    hint: string,
  ) => (
    <label className="form-field">
      <span>{label}</span>
      <div className="consent-choice">
        {CHOICES.map((choice) => (
          <button
            key={choice.label}
            type="button"
            className={policy[field] === choice.days ? "is-selected" : ""}
            onClick={() => choose({ [field]: choice.days })}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <small className="muted">{hint}</small>
    </label>
  );

  return (
    <section className="panel" aria-labelledby="retention-title">
      <div>
        <span className="eyebrow">AUFBEWAHRUNG</span>
        <h2 id="retention-title">Wie lange Aufnahmen bleiben</h2>
      </div>
      <p className="muted">
        Diese Angaben stehen wörtlich im Einwilligungstext, den du vor der
        Aufnahme vorliest — und sie werden genau so eingehalten.
      </p>
      {row(
        "audioDays",
        "Audioaufnahme",
        "Die Audiodatei ist das heikelste Stück und selten lange nützlich.",
      )}
      <p className="muted">
        Transkript und Zusammenfassung werden nicht gelöscht. Sie sind das
        Archiv — auch für spätere Recherche durch dich oder deine
        KI-Werkzeuge — und der Einwilligungstext sagt genau das.
      </p>
      <p className="muted small">
        Gelöscht wird, während CheatMeet auf einem deiner Geräte geöffnet ist:
        es gibt keinen Server, der in deinem Drive aufräumt. Gelöschte Dateien
        landen im Papierkorb von Google Drive und sind dort noch eine Weile
        wiederherstellbar. Die Einstellung gilt nur für neue Meetings — jedes
        bereits aufgenommene Meeting hält den Zeitraum ein, der in seiner
        eigenen Einwilligung genannt wurde. Gespeichert wird sie auf diesem
        Gerät.
      </p>
    </section>
  );
}
