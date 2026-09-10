import { useEffect, useState } from "react";
import { getAuth } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

export default function Preferences() {
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    const auth = getAuth();
    const db = getFirestore();
    const uid = auth.currentUser?.uid;
    if (uid) {
      getDoc(doc(db, "users", uid, "settings", "preferences")).then(snap => {
        if (active && snap.exists()) {
          setPrompt(snap.data().summaryPrompt || "");
        }
      });
    }
    return () => { active = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const auth = getAuth();
      const db = getFirestore();
      const uid = auth.currentUser?.uid;
      if (uid) {
        await setDoc(doc(db, "users", uid, "settings", "preferences"), { summaryPrompt: prompt });
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="preferences-title">
      <div>
        <span className="eyebrow">KI-EINSTELLUNGEN</span>
        <h2 id="preferences-title">Zusammenfassungs-Präferenzen</h2>
      </div>
      <p className="muted">
        Geben Sie hier an, worauf die KI bei der Zusammenfassung des Meetings besonders achten soll (z. B. "Besonderer Fokus auf Marketing-Budgets").
      </p>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Präferenzen für die Zusammenfassung..."
        style={{ width: "100%", marginTop: 8, padding: 8, borderRadius: 8, border: "1px solid var(--line)", background: "transparent" }}
      />
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Speichern..." : "Speichern"}
        </button>
        {saved && <span style={{ marginLeft: 12, color: "var(--green)" }}>Gespeichert!</span>}
      </div>
    </section>
  );
}
