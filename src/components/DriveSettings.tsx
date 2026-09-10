import { useEffect, useState } from "react";
import { FolderOpen, ExternalLink } from "lucide-react";
import {
  chooseDriveFolder,
  getRootFolder,
  loadDriveFolder,
  saveDriveFolder,
  savedDriveFolder,
  type DriveFolder,
} from "../lib/driveSettings";
import { findOrCreateRootFolder, listDriveReports } from "../lib/drive";
import { connectGoogle, driveToken, errorMessage } from "../lib/session";
import { getLocal, putLocal } from "../lib/local";
import { uid } from "../lib/reports";
export default function DriveSettings({
  onImported,
}: {
  onImported?: () => void;
}) {
  const [folder, setFolder] = useState<DriveFolder | null>(savedDriveFolder);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void loadDriveFolder()
      .then((value) => {
        if (active) setFolder(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  async function select(useDefault = false) {
    const owner = uid();
    setBusy(true);
    setMessage("");
    try {
      const token = driveToken() || (await connectGoogle());
      const selected = useDefault
        ? {
            id: await findOrCreateRootFolder(token),
            name: "CheatMeet Recordings",
          }
        : await chooseDriveFolder(token);
      if (uid() !== owner)
        throw new Error(
          "Das Google-Konto wurde gewechselt. Bitte den Speicherort erneut wählen.",
        );
      if (selected) {
        const warning = await saveDriveFolder(selected);
        setFolder(selected);
        setMessage(
          warning ||
            "Speicherort gespeichert. Neue Meetings werden hier abgelegt.",
        );
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    setBusy(true);
    setMessage("Berichte in Drive suchen …");
    try {
      const user = uid();
      const token = driveToken() || (await connectGoogle());
      const { reports, warnings } = await listDriveReports(
        token,
        await getRootFolder(token),
      );
      if (uid() !== user)
        throw new Error(
          "Das Google-Konto wurde gewechselt. Bitte die Wiederherstellung erneut starten.",
        );
      let count = 0;
      let skipped = 0;
      for (const report of reports) {
        const local = await getLocal(user, report.id);
        if (
          local &&
          (local.dirty ||
            (local.report.updatedAt || local.report.date) >=
              (report.updatedAt || report.date))
        ) {
          skipped++;
          continue;
        }
        await putLocal(user, report);
        count++;
      }
      onImported?.();
      setMessage(
        `${count} Bericht(e) aus Drive wiederhergestellt. ${skipped ? `${skipped} neuere oder noch nicht synchronisierte lokale Bericht(e) beibehalten. ` : ""}${warnings.length ? `${warnings.length} Datei(en) konnten nicht gelesen werden. ${warnings[0]}` : count ? "Die Übersicht ist aktualisiert. Firebase kann über „Cloud erneut speichern“ nachgezogen werden." : "Keine weiteren Berichte gefunden."}`,
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel drive-settings"
      aria-labelledby="drive-settings-title"
    >
      <div>
        <span className="eyebrow">GOOGLE DRIVE</span>
        <h2 id="drive-settings-title">Ihr Speicherort</h2>
      </div>
      <p className="muted">
        Audio, Fotos und Berichte liegen in Ihrem Drive. Jede Meeting erhält
        einen eigenen Ordner.
      </p>
      <p
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          overflowWrap: "anywhere",
        }}
      >
        <FolderOpen size={20} aria-hidden="true" />{" "}
        <strong>{folder?.name || "CheatMeet Recordings"}</strong>
        {folder && (
          <a
            href={`https://drive.google.com/drive/folders/${encodeURIComponent(folder.id)}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Speicherordner in Google Drive öffnen"
          >
            <ExternalLink size={18} />
          </a>
        )}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void select()}
          disabled={busy}
        >
          {busy ? "Bitte warten …" : "Ordner auswählen"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void select(true)}
        >
          Standardordner verwenden
        </button>
      </div>
      <p className="muted" style={{ fontSize: ".85rem" }}>
        Eine Änderung gilt für neue Meetings. Bestehende Berichte bleiben in
        ihrem bisherigen Ordner.
      </p>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => void recover()}
      >
        Berichte aus Drive wiederherstellen
      </button>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
