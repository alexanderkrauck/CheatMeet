import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { startInstallWatch } from "./lib/install";
import "./index.css";

// Registered before React mounts: `beforeinstallprompt` fires early and once.
startInstallWatch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
