import { useEffect, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../lib/firebase";
import { uid } from "../lib/reports";
import { errorMessage } from "../lib/session";

/**
 * The instruction that rides along with every analysis. It is the one setting
 * with no local cache, so the field stays disabled until the stored value has
 * actually arrived: writing an empty textarea over a saved prompt because the
 * read had not finished yet is data loss, not a slow load.
 */
export default function Preferences() {
  const [prompt, setPrompt] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    getDoc(doc(db, "users", uid(), "settings", "preferences"))
      .then((snap) => {
        if (!active) return;
        setPrompt(snap.data()?.summaryPrompt || "");
        setMessage("");
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setMessage(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      await setDoc(
        doc(db, "users", uid(), "settings", "preferences"),
        { summaryPrompt: prompt },
        { merge: true },
      );
      setMessage("Gespeichert.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="preferences-title">
      <div>
        <span className="eyebrow">ZUSAMMENFASSUNG</span>
        <h2 id="preferences-title">Worauf die KI achten soll</h2>
      </div>
      <p className="muted">
        Gilt für jedes neue Meeting — zum Beispiel „Besonderer Fokus auf
        Budgets und Termine“ oder „Aufgaben immer mit verantwortlicher Person“.
      </p>
      <label className="form-field">
        <span>Eigene Anweisung</span>
        <textarea
          className="field"
          value={prompt}
          rows={4}
          disabled={!loaded}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={loaded ? "Keine besondere Anweisung." : "Wird geladen …"}
        />
      </label>
      <div className="split">
        {loaded ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Speichern …" : "Speichern"}
          </button>
        ) : (
          /* Without this the field stays disabled for the rest of the session
             after a single failed read. */
          <button
            type="button"
            className="btn"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Erneut laden
          </button>
        )}
        {message && (
          <span className="muted small" role="status">
            {message}
          </span>
        )}
      </div>
    </section>
  );
}
