import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  AudioLines,
  Cloud,
  LayoutGrid,
  Loader2,
  LogOut,
  Plus,
  Search,
  UserRound,
  WifiOff,
} from "lucide-react";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase";
import type { ReportData } from "../types";
export function Brand() {
  return (
    <Link to="/dashboard" className="brand" aria-label="CheatMeet Übersicht">
      <span className="brand-mark">
        <AudioLines size={23} />
      </span>
      Cheat<span className="brand-light">Meet</span>
      <span className="brand-dot">.</span>
    </Link>
  );
}
/**
 * The app frame. The header carries real work — global search over past
 * meetings, the one action that starts a meeting, and the account menu —
 * rather than holding a logo and nothing else.
 */
export function Shell({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [online, setOnline] = useState(navigator.onLine);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const account = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    const close = (event: Event) => {
      const node = account.current;
      if (!node?.open) return;
      if (event.type === "keydown") {
        if ((event as KeyboardEvent).key === "Escape") node.open = false;
        return;
      }
      if (!node.contains(event.target as Node)) node.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  return (
    <>
      <header className="app-header no-print">
        <div className="header-inner">
          <Brand />
          <form
            className="header-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              navigate(
                query.trim()
                  ? `/dashboard?q=${encodeURIComponent(query.trim())}`
                  : "/dashboard",
              );
            }}
          >
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Meetings und Transkripte durchsuchen …"
              aria-label="Meetings und Transkripte durchsuchen"
            />
          </form>
          <div className="header-actions">
            {actions}
            <Link to="/record?new=1" className="btn btn-primary header-new">
              <Plus size={17} />
              <span className="hide-mobile">Neues Meeting</span>
            </Link>
            <details className="header-account" ref={account}>
              <summary aria-label="Konto und Einstellungen">
                <UserRound size={18} />
              </summary>
              <div>
                <Link to="/dashboard">
                  <LayoutGrid size={16} /> Übersicht
                </Link>
                <button
                  onClick={() => {
                    if (account.current) account.current.open = false;
                    void signOut(auth).catch(() => {});
                  }}
                >
                  <LogOut size={16} /> Abmelden
                </button>
              </div>
            </details>
          </div>
        </div>
      </header>
      {!online && (
        <div className="offline no-print">
          <WifiOff size={16} /> Offline · Lokale Entwürfe sind verfügbar.
          Analyse und Cloud-Speichern benötigen Internet.
        </div>
      )}
      <main className="page">{children}</main>
      <footer className="app-footer no-print">
        <span>CHEATMEET / DEIN DIGITALER MEETING-ASSISTENT</span>
        <span>
          <Cloud size={14} /> Dateien in deinem Google Drive
        </span>
      </footer>
    </>
  );
}

export function Notice({
  children,
  kind = "error",
}: {
  children: ReactNode;
  kind?: "error" | "success" | "info";
}) {
  return (
    <div
      className={`notice ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Busy({ text }: { text: string }) {
  return (
    <div className="busy" role="status">
      <Loader2 className="spin" size={20} />
      {text}
    </div>
  );
}
export const dateLabel = (date: string) =>
  new Date(date).toLocaleDateString("de-AT", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
export function Status({
  report,
  local,
}: {
  report: ReportData;
  local?: boolean;
}) {
  const text =
    report.status === "completed"
      ? "Bericht erstellt"
      : report.status === "error"
        ? "Analyse wiederholen"
        : report.status === "analyzing"
          ? "Analyse unterbrochen?"
          : "Entwurf";
  return (
    <span className="status-group">
      <span
        className={`badge ${report.status !== "completed" ? "amber" : "green"}`}
      >
        <span className="status-dot" />
        {text}
      </span>
      {local && (
        <span className="badge amber">
          {report.driveSyncedAt
            ? "Drive gesichert · App-Index ausstehend"
            : "Cloud-Speichern ausstehend"}
        </span>
      )}
    </span>
  );
}
export function DriveLink({ id }: { id: string }) {
  return (
    <a
      className="btn"
      href={`https://drive.google.com/drive/folders/${encodeURIComponent(id)}`}
      target="_blank"
      rel="noreferrer"
    >
      Drive öffnen <ArrowUpRight size={16} />
    </a>
  );
}
export function BlobImage({ blob, alt }: { blob: Blob; alt: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return <img src={url || undefined} alt={alt} />;
}
/**
 * MediaRecorder omits the container duration, so a freshly recorded blob makes
 * the player report `Infinity` and refuse to seek. The recording clock knows
 * the real length, so state it rather than leaving the control broken.
 */
export function AudioPreview({
  blob,
  durationMs,
}: {
  blob: Blob;
  durationMs?: number;
}) {
  const [url, setUrl] = useState("");
  const [unseekable, setUnseekable] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    setUnseekable(false);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return (
    <div className="audio-preview">
      <audio
        controls
        src={url || undefined}
        aria-label="Aufnahme anhören"
        onLoadedMetadata={(e) =>
          setUnseekable(!Number.isFinite(e.currentTarget.duration))
        }
      />
      {unseekable && durationMs ? (
        <small>
          Länge {Math.floor(durationMs / 60000)}:
          {Math.floor((durationMs / 1000) % 60)
            .toString()
            .padStart(2, "0")}{" "}
          · springen erst nach dem Sichern in Drive möglich
        </small>
      ) : null}
    </div>
  );
}
