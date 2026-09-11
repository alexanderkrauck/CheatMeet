import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { auth } from "./lib/firebase";
import {
  rememberToken,
  startDriveTokenRefresh,
  stopDriveTokenRefresh,
} from "./lib/session";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
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
        // Signed in implies Drive-authorized: keep a usable token on hand
        // instead of prompting when an upload is already under way.
        if (u) startDriveTokenRefresh();
        else {
          stopDriveTokenRefresh();
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
      <InstallApp />
      <BrowserRouter>
        <JobProgress />
        <RecordingBar />
        <Routes key={user?.uid || "signed-out"}>
          <Route
            path="/"
            element={
              user ? <Navigate to="/dashboard" replace /> : <Login notice={revoked} />
            }
          />
          <Route
            path="/dashboard"
            element={user ? <Dashboard /> : <Navigate to="/" replace />}
          />
          <Route
            path="/record"
            element={user ? <RecordPage /> : <Navigate to="/" replace />}
          />
          <Route
            path="/report/:id"
            element={user ? <ReportPage /> : <Navigate to="/" replace />}
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
