import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, AudioLines, Cloud, Loader2, WifiOff } from "lucide-react";
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
export function Shell({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return (
    <>
      <header className="app-header no-print">
        <div className="header-inner">
          <Brand />
          <nav>{actions}</nav>
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
export function AudioPreview({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return (
    <audio controls src={url || undefined} aria-label="Aufnahme anhören" />
  );
}
