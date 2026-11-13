import { useEffect, useState } from "react";
import { captureSnapshot, disarmCapture } from "./lib/capture";
import {
  startRetentionSweep,
  stopRetentionSweep,
} from "./lib/retentionSweep";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onAuthStateChanged, type User } from "firebase/auth";
import { observeServerProcessing } from "./lib/pipeline";
import { auth } from "./lib/firebase";
import {loadMicrosoftConnections} from "./lib/microsoft";
import {loadProviderSettings} from "./lib/providerSettings";
import {
  rememberToken,
  connectGoogle,
  startDriveTokenRefresh,
  stopDriveTokenRefresh,
} from "./lib/session";
import Login from "./pages/Login";
import AppLayout from "./components/AppLayout";
import Dashboard from "./pages/Dashboard";
import CalendarPage from "./pages/CalendarPage";
import SettingsPage from "./pages/SettingsPage";
import ConnectPage from "./pages/ConnectPage";
import RecordPage from "./pages/RecordPage";
import ReportPage from "./pages/ReportPage";
import InstallApp from "./components/InstallApp";
import JobProgress from "./components/JobProgress";
import RecordingBar from "./components/RecordingBar";
import { Loader2 } from "lucide-react";
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoked, setRevoked] = useState("");
  // Identity and Drive permission are independent. Keep the user signed in
  // so a blocked server job remains visible while Drive is reconnected.
  useEffect(() => {
    const onRevoked = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setRevoked(detail?.message || "");
      // Do not sign out: only the external Drive grant needs renewal.
    };
    window.addEventListener("cheatmeet:drive-revoked", onRevoked);
    return () => window.removeEventListener("cheatmeet:drive-revoked", onRevoked);
  }, []);
  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        // A revoked Drive grant signs the user out, and the refresher ticks
        // every few minutes — which can land while someone is reading the
        // consent notice aloud with the microphone already open.
        const armed = captureSnapshot();
        if (armed.state === "armed" && u?.uid !== armed.owner) disarmCapture();
        // Signed in implies Drive-authorized: keep a usable token on hand
        // instead of prompting when an upload is already under way.
        if (u) {
          if(u.providerData.some(p=>p.providerId==="google.com"))startDriveTokenRefresh();else stopDriveTokenRefresh();
          void loadMicrosoftConnections().catch(()=>{});
          void loadProviderSettings().catch(()=>{});
          // Deletion has no server to run on: it happens while the app is open.
          startRetentionSweep();
        } else {
          stopDriveTokenRefresh();
          stopRetentionSweep();
          rememberToken(undefined);
        }
        setLoading(false);
      }),
    [],
  );
  useEffect(() => user ? observeServerProcessing(user.uid) : undefined, [user?.uid]);
  if (loading)
    return (
      <div className="loading-screen">
        <Loader2 className="spin" />
        <p>Arbeitsbereich wird geladen …</p>
      </div>
    );
  return (
    <>
      <BrowserRouter>
        <InstallApp signedIn={Boolean(user)} />
        {user && revoked && (
          <div className="notice" role="status">
            {revoked} Deine Anmeldung bleibt erhalten.
            <button type="button" className="btn" onClick={() => void connectGoogle()
              .then(() => setRevoked(""))
              .catch((error) => setRevoked(error instanceof Error ? error.message : "Drive konnte nicht verbunden werden."))}>
              Google Drive erneut verbinden
            </button>
          </div>
        )}
        <JobProgress />
        <RecordingBar />
        <Routes key={user?.uid || "signed-out"}>
          <Route
            path="/"
            element={
              user ? <Navigate to="/dashboard" replace /> : <Login notice={revoked} />
            }
          />
          {/* Reachable signed out: signing in re-renders this page, keeping the signed request in the address. */}
          <Route path="/connect" element={<ConnectPage signedIn={Boolean(user)} />} />
          {/* One gate for every screen that wears the app frame. */}
          <Route
            element={user ? <AppLayout /> : <Navigate to="/" replace />}
          >
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/report/:id" element={<ReportPage />} />
          </Route>
          {/* Capture owns the whole viewport, so it stays outside the frame. */}
          <Route
            path="/record"
            element={user ? <RecordPage /> : <Navigate to="/" replace />}
          />
          <Route
            path="*"
            element={<Navigate to={user ? "/dashboard" : "/"} replace />}
          />
        </Routes>
      </BrowserRouter>
    </>
  );
}
