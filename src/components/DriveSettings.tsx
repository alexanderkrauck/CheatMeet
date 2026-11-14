import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { mergeRestoredReport } from "../lib/reportProjection";
import {
  Check,
  ChevronDown,
  FolderOpen,
  ExternalLink,
  HardDrive,
} from "lucide-react";
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
import {
  connectGoogle,
  driveToken,
  ensureDriveToken,
  errorMessage,
  subscribeDriveSession,
} from "../lib/session";
import { getLocal, putLocal, ReportConflictError } from "../lib/local";
import { uid } from "../lib/reports";
import {
  saveMeetingHome,
  savedMeetingHome,
  loadProviderSettings,
} from "../lib/providerSettings";
import "../pages/settings.css";

export default function DriveSettings({
  onImported,
  onSelected,
  defaultSelectionDisabled = false,
  meetingOnly = false,
  selected = false,
  children,
}: {
  onImported?: () => void;
  onSelected?: () => void;
  defaultSelectionDisabled?: boolean;
  meetingOnly?: boolean;
  selected?: boolean;
  children?: ReactNode;
}) {
  const [folder, setFolder] = useState<DriveFolder | null>(savedDriveFolder);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [googleDefault, setGoogleDefault] = useState(() => !savedMeetingHome());
  const [ready, setReady] = useState(false);
  const connected = useSyncExternalStore(
    subscribeDriveSession,
    () => Boolean(driveToken()),
    () => false,
  );
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
          throw new Error(
            "Das Google-Konto wurde gewechselt. Bitte die Wiederherstellung erneut starten.",
          );
      };
      const run = async <T,>(operation: () => Promise<T>) => {
        check();
        const value = await operation();
        check();
        return value;
      };
      const token =
        (await run(() => ensureDriveToken())) ||
        (await run(() => connectGoogle()));
      const root = await run(() => getRootFolder(token));
      const { reports, warnings } = await run(() =>
        listDriveReports(token, root),
      );
      let count = 0;
      let skipped = 0;
      for (const report of reports) {
        const local = await run(() =>
          getLocal(user, report.id, { index: "reports" }),
        );
        const merged = mergeRestoredReport(local, report);
        if (!merged) {
          skipped++;
          continue;
        }
        try {
          await run(() =>
            putLocal(
              user,
              merged,
              local?.dirty ?? true,
              local?.report.updatedAt ?? null,
            ),
          );
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
  const connectAction = (
    <button
      type="button"
      className={`btn ${connected ? "provider-quiet-button" : "btn-primary"}`}
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
  );
  if (meetingOnly)
    return (
      <section
        className="panel drive-settings provider-card provider-meeting"
        aria-label="Google Drive für dieses Meeting"
      >
        <header className="provider-heading">
          <span className="provider-mark" aria-hidden="true">
            <HardDrive size={20} />
          </span>
          <div>
            <h2>Google Drive</h2>
            <p>Speicher für dieses Meeting</p>
          </div>
          {selected && (
            <span className="provider-status is-selected">
              <Check size={12} aria-hidden="true" /> Gewählt
            </span>
          )}
        </header>
        <div className="provider-folder">
          <FolderOpen size={18} aria-hidden="true" />
          <div>
            <small>Meeting-Archiv</small>
            <strong>{folder?.name || DEFAULT_FOLDER_NAME}</strong>
          </div>
        </div>
        <p className="provider-note">
          Nur den Speicher dieses Meetings wählen; der Standard für künftige
          Meetings bleibt unverändert.
        </p>
        <button
          type="button"
          className={`btn ${selected ? "provider-selected-button" : "btn-primary"}`}
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
          <p className="notice provider-notice" role="status">
            {message}
          </p>
        )}
      </section>
    );
  return (
    <section
      className="panel drive-settings provider-card"
      aria-labelledby="drive-settings-title"
    >
      <header className="provider-heading">
        <span className="provider-mark" aria-hidden="true">
          <HardDrive size={20} />
        </span>
        <div>
          <h2 id="drive-settings-title">Google Drive</h2>
          <p>Dein Meeting-Archiv</p>
        </div>
        <span
          className={`provider-status${ready && googleDefault ? " is-selected" : ""}`}
        >
          {ready && googleDefault ? (
            <>
              <Check size={12} aria-hidden="true" /> Standard
            </>
          ) : connected ? (
            "Zugriff verfügbar"
          ) : (
            "Zugriff prüfen"
          )}
        </span>
      </header>
      <p className="provider-description">
        Audio, Transkript und Bericht liegen in deinem Drive. Jedes Meeting
        bekommt einen eigenen Ordner.
      </p>
      <div className="provider-folder">
        <FolderOpen size={18} aria-hidden="true" />
        <div>
          <small>Ordner für neue Meetings</small>
          <strong>{folder?.name || DEFAULT_FOLDER_NAME}</strong>
        </div>
        {folder && (
          <a
            href={`https://drive.google.com/drive/folders/${encodeURIComponent(folder.id)}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Speicherordner in Google Drive öffnen"
            className="provider-icon-action"
          >
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        )}
      </div>
      {!connected && (
        <div className="provider-primary-actions">{connectAction}</div>
      )}
      <div className="provider-primary-actions">
        <button
          type="button"
          className="btn"
          aria-label="Ordner auswählen"
          onClick={() => void select()}
          disabled={busy}
        >
          {busy ? "Bitte warten …" : "Ordner auswählen"}
        </button>
        <button
          type="button"
          className={`btn ${ready && googleDefault ? "provider-selected-button" : "btn-primary"}`}
          aria-label="Google Drive als Standardspeicher verwenden"
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
          {ready && googleDefault ? (
            <>
              <Check size={14} aria-hidden="true" /> Als Standard gewählt
            </>
          ) : (
            "Als Standard verwenden"
          )}
        </button>
      </div>
      <p className="provider-note">
        {!ready
          ? "Die Anbieterwahl ist noch nicht bestätigt."
          : googleDefault
            ? "Auswahl für neue Meetings: Google Drive."
            : "Auswahl für neue Meetings: OneDrive. Ein Google-Ordner ändert das nicht."}{" "}
        Bestehende Meetings behalten ihren Ordner.
      </p>
      <details className="provider-advanced">
        <summary>
          Weitere Optionen <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <div className="provider-advanced-content">
          {connected && (
            <div className="provider-operation">
              <div>
                <strong>Zugriff verbinden</strong>
                <p>
                  Die Freigabe ändert weder deine Anmeldung noch den
                  Standardspeicher.
                </p>
              </div>
              {connectAction}
            </div>
          )}
          <div className="provider-operation">
            <div>
              <strong>App-Ordner verwenden</strong>
              <p>
                Verwendet „{DEFAULT_FOLDER_NAME}“ für neue Meetings mit Google
                Drive.
              </p>
            </div>
            <button
              type="button"
              className="btn provider-quiet-button"
              disabled={busy}
              onClick={() => void select(true)}
            >
              Standardordner verwenden
            </button>
          </div>
          <div className="provider-operation">
            <div>
              <strong>Archiv wiederherstellen</strong>
              <p>
                Liest gespeicherte Berichte ein. Neuere oder nicht
                synchronisierte lokale Fassungen bleiben erhalten.
              </p>
            </div>
            <button
              type="button"
              className="btn provider-quiet-button"
              disabled={busy}
              onClick={() => void recover()}
            >
              Berichte aus Drive wiederherstellen
            </button>
          </div>
          {children}
        </div>
      </details>
      {message && (
        <p className="notice provider-notice" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
