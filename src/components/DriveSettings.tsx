import { useEffect, useState } from "react";
import { mergeRestoredReport } from "../lib/reportProjection";
import { FolderOpen, ExternalLink } from "lucide-react";
import {
  chooseDriveFolder,
  getRootFolder,
  loadDriveFolder,
  saveDriveFolder,
  savedDriveFolder,
  type DriveFolder,
} from "../lib/driveSettings";
import {
  DEFAULT_FOLDER_NAME,
  findOrCreateRootFolder,
  listDriveReports,
} from "../lib/drive";
import { connectGoogle, ensureDriveToken, errorMessage } from "../lib/session";
import { getLocal, putLocal, ReportConflictError } from "../lib/local";
import { uid } from "../lib/reports";
import {
  saveMeetingHome,
  savedMeetingHome,
  loadProviderSettings,
} from "../lib/providerSettings";
export default function DriveSettings({
  onImported,
  onSelected,
  defaultSelectionDisabled = false,
  meetingOnly = false,
  selected = false,
}: {
  onImported?: () => void;
  onSelected?: () => void;
  defaultSelectionDisabled?: boolean;
  meetingOnly?: boolean;
  selected?: boolean;
}) {
  const [folder, setFolder] = useState<DriveFolder | null>(savedDriveFolder);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [googleDefault, setGoogleDefault] = useState(() => !savedMeetingHome());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) setGoogleDefault(!savedMeetingHome());
    };
    window.addEventListener("cheatmeet:provider-settings", refresh);
    if (!meetingOnly)
      void loadProviderSettings()
        .then(() => {
          if (active) {
            refresh();
            setReady(true);
          }
        })
        .catch((e) => active && setMessage(errorMessage(e)));
    void loadDriveFolder()
      .then((value) => {
        if (active) setFolder(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      window.removeEventListener("cheatmeet:provider-settings", refresh);
    };
  }, [meetingOnly]);
  async function select(useDefault = false) {
    const owner = uid();
    setBusy(true);
    setMessage("");
    try {
      const token = (await ensureDriveToken()) || (await connectGoogle());
      const selected = useDefault
        ? {
            id: await findOrCreateRootFolder(token),
            name: DEFAULT_FOLDER_NAME,
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
            "Google-Drive-Ordner gespeichert. Die Anbieterwahl bleibt unverändert; der Ordner gilt nur für neue Meetings mit Google Drive.",
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
      const check = () => {
        if (uid() !== user)
          throw new Error("Das Google-Konto wurde gewechselt. Bitte die Wiederherstellung erneut starten.");
      };
      const run = async <T,>(operation: () => Promise<T>) => {
        check();
        const value = await operation();
        check();
        return value;
      };
      const token = (await run(() => ensureDriveToken())) || (await run(() => connectGoogle()));
      const root = await run(() => getRootFolder(token));
      const { reports, warnings } = await run(() => listDriveReports(token, root));
      let count = 0;
      let skipped = 0;
      for (const report of reports) {
        const local = await run(() => getLocal(user, report.id, { index: "reports" }));
        const merged = mergeRestoredReport(local, report);
        if (!merged) {
          skipped++;
          continue;
        }
        try {
          await run(() => putLocal(user, merged, local?.dirty ?? true, local?.report.updatedAt ?? null));
        } catch (error) {
          check();
          if (!(error instanceof ReportConflictError)) throw error;
          skipped++;
          continue;
        }
        count++;
      }
      onImported?.();
      setMessage(
        `${count} Bericht(e) aus Drive wiederhergestellt. ${skipped ? `${skipped} neuere oder noch nicht synchronisierte lokale Bericht(e) beibehalten. ` : ""}${warnings.length ? `${warnings.length} Datei(en) konnten nicht gelesen werden. ${warnings[0]}` : count ? "Die Übersicht ist aktualisiert." : "Keine weiteren Berichte gefunden."}`,
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  if (meetingOnly)
    return (
      <section
        className="panel drive-settings"
        aria-label="Google Drive für dieses Meeting"
      >
        <h2>Google Drive</h2>
        <p className="muted">
          Ordner: <strong>{folder?.name || DEFAULT_FOLDER_NAME}</strong>. Nur
          den Speicher dieses Meetings wählen; der Standard für künftige
          Meetings bleibt unverändert.
        </p>
        <button
          type="button"
          className="btn"
          aria-pressed={selected}
          disabled={busy || !onSelected}
          onClick={() => {
            const owner = uid();
            setBusy(true);
            setMessage("");
            void (async () => {
              (await ensureDriveToken()) || (await connectGoogle());
              if (uid() !== owner)
                throw Error("Das angemeldete Konto hat sich geändert.");
              onSelected?.();
              setMessage("Google Drive für dieses Meeting gewählt.");
            })()
              .catch((e) => setMessage(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          Google Drive für dieses Meeting wählen
        </button>
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
      </section>
    );
  return (
    <section
      className="panel drive-settings"
      aria-labelledby="drive-settings-title"
    >
      <div>
        <span className="eyebrow">GOOGLE DRIVE</span>
        <h2 id="drive-settings-title">Google Drive</h2>
      </div>
      <p className="muted">
        Audio, Transkript und Bericht liegen in deinem Drive. Jedes Meeting
        bekommt einen eigenen Ordner.
      </p>
      <p className="drive-folder">
        <FolderOpen size={20} aria-hidden="true" />{" "}
        <strong>{folder?.name || DEFAULT_FOLDER_NAME}</strong>
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
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setMessage("");
            void connectGoogle()
              .then(() =>
                setMessage(
                  "Google Drive verbunden. Der Standardspeicher bleibt unverändert.",
                ),
              )
              .catch((e) => setMessage(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          Google Drive verbinden
        </button>
        <button
          type="button"
          className="btn"
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
      <p className="muted small">
        {!ready
          ? "Die Anbieterwahl ist noch nicht bestätigt."
          : googleDefault
            ? "Auswahl für neue Meetings: Google Drive."
            : "Auswahl für neue Meetings: OneDrive. Ein Google-Ordner ändert das nicht."}{" "}
        Bestehende Meetings behalten ihren Ordner.
      </p>
      <button
        type="button"
        className="btn"
        disabled={busy || defaultSelectionDisabled}
        aria-pressed={ready && googleDefault}
        onClick={() => {
          setBusy(true);
          setMessage("");
          const owner = uid();
          void (async () => {
            (await ensureDriveToken()) || (await connectGoogle());
            if (uid() !== owner)
              throw new Error(
                "Das angemeldete Konto hat sich geändert. Bitte den Standardspeicher erneut wählen.",
              );
            await saveMeetingHome(null);
            if (uid() !== owner)
              throw new Error("Das angemeldete Konto hat sich geändert.");
            onSelected?.();
            setReady(true);
            setGoogleDefault(true);
            setMessage(
              "Google Drive als Standard für neue Meetings gespeichert. Bestehende Meetings bleiben unverändert.",
            );
          })()
            .catch((e) => setMessage(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        Google Drive als Standardspeicher verwenden
      </button>
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
