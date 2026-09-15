import { useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { Download, RefreshCw, X } from "lucide-react";
import {
  applyUpdate,
  installState,
  runInstall,
  subscribeInstall,
} from "../lib/install";

/**
 * Mounted once, including on the login screen. Dismissing it only hides the
 * banner — both actions stay available under Einstellungen.
 */
export default function InstallApp() {
  const { prompt, update, ios } = useSyncExternalStore(
    subscribeInstall,
    installState,
    installState,
  );
  const [dismissed, setDismissed] = useState(false);
  const location = useLocation();

  // The capture screen owns its bottom edge, exactly as JobProgress respects.
  if (
    dismissed ||
    location.pathname.startsWith("/record") ||
    (!update && !prompt && !ios)
  )
    return null;
  return (
    <aside className="install-banner no-print" aria-label="App installieren oder aktualisieren">
      <p>
        {update ? (
          <>
            <strong>Neue Version verfügbar.</strong> Aufnahme zuerst sichern,
            dann aktualisieren.
          </>
        ) : (
          <>
            <strong>CheatMeet als App.</strong>{" "}
            {ios
              ? "In Safari: Teilen → Zum Home-Bildschirm."
              : "Für schnellen Zugriff und den Offline-Start installieren."}
          </>
        )}
      </p>
      <div className="actions">
        {update ? (
          <button type="button" className="btn btn-primary" onClick={applyUpdate}>
            <RefreshCw size={16} /> Aktualisieren
          </button>
        ) : prompt ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runInstall()}
          >
            <Download size={16} /> Installieren
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setDismissed(true)}
          aria-label="Hinweis schließen"
        >
          <X size={18} />
        </button>
      </div>
    </aside>
  );
}
