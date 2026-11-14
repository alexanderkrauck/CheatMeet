import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { handleCaptureOwnerChange } from "./lib/capture";
import {
  startRetentionSweep,
  stopRetentionSweep,
} from "./lib/retentionSweep";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation, Link } from "react-router-dom";
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
import UsagePage from "./pages/UsagePage";
import ConnectPage from "./pages/ConnectPage";
import RecordPage from "./pages/RecordPage";
import ReportPage from "./pages/ReportPage";

import JobProgress from "./components/JobProgress";
import RecordingBar from "./components/RecordingBar";
import { Loader2 } from "lucide-react";
import ConnectionSetup from './components/ConnectionSetup';
import {identitySetupPending,completeIdentitySetup,subscribeIdentitySetup,safeWorkspaceReturnTo} from './lib/identitySetup';
function SetupRoute({owner}:{owner:string}){
  const navigate=useNavigate();
  const location=useLocation();
  const requested=safeWorkspaceReturnTo(new URLSearchParams(location.search).get('returnTo'))||safeWorkspaceReturnTo(location.state?.returnTo)||'/dashboard';
  const destination=requested.split(/[?#]/)[0].replace(/\/$/,'')==='/setup'?'/dashboard':requested;
  return <ConnectionSetup onComplete={()=>{completeIdentitySetup(owner);navigate(destination,{replace:true});}}/>;
}

function SessionGate({signedIn,children}:{signedIn:boolean;children:ReactNode}){
  const location=useLocation();
  return signedIn?children:<Navigate to="/" replace state={{returnTo:safeWorkspaceReturnTo(location.pathname+location.search+location.hash)}}/>;
}

function EntryRoute({signedIn,setupPending,notice}:{signedIn:boolean;setupPending:boolean;notice:string}){
  const location=useLocation();
  const destination=safeWorkspaceReturnTo(location.state?.returnTo)||'/dashboard';
  return signedIn?<Navigate to={setupPending?'/setup':destination} replace state={{returnTo:destination}}/>:<Login notice={notice}/>;
}

function RouteTitle(){
  const {pathname}=useLocation();
  useEffect(()=>{
    const titles:Record<string,string>={'/':'Anmelden','/dashboard':'Übersicht','/calendar':'Kalender','/usage':'Nutzung','/settings':'Einstellungen','/setup':'Verbindungen einrichten','/record':'Meeting aufnehmen','/connect':'Assistent verbinden'};
    document.title=`${titles[pathname]||(/^\/report\/[^/]+\/?$/.test(pathname)?'Meeting-Bericht':'Seite nicht gefunden')} · CheatMeet`;
  },[pathname]);
  return null;
}

function NotFound({signedIn}:{signedIn:boolean}){
  const navigate=useNavigate();
  return <main className="page"><h1>Seite nicht gefunden</h1><p className="muted">Diese Adresse ist nicht verfügbar. Deine Meetings und Aufnahme-Entwürfe bleiben erhalten.</p><div className="actions"><button type="button" className="btn" onClick={()=>navigate(-1)}>Zurück</button><Link className="btn btn-primary" to={signedIn?'/dashboard':'/'}>{signedIn?'Zur Übersicht':'Zur Anmeldung'}</Link></div></main>;
}
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoked, setRevoked] = useState("");
  const [captureWarning, setCaptureWarning] = useState("");
  const setupPending=useSyncExternalStore(subscribeIdentitySetup,()=>Boolean(user&&identitySetupPending(user.uid)),()=>false);
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
  useEffect(() => {
    let active = true;
    let generation = 0;
    let owner: string | null | undefined;
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      const nextOwner = u?.uid || null;
      const changed = owner !== nextOwner;
      owner = nextOwner;
      const current = ++generation;
      // Invocation is synchronous: old devices and exposed state are fenced
      // before the new identity can mount its workspace.
      const transition = handleCaptureOwnerChange(nextOwner);
      if (changed) {
        stopDriveTokenRefresh();
        stopRetentionSweep();
        setRevoked("");
        setLoading(true);
      }
      const resume = (failed = false) => {
        if (!active || current !== generation || (auth.currentUser?.uid || null) !== nextOwner) return;
        setCaptureWarning(failed
          ? "Der vorige Aufnahme-Entwurf konnte noch nicht lokal gesichert werden. Er bleibt im Speicher dieses Tabs. Schließe den Tab nicht; wechsle zum bisherigen Konto zurück und sichere ihn."
          : "");
        setUser(u);
        if (u) {
          // A Drive data grant is independent of the Firebase login provider.
          startDriveTokenRefresh();
          void loadMicrosoftConnections().catch(() => {});
          void loadProviderSettings().catch(() => {});
          startRetentionSweep();
        } else {
          stopDriveTokenRefresh();
          stopRetentionSweep();
          rememberToken(undefined);
        }
        setLoading(false);
      };
      void transition.then(() => resume(), () => resume(true));
    });
    return () => { active = false; unsubscribe(); };
  }, []);
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
        <RouteTitle />
        {captureWarning && <div className="notice" role="alert">{captureWarning}</div>}
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
              <EntryRoute signedIn={Boolean(user)} setupPending={setupPending} notice={revoked}/>
            }
          />
          {/* Reachable signed out: signing in re-renders this page, keeping the signed request in the address. */}
          <Route path="/connect" element={<ConnectPage signedIn={Boolean(user)} />} />
          {/* One gate for every screen that wears the app frame. */}
          <Route
            element={<SessionGate signedIn={Boolean(user)}><AppLayout /></SessionGate>}
          >
            <Route path="/dashboard" element={setupPending?<Navigate to="/setup" replace/>:<Dashboard />} />
            <Route path="/setup" element={user?<SetupRoute owner={user.uid}/>:<Navigate to="/" replace/>} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/report/:id" element={<ReportPage />} />
          </Route>
          {/* Capture owns the whole viewport, so it stays outside the frame. */}
          <Route
            path="/record"
            element={<SessionGate signedIn={Boolean(user)}><RecordPage /></SessionGate>}
          />
          <Route
            path="*"
            element={<NotFound signedIn={Boolean(user)}/>}
          />
        </Routes>
      </BrowserRouter>
    </>
  );
}
