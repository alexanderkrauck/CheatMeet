import { useEffect, useRef, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebase";
import { uid } from "../lib/reports";
import { errorMessage } from "../lib/session";

/** Cloud-confirmed instructions and an owner-scoped, tab-local draft are distinct. */
export default function Preferences() {
  const owner = uid();
  const draftKey = `cheatmeet:prompt-draft:${owner}`;
  const [prompt, setPrompt] = useState("");
  const [saved, setSaved] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const current = useRef("");
  const [retained, setRetained] = useState(true);
  const dirty = loaded && prompt !== saved;

  function retain(value: string, base: string) {
    try {
      if (value === base) sessionStorage.removeItem(draftKey);
      else sessionStorage.setItem(draftKey, JSON.stringify({ value }));
      setRetained(true);
    } catch {
      setRetained(false);
    }
  }
  useEffect(() => {
    let active = true;
    getDoc(doc(db, "users", owner, "settings", "preferences"))
      .then((snap) => {
        if (!active || auth.currentUser?.uid !== owner) return;
        const stored =
          typeof snap.data()?.summaryPrompt === "string"
            ? snap.data()!.summaryPrompt
            : "";
        let value = stored;
        try {
          const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null");
          if (typeof draft?.value === "string") value = draft.value;
        } catch {
          /* A blocked cache never changes the stored instruction. */
        }
        current.current = value;
        setPrompt(value);
        setSaved(stored);
        setMessage("");
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setMessage(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [attempt, owner, draftKey]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  async function save() {
    const submitted = prompt;
    setSaving(true);
    setMessage("");
    try {
      await setDoc(
        doc(db, "users", owner, "settings", "preferences"),
        { summaryPrompt: submitted },
        { merge: true },
      );
      if (auth.currentUser?.uid !== owner) return;
      setSaved(submitted);
      retain(current.current, submitted);
      setMessage(
        current.current === submitted
          ? "Gespeichert."
          : "Vorherige Fassung gespeichert. Aktueller Entwurf noch nicht gespeichert.",
      );
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      id="zusammenfassung"
      className="panel"
      aria-labelledby="preferences-title"
    >
      <div>
        <span className="eyebrow">ZUSAMMENFASSUNG</span>
        <h2 id="preferences-title">Worauf die KI achten soll</h2>
      </div>
      <p className="muted">
        Gilt für künftige Analysen. Zum Beispiel: „Fokus auf Budgets und
        Termine“. Diese Anweisung wird erst mit „Speichern“ im Konto übernommen.
      </p>
      <label className="form-field" htmlFor="summary-prompt">
        <span>Eigene Anweisung (optional)</span>
      </label>
      <textarea
        id="summary-prompt"
        className="field"
        value={prompt}
        rows={4}
        disabled={!loaded}
        aria-describedby="prompt-state"
        onChange={(event) => {
          current.current = event.target.value;
          setPrompt(event.target.value);
          setMessage("");
          retain(event.target.value, saved);
        }}
        placeholder={loaded ? "Keine besondere Anweisung." : "Wird geladen …"}
      />
      <p id="prompt-state" className="muted small" role="status">
        {dirty
          ? retained
            ? "Noch nicht gespeichert. Der Entwurf bleibt beim Seitenwechsel in diesem Tab erhalten."
            : "Noch nicht gespeichert. Der Browser kann den Entwurf nicht sichern — bitte vor dem Verlassen speichern."
          : loaded
            ? "Keine ungespeicherten Änderungen."
            : "Gespeicherte Anweisung wird geladen."}
      </p>
      <div className="actions">
        {loaded ? (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={saving || !dirty}
            >
              {saving ? "Speichern …" : "Speichern"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={saving || !dirty}
              onClick={() => {
                current.current = saved;
                setPrompt(saved);
                setMessage("");
                retain(saved, saved);
              }}
            >
              Entwurf verwerfen
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Erneut laden
          </button>
        )}
      </div>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
