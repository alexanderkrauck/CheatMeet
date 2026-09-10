import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "./lib/firebase";
import { rememberToken } from "./lib/session";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import RecordPage from "./pages/RecordPage";
import ReportPage from "./pages/ReportPage";
import InstallApp from "./components/InstallApp";
import { Loader2 } from "lucide-react";
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        if (!u) rememberToken(undefined);
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
        <Routes key={user?.uid || "signed-out"}>
          <Route
            path="/"
            element={user ? <Navigate to="/dashboard" replace /> : <Login />}
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
