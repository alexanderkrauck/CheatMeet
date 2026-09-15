import { ShieldCheck } from "lucide-react";
import { LegalBasis } from "./LegalBasis";
import { audioExpiresAt } from "../lib/retention";
import type { ReportData } from "../types";

const METHODS: Record<string, string> = {
  spoken: "mündlich",
  chat: "im Chat",
  calendar: "in der Kalendereinladung",
  other: "anders",
};

const when = (iso?: string) => {
  const at = iso ? new Date(iso) : undefined;
  return at && Number.isFinite(at.getTime())
    ? at.toLocaleString("de-AT", { dateStyle: "long", timeStyle: "short" })
    : iso || "";
};

const day = (ms: number) =>
  new Date(ms).toLocaleDateString("de-AT", { dateStyle: "long" });

/**
 * What was said before this meeting was recorded, and what happens to the
 * audio next.
 *
 * Deliberately labelled as the user's own documentation: the app can record
 * what was to be said and when it was confirmed, never that it was said.
 */
export function ConsentRecordPanel({ report }: { report: ReportData }) {
  const consent = report.consent;
  const expires = audioExpiresAt(report);
  const promisedDays = consent?.facts.retention.audioDays ?? null;

  return (
    <section>
      <h2>
        <ShieldCheck size={15} /> Einwilligung und Aufbewahrung
      </h2>
      {consent ? (
        <>
          <p>
            {when(consent.obtainedAt)} ·{" "}
            {METHODS[consent.method] || consent.method}
          </p>
          <ul className="consent-people">
            {(consent.participants || []).map((person) => (
              <li key={person.name}>
                {person.name} —{" "}
                {person.stance === "agreed"
                  ? "hat zugestimmt"
                  : person.stance === "objected"
                    ? "hat widersprochen"
                    : "informiert, keine ausdrückliche Zustimmung"}
              </li>
            ))}
            {consent.version === 1 && (
              <li>
                {consent.allInformed
                  ? "Alle Anwesenden informiert, ohne Widerspruch (alte Fassung, ohne Einzelnachweis)"
                  : "Nicht bestätigt, dass alle informiert waren"}
              </li>
            )}
          </ul>
          {consent.objections && (
            <p className="consent-objection">
              Widerspruch festgehalten: {consent.objections}
            </p>
          )}
          <details>
            <summary>Wortlaut</summary>
            <p className="consent-quote">{consent.text}</p>
          </details>
          <p className="muted small">
            Eigene Dokumentation: festgehalten ist, was vorgelesen werden
            sollte und wann es bestätigt wurde — nicht, dass es gesagt wurde.
          </p>
          <LegalBasis />
        </>
      ) : (
        <p className="muted">
          Keine Einwilligung dokumentiert. Dieses Meeting wurde aufgenommen,
          bevor CheatMeet den Hinweis festgehalten hat.
        </p>
      )}

      {report.audioDeletedAt ? (
        <p>
          Die Originalaufnahme wurde am {when(report.audioDeletedAt)}
          {promisedDays !== null
            ? ` nach der zugesagten Aufbewahrungsfrist von ${promisedDays} ${promisedDays === 1 ? "Tag" : "Tagen"}`
            : ""}{" "}
          gelöscht. Transkript und Zusammenfassung bleiben erhalten.
        </p>
      ) : expires !== null && report.rawAudioUrl ? (
        <p className="muted">
          Die Originalaufnahme wird nach dem {day(expires)} gelöscht, sobald
          CheatMeet geöffnet ist.
        </p>
      ) : null}
      {report.audioDeleteError && (
        <p className="consent-objection">
          Die zugesagte Löschung ist bisher fehlgeschlagen:{" "}
          {report.audioDeleteError}
        </p>
      )}
    </section>
  );
}
