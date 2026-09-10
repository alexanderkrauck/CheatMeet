import { useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Mount once, including on the login screen. Never forces reload during a recording. */
export default function InstallApp() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [update, setUpdate] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [ios] = useState(
    () =>
      /iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !window.matchMedia("(display-mode: standalone)").matches,
  );
  useEffect(() => {
    const install = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const installed = () => setPrompt(null);
    window.addEventListener("beforeinstallprompt", install);
    window.addEventListener("appinstalled", installed);
    let active = true;
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      void navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          if (!active) return;
          if (registration.waiting) setUpdate(registration.waiting);
          registration.addEventListener("updatefound", () => {
            const worker = registration.installing;
            worker?.addEventListener("statechange", () => {
              if (
                active &&
                worker.state === "installed" &&
                navigator.serviceWorker.controller
              )
                setUpdate(worker);
            });
          });
        })
        .catch((error) =>
          console.warn("Offline-App konnte nicht aktiviert werden.", error),
        );
    }
    return () => {
      active = false;
      window.removeEventListener("beforeinstallprompt", install);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  const install = async () => {
    if (!prompt) return;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch (error) {
      console.warn("Installation wurde nicht gestartet.", error);
    } finally {
      setPrompt(null);
    }
  };
  const refresh = () => {
    // User opts in; unsaved recorder state is never discarded by an auto-update.
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => window.location.reload(),
      { once: true },
    );
    update?.postMessage({ type: "SKIP_WAITING" });
  };
  if (dismissed || (!update && !prompt && !ios)) return null;
  return (
    <aside
      className="mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700"
      aria-label="App installieren oder aktualisieren"
    >
      <div>
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
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {update ? (
          <button
            type="button"
            onClick={refresh}
            className="flex items-center gap-2 rounded-lg bg-stone-900 px-3 py-2 text-white"
          >
            <RefreshCw size={16} />
            Aktualisieren
          </button>
        ) : prompt ? (
          <button
            type="button"
            onClick={() => void install()}
            className="flex items-center gap-2 rounded-lg bg-stone-900 px-3 py-2 text-white"
          >
            <Download size={16} />
            Installieren
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Hinweis schließen"
          className="rounded-lg p-2"
        >
          <X size={18} />
        </button>
      </div>
    </aside>
  );
}
