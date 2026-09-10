import { useState } from "react";
import {
  ArrowRight,
  Check,
  Mic,
  BrainCircuit,
  FileText,
  Loader2,
} from "lucide-react";
import { connectGoogle, errorMessage } from "../lib/session";
import { Brand, Notice } from "../components/UI";
export default function Login() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function login() {
    setLoading(true);
    setError("");
    try {
      await connectGoogle();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <div className="story-content">
          <span className="eyebrow">EFFIZIENTE MEETINGS. WENIGER NOTIZEN.</span>
          <h1>
            Gespräche erfassen.
            <br />
            Alles im <em>Fokus.</em>
          </h1>
          <p>
            Lass die KI mitschreiben. Zeichne deine Meetings auf und erhalte sofort strukturierte Zusammenfassungen und To-Dos.
          </p>
          <div className="story-flow">
            <span>
              <Mic /> Aufzeichnen
            </span>
            <i />
            <span>
              <BrainCircuit /> Transkribieren
            </span>
            <i />
            <span>
              <FileText /> Zusammenfassen
            </span>
          </div>
        </div>
        <span className="story-foot">
          VOM ERSTEN WORT BIS ZUM FERTIGEN PROTOKOLL.
        </span>
      </div>
      <div className="login-form">
        <div className="login-card">
          <span className="eyebrow">DEIN ARBEITSBEREICH</span>
          <h2>
            Gut dokumentiert.
            <br />
            Einfach weiterarbeiten.
          </h2>
          <p className="muted">
            Melde dich mit Google an und gib Drive für deine Meetings frei.
            Damit ist vor der ersten Aufnahme alles vorbereitet.
          </p>
          <button
            className="btn btn-primary login-button"
            onClick={login}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="spin" />
            ) : (
              <span className="google-g">G</span>
            )}
            {loading ? "Verbindung wird hergestellt …" : "Mit Google starten"}
            <ArrowRight size={18} />
          </button>
          {error && <Notice>{error}</Notice>}
          <div className="login-benefits">
            <p>
              <Check /> Audio und Transkripte an einem Ort
            </p>
            <p>
              <Check /> KI-Berichte zum Prüfen und Bearbeiten
            </p>
            <p>
              <Check /> Speicherort in Google Drive frei wählen
            </p>
          </div>
          <p className="small muted">
            Für die Analyse werden deine ausgewählten Aufnahmen an Google Gemini
            übermittelt. KI-Befunde bitte vor der Weitergabe prüfen.
          </p>
        </div>
        <span className="login-bottom">
          Für effiziente Teams gemacht.
        </span>
      </div>
    </div>
  );
}
