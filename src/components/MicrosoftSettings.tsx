import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
  return (
    <section className="panel" aria-label="Microsoft und Meeting-Speicherort">
      <h2>{meetingOnly ? "OneDrive für dieses Meeting" : "OneDrive"}</h2>
      <p className="muted">
        Dateizugriff ist keine Anmeldemethode. OneDrive benötigt
        „Files.ReadWrite“ für deine eigenen Dateien, nicht nur diesen Ordner.
      </p>
      <div className="actions">
        <button
          className="btn"
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
        {!meetingOnly && !storageOnly && (
          <Link className="btn" to="/setup">
            Kalenderanbieter, Konto und Kalender auswählen
          </Link>
        )}
      </div>
      <ul className="mcp-list">
        {connections.map((c) => (
          <li key={c.connectionId}>
            <span>
              <strong>{c.accountName}</strong>
              <small className="muted">
                OneDrive
                {c.calendar
                  ? " · Outlook freigegeben"
                  : " · Outlook nicht freigegeben"}
              </small>
            </span>
            {!meetingOnly && (
              <button
                className="btn"
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
            )}
          </li>
        ))}
      </ul>
      <p>
        <strong>
          {home
            ? `OneDrive · ${home.rootName}`
            : meetingOnly
              ? "Für dieses Meeting ist Google Drive gewählt"
              : "Kein OneDrive-Standardspeicher ausgewählt"}
        </strong>
      </p>
      {home && !connectedHome && (
        <p className="notice" role="status">
          {checked
            ? "Der gewählte OneDrive-Speicher ist nicht verbunden. Verbinde dasselbe Microsoft-Konto erneut oder wähle bewusst einen anderen Speicher für künftige Meetings. Bestehende Meetings wechseln nicht den Anbieter."
            : "Die Verbindung zum gewählten OneDrive-Speicher ist noch nicht bestätigt."}
        </p>
      )}
      <div className="actions">
        {meetingOnly && (
          <button
            className="btn"
            disabled={busy}
            aria-pressed={!home}
            onClick={() => void act(() => select(null))}
          >
            Google Drive wählen
          </button>
        )}
        {connections.length > 0 && (
          <>
            <label className="form-field">
              <span>Microsoft-Konto für die Ordnerauswahl</span>
              <select
                className="field"
                value={connection}
                disabled={busy}
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
            <button
              className="btn"
              disabled={
                busy || !connections.some((c) => c.connectionId === connection)
              }
              onClick={() => void act(() => browse())}
            >
              OneDrive-Ordner auswählen
            </button>
          </>
        )}
      </div>
      {current && (
        <div role="group" aria-label="OneDrive-Ordnerauswahl">
          <h3>{current.name || "OneDrive"}</h3>
          <button
            className="btn"
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
          {trail.length > 0 && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const next = [...trail];
                  await browse(next.pop()!);
                  setTrail(next);
                })
              }
            >
              Übergeordneter Ordner
            </button>
          )}
          <ul>
            {folders.map((f) => (
              <li key={f.id}>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await browse(f);
                      setTrail((t) => [...t, current]);
                    })
                  }
                >
                  {f.name}
                </button>
              </li>
            ))}
          </ul>
          {folders.length === 0 && (
            <p className="muted small">
              Keine Unterordner. Du kannst diesen Ordner verwenden.
            </p>
          )}
        </div>
      )}
      {!meetingOnly && home && (
        <button
          className="btn"
          disabled={busy || !connectedHome}
          onClick={() =>
            void act(async () => {
              const result = await restoreMicrosoftArchive(home, setMessage);
              setMessage(
                `${result.count} Meetings aus OneDrive wiederhergestellt.${result.errors.length ? ` ${result.errors.length} konnten nicht gelesen werden: ${result.errors[0]}` : ""}`,
              );
            })
          }
        >
          Meetings aus diesem OneDrive-Ordner wiederherstellen
        </button>
      )}
      {busy && <p role="status">Microsoft-Anfrage läuft …</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
          <button
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
        </p>
      )}
    </section>
  );
}
