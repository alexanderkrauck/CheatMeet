import { useEffect, useState } from "react";
import { captureSnapshot, disarmCapture } from "./lib/capture";
import {
  startRetentionSweep,
  stopRetentionSweep,
} from "./lib/retentionSweep";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { auth } from "./lib/firebase";
import {
  rememberToken,
  startDriveTokenRefresh,
  stopDriveTokenRefresh,
} from "./lib/session";
import Login from "./pages/Login";
import AppLayout from "./components/AppLayout";
import Dashboard from "./pages/Dashboard";
import CalendarPage from "./pages/CalendarPage";
import SettingsPage from "./pages/SettingsPage";
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
  // Losing the Drive grant means losing the app: sign out rather than leave the
  // user in a half-working state.
  useEffect(() => {
    const onRevoked = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setRevoked(detail?.message || "");
      void signOut(auth).catch(() => {});
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
          startDriveTokenRefresh();
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
        <InstallApp />
        <JobProgress />
        <RecordingBar />
        <Routes key={user?.uid || "signed-out"}>
          <Route
            path="/"
            element={
              user ? <Navigate to="/dashboard" replace /> : <Login notice={revoked} />
            }
          />
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
