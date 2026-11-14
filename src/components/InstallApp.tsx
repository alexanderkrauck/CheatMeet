import { useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { Download, RefreshCw, X } from "lucide-react";
import {
  applyUpdate,
  canApplyUpdate,
  installState,
  runInstall,
  subscribeInstall,
} from "../lib/install";
import { captureSnapshot, subscribeCapture } from "../lib/capture";
import { activeJobs, subscribeJobs } from "../lib/pipeline";

/**
 * Mounted once after sign-in. On small login/consent screens a fixed nudge
 * covered the Microsoft choice; both actions remain available in settings.
 */
export default function InstallApp({
  signedIn = false,
}: { signedIn?: boolean } = {}) {
  const { prompt, update, ios } = useSyncExternalStore(
    subscribeInstall,
    installState,
    installState,
  );
  const [dismissed, setDismissed] = useState(false);
  const location = useLocation();
  useSyncExternalStore(subscribeCapture, captureSnapshot, captureSnapshot);
  useSyncExternalStore(subscribeJobs, activeJobs, activeJobs);
  const updateBlocked = Boolean(update && !canApplyUpdate());

  // The capture screen owns its bottom edge, exactly as JobProgress respects.
  if (
    !signedIn ||
    dismissed ||
    location.pathname === "/setup" ||
    location.pathname === "/connect" ||
    location.pathname.startsWith("/record") ||
    (!update && !prompt && !ios)
  )
    return null;
  return (
    <aside
      className="install-banner no-print"
      aria-label="App installieren oder aktualisieren"
    >
      <p>
        {update ? (
          <>
            <strong>Neue Version verfügbar.</strong>{" "}
            {updateBlocked ? "Nach der laufenden Aufnahme oder dem Upload aktualisieren." : "Mit einem Neuladen bist du auf dem neuesten Stand."}
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
          <button
            type="button"
            className="btn btn-primary"
            onClick={applyUpdate}
            disabled={updateBlocked}
          >
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
