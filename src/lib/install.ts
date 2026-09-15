/**
 * PWA install and update state, held outside React so the banner and the
 * settings page see the same thing. `beforeinstallprompt` fires once, early —
 * whoever listens first owns it, which is why it cannot live in a component
 * that mounts and unmounts.
 */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallState {
  prompt: InstallPrompt | null;
  update: ServiceWorker | null;
  /** iOS has no install prompt; Safari's share sheet is the only route. */
  ios: boolean;
}

let state: InstallState = {
  prompt: null,
  update: null,
  ios:
    typeof navigator !== "undefined" &&
    /iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !window.matchMedia("(display-mode: standalone)").matches,
};
const listeners = new Set<() => void>();

function set(next: Partial<InstallState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export const subscribeInstall = (onChange: () => void) => {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
};
export const installState = () => state;
export const canInstall = () => !!state.prompt || state.ios;

let started = false;

export function startInstallWatch() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    set({ prompt: event as InstallPrompt });
  });
  window.addEventListener("appinstalled", () => set({ prompt: null, ios: false }));
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      if (registration.waiting) set({ update: registration.waiting });
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller)
            set({ update: worker });
        });
      });
    })
    .catch((error) =>
      console.warn("Offline-App konnte nicht aktiviert werden.", error),
    );
}

export async function runInstall() {
  const { prompt } = state;
  if (!prompt) return;
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch (error) {
    console.warn("Installation wurde nicht gestartet.", error);
  } finally {
    set({ prompt: null });
  }
}

export function applyUpdate() {
  // The user opts in; an auto-update must never discard an unsaved recording.
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => window.location.reload(),
    { once: true },
  );
  state.update?.postMessage({ type: "SKIP_WAITING" });
}
