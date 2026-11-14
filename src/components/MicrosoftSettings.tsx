import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  ExternalLink,
  FolderOpen,
  Loader2,
  UserRound,
} from "lucide-react";
import { auth } from "../lib/firebase";
import {
  cachedMicrosoftConnections,
  connectMicrosoft,
  disconnectMicrosoft,
  loadMicrosoftConnections,
  type MicrosoftConnection,
} from "../lib/microsoft";
import {
  listOneDriveFolders,
  oneDriveRoot,
  type OneDriveItem,
} from "../lib/onedrive";
import {
  savedMeetingHome,
  saveMeetingHome,
  loadProviderSettings,
} from "../lib/providerSettings";
import { errorMessage } from "../lib/session";
import { restoreMicrosoftArchive } from "../lib/microsoftWorkflow";
import { safeMicrosoftLink, type MicrosoftHome } from "../../shared/storage";
import "../pages/settings.css";

/** A missing pinned account never selects another account or provider. */
export default function MicrosoftSettings({
  onSelect,
  meetingOnly = false,
  value,
  storageOnly = false,
  onSaved,
  defaultSelectionDisabled = false,
}: {
  onSelect?: (home: MicrosoftHome | null) => void;
  meetingOnly?: boolean;
  value?: MicrosoftHome | null;
  storageOnly?: boolean;
  onSaved?: (home: MicrosoftHome | null) => void;
  defaultSelectionDisabled?: boolean;
}) {
  const [connections, setConnections] = useState<MicrosoftConnection[]>(
    cachedMicrosoftConnections,
  );
  const [home, setHome] = useState<MicrosoftHome | null>(
    value === undefined ? savedMeetingHome : value,
  );
  const [connection, setConnection] = useState(home?.connectionId || "");
  const [current, setCurrent] = useState<OneDriveItem | null>(null);
  const [trail, setTrail] = useState<OneDriveItem[]>([]);
  const [folders, setFolders] = useState<OneDriveItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(meetingOnly);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (value !== undefined) setHome(value);
  }, [value]);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (live) {
        setConnections(cachedMicrosoftConnections());
        if (!meetingOnly) setHome(savedMeetingHome());
      }
    };
    window.addEventListener("cheatmeet:provider-settings", refresh);
    void loadMicrosoftConnections()
      .then((c) => {
        if (live) {
          setConnections(c);
          setChecked(true);
        }
      })
      .catch((e) => live && setError(errorMessage(e)));
    if (!meetingOnly)
      void loadProviderSettings()
        .then((s) => {
          if (live) {
            setHome(s.meetingHome);
            setConnection((old) => old || s.meetingHome?.connectionId || "");
            setReady(true);
          }
        })
        .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
      window.removeEventListener("cheatmeet:provider-settings", refresh);
    };
  }, [meetingOnly]);
  async function act(fn: () => Promise<void>) {
    const owner = auth.currentUser?.uid;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      if (auth.currentUser?.uid !== owner)
        throw Error("Das angemeldete Konto hat sich geändert.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function browse(item?: OneDriveItem) {
    const root = item || (await oneDriveRoot(connection));
    const driveId = root.parentReference?.driveId;
    if (!driveId)
      throw Error("OneDrive hat keine Laufwerksreferenz geliefert.");
    const children = await listOneDriveFolders(connection, driveId, root.id);
    setCurrent(root);
    setFolders(children);
    if (!item) setTrail([]);
  }
  async function select(next: MicrosoftHome | null) {
    if (onSelect) onSelect(next);
    else await saveMeetingHome(next);
    setHome(next);
    onSaved?.(next);
    setCurrent(null);
    setMessage(
      onSelect
        ? "Speicherort für dieses Meeting gewählt."
        : "Standard für künftige Meetings gespeichert. Bestehende Meetings bleiben unverändert.",
    );
  }
  const connectedHome =
    home && connections.some((c) => c.connectionId === home.connectionId);
  const folderAccount = connections.find((c) => c.connectionId === connection);
  const connectAction = (
    <button
      type="button"
      className={`btn ${connections.length ? "provider-quiet-button" : "btn-primary"}`}
      disabled={busy}
      onClick={() =>
        void act(async () => {
          await connectMicrosoft(false);
          setConnections(await loadMicrosoftConnections());
          setChecked(true);
          setMessage(
            "OneDrive verbunden. Prüfe die Kalenderfreigabe beim gewünschten Konto. Der Standardspeicher bleibt unverändert.",
          );
        })
      }
    >
      OneDrive verbinden
    </button>
  );
  return (
    <section
      className={`panel provider-card microsoft-settings${meetingOnly ? " provider-meeting" : ""}`}
      aria-label="Microsoft und Meeting-Speicherort"
    >
      <header className="provider-heading">
        <span className="provider-mark is-microsoft" aria-hidden="true">
          <Cloud size={21} />
        </span>
        <div>
          <h2>OneDrive</h2>
          <p>
            {meetingOnly
              ? "Speicher für dieses Meeting"
              : "Dein Meeting-Archiv"}
          </p>
        </div>
        <span
          className={`provider-status${home && ready ? " is-selected" : ""}`}
        >
          {home && ready ? (
            <>
              <Check size={12} aria-hidden="true" />
              {meetingOnly ? "Gewählt" : "Standard"}
            </>
          ) : !checked ? (
            "Wird geprüft"
          ) : connections.length ? (
            "Verbunden"
          ) : (
            "Nicht verbunden"
          )}
        </span>
      </header>
      <p className="provider-permission">
        Dateizugriff ist keine Anmeldemethode. OneDrive benötigt
        „Files.ReadWrite“ für deine eigenen Dateien, nicht nur diesen Ordner.
      </p>
      {connections.length === 0 && (
        <div className="provider-primary-actions">{connectAction}</div>
      )}

      {connections.length > 0 && (
        <ul className="provider-accounts">
          {connections.map((c) => (
            <li key={c.connectionId}>
              <div className="provider-account-row">
                <UserRound size={15} aria-hidden="true" />
                <div>
                  <strong>{c.accountName}</strong>
                  <small>
                    OneDrive
                    {c.calendar
                      ? " · Outlook freigegeben"
                      : " · Outlook nicht freigegeben"}
                  </small>
                </div>
              </div>
              {!meetingOnly && (
                <details className="provider-account-access">
                  <summary>
                    Verbindung verwalten{" "}
                    <ChevronDown size={13} aria-hidden="true" />
                  </summary>
                  <div className="provider-account-actions">
                    <p>
                      Entfernt den Zugriff über diese Verbindung auf allen
                      Geräten. Dateien und Anmeldemethoden bleiben erhalten.
                      Bestehende Meetings wechseln nicht zu Google.
                    </p>
                    <button
                      type="button"
                      className="btn danger provider-quiet-button"
                      disabled={busy}
                      aria-label={`Microsoft-Verbindung ${c.accountName} entfernen`}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Microsoft-Verbindung „${c.accountName}“ für diesen Arbeitsbereich auf allen Geräten entfernen?\n\nOneDrive${c.calendar ? " und Outlook-Kalender" : ""} sind danach über diese Verbindung nicht erreichbar. Noch laufende Uploads und Verarbeitungen können anhalten. Speicher- und Kalenderzuordnungen bleiben bestehen; es gibt keinen Wechsel zu Google.\n\nDateien und Anmeldemethoden werden nicht gelöscht. Dies widerruft nicht generell die App-Berechtigungen im Microsoft-Konto. Für bestehende Meetings dasselbe Konto erneut verbinden.`,
                          )
                        )
                          return;
                        void act(async () => {
                          await disconnectMicrosoft(c.connectionId);
                          setConnections(cachedMicrosoftConnections());
                          setChecked(true);
                          setCurrent(null);
                          setMessage(
                            `Verbindung „${c.accountName}“ entfernt. Für bestehende Zuordnungen dasselbe Microsoft-Konto erneut verbinden.`,
                          );
                        });
                      }}
                    >
                      Verbindung entfernen
                    </button>
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      {home ? (
        <div className="provider-folder">
          <FolderOpen size={18} aria-hidden="true" />
          <div>
            <small>
              {meetingOnly
                ? "Ordner dieses Meetings"
                : "Ordner für neue Meetings"}
            </small>
            <strong>{home.rootName}</strong>
          </div>
          {home.webUrl && safeMicrosoftLink(home.webUrl) && (
            <a
              className="provider-icon-action"
              href={home.webUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Speicherordner in OneDrive öffnen"
            >
              <ExternalLink size={16} aria-hidden="true" />
            </a>
          )}
        </div>
      ) : (
        <p className="provider-note">
          {meetingOnly
            ? "Für dieses Meeting ist Google Drive gewählt"
            : "Kein OneDrive-Standardspeicher ausgewählt"}
        </p>
      )}
      {home && !connectedHome && (
        <p className="notice provider-notice" role="status">
          {checked
            ? "Der gewählte OneDrive-Speicher ist nicht verbunden. Verbinde dasselbe Microsoft-Konto erneut oder wähle bewusst einen anderen Speicher für künftige Meetings. Bestehende Meetings wechseln nicht den Anbieter."
            : "Die Verbindung zum gewählten OneDrive-Speicher ist noch nicht bestätigt."}
        </p>
      )}
      {meetingOnly && (
        <div className="provider-primary-actions">
          <button
            type="button"
            className={`btn ${!home ? "provider-selected-button" : ""}`}
            disabled={busy}
            aria-pressed={!home}
            onClick={() => void act(() => select(null))}
          >
            Google Drive wählen
          </button>
        </div>
      )}
      {connections.length > 0 && (
        <div className="provider-folder-controls">
          <label className="form-field">
            <span>Microsoft-Konto für die Ordnerauswahl</span>
            <select
              className="field"
              value={connection}
              disabled={busy}
              title={folderAccount?.accountName || "Microsoft-Konto wählen"}
              onChange={(e) => {
                setConnection(e.target.value);
                setCurrent(null);
              }}
            >
              <option value="">Microsoft-Konto wählen</option>
              {connection &&
                !connections.some((c) => c.connectionId === connection) && (
                  <option value={connection}>
                    Gewähltes Konto nicht verbunden
                  </option>
                )}
              {connections.map((c) => (
                <option value={c.connectionId} key={c.connectionId}>
                  {c.accountName}
                </option>
              ))}
            </select>
          </label>
          {folderAccount && (
            <p className="provider-selected-account">
              Ordnerauswahl mit: {folderAccount.accountName}
            </p>
          )}
          <button
            type="button"
            className="btn"
            disabled={
              busy || !connections.some((c) => c.connectionId === connection)
            }
            onClick={() => void act(() => browse())}
          >
            <FolderOpen size={15} aria-hidden="true" />
            OneDrive-Ordner auswählen
          </button>
        </div>
      )}
      {current && (
        <div
          className="provider-browser"
          role="group"
          aria-label="OneDrive-Ordnerauswahl"
        >
          <div className="provider-browser-heading">
            {trail.length > 0 && (
              <button
                type="button"
                className="btn provider-quiet-button"
                disabled={busy}
                aria-label="Übergeordneter Ordner"
                onClick={() =>
                  void act(async () => {
                    const next = [...trail];
                    await browse(next.pop()!);
                    setTrail(next);
                  })
                }
              >
                <ArrowUp size={16} aria-hidden="true" />
              </button>
            )}
            <FolderOpen size={16} aria-hidden="true" />
            <h3>{current.name || "OneDrive"}</h3>
          </div>
          <ul className="provider-folder-list">
            {folders.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await browse(f);
                      setTrail((t) => [...t, current]);
                    })
                  }
                >
                  <FolderOpen size={15} aria-hidden="true" />
                  <span>{f.name}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {folders.length === 0 && (
            <p className="provider-note">
              Keine Unterordner. Du kannst diesen Ordner verwenden.
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || defaultSelectionDisabled || !ready}
            aria-pressed={
              home?.connectionId === connection && home?.rootId === current.id
            }
            onClick={() =>
              void act(() =>
                select({
                  provider: "microsoft",
                  connectionId: connection,
                  driveId: current.parentReference!.driveId,
                  rootId: current.id,
                  rootName: current.name || "OneDrive",
                  ...(current.webUrl && safeMicrosoftLink(current.webUrl)
                    ? { webUrl: current.webUrl }
                    : {}),
                }),
              )
            }
          >
            {meetingOnly
              ? "Diesen Ordner für dieses Meeting wählen"
              : "Diesen Ordner als Standard verwenden"}
          </button>
        </div>
      )}
      {!meetingOnly && (
        <p className="provider-note">
          Wähle Konto und Ordner, um OneDrive als Standard für künftige Meetings
          zu verwenden. Bestehende Meetings bleiben unverändert.
        </p>
      )}
      {meetingOnly && connections.length > 0 && (
        <div className="provider-primary-actions">{connectAction}</div>
      )}
      {!meetingOnly && (connections.length > 0 || home || !storageOnly) && (
        <details className="provider-advanced">
          <summary>
            Weitere Optionen <ChevronDown size={15} aria-hidden="true" />
          </summary>
          <div className="provider-advanced-content">
            {connections.length > 0 && (
              <div className="provider-operation">
                <div>
                  <strong>Weiteres Konto verbinden</strong>
                  <p>
                    Eine zusätzliche Freigabe ändert den Standardspeicher nicht.
                  </p>
                </div>
                {connectAction}
              </div>
            )}
            {!storageOnly && (
              <Link className="btn provider-quiet-button" to="/setup">
                Kalenderanbieter, Konto und Kalender auswählen
              </Link>
            )}
            {home && (
              <div className="provider-operation">
                <div>
                  <strong>Archiv wiederherstellen</strong>
                  <p>Meetings aus dem ausgewählten OneDrive-Archiv einlesen.</p>
                </div>
                <button
                  type="button"
                  className="btn provider-quiet-button"
                  disabled={busy || !connectedHome}
                  onClick={() =>
                    void act(async () => {
                      const result = await restoreMicrosoftArchive(
                        home,
                        setMessage,
                      );
                      setMessage(
                        `${result.count} Meetings aus OneDrive wiederhergestellt.${result.errors.length ? ` ${result.errors.length} konnten nicht gelesen werden: ${result.errors[0]}` : ""}`,
                      );
                    })
                  }
                >
                  Meetings aus diesem OneDrive-Ordner wiederherstellen
                </button>
              </div>
            )}
          </div>
        </details>
      )}
      {busy && (
        <p className="provider-busy" role="status">
          <Loader2 className="spin" size={14} aria-hidden="true" />
          Microsoft-Anfrage läuft …
        </p>
      )}
      {message && (
        <p className="notice provider-notice" role="status">
          {message}
        </p>
      )}
      {error && (
        <div role="alert" className="notice provider-notice">
          <p>{error}</p>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setConnections(await loadMicrosoftConnections());
                setChecked(true);
                if (!meetingOnly) {
                  const settings = await loadProviderSettings();
                  setHome(settings.meetingHome);
                  setReady(true);
                }
              })
            }
          >
            Verbindungen erneut laden
          </button>
        </div>
      )}
    </section>
  );
}
