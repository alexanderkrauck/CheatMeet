import { useEffect, useState } from "react";

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
  savedCalendarProvider,
  saveCalendarProvider,
  loadProviderSettings,
} from "../lib/providerSettings";
import { errorMessage } from "../lib/session";
import { restoreMicrosoftArchive } from "../lib/microsoftWorkflow";
import type { MicrosoftHome } from "../../shared/storage";
import { safeMicrosoftLink } from "../../shared/storage";
/** Account and archive are intentionally independent. A new default never moves old meetings. */
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
  const [calendar, setCalendar] = useState(savedCalendarProvider);
  const [connection, setConnection] = useState(
    home?.connectionId || connections[0]?.connectionId || "",
  );
  const [current, setCurrent] = useState<OneDriveItem | null>(null);
  const [trail, setTrail] = useState<OneDriveItem[]>([]);
  const [folders, setFolders] = useState<OneDriveItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (value !== undefined) setHome(value);
  }, [value]);
  useEffect(() => {
    let live = true;
    void loadMicrosoftConnections()
      .then((c) => {
        if (live) {
          setConnections(c);
          setConnection((old) => old || c[0]?.connectionId || "");
        }
      })
      .catch((e) => live && setError(errorMessage(e)));
    if (!meetingOnly)
      void loadProviderSettings()
        .then((s) => {
          if (live) {
            setHome(s.meetingHome);
            setCalendar(s.calendarProvider);
          }
        })
        .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [meetingOnly]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
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
        : "Standard für zukünftige Meetings gespeichert. Bestehende Meetings bleiben unverändert.",
    );
  }
  return (
    <section className="panel" aria-label="Microsoft und Meeting-Speicherort">
      <h2>{meetingOnly ? "Speicherort dieses Meetings" : "OneDrive"}</h2>
      <p className="muted">
        Anmeldung und Microsoft-Dateizugriff sind getrennt. OneDrive benötigt
        „Files.ReadWrite“: Zugriff auf deine eigenen Dateien, nicht nur diesen
        Ordner. Bestehende Freigaben bleiben unverändert.
      </p>

      <div className="actions">
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await connectMicrosoft(false);
              const c = await loadMicrosoftConnections();
              setConnections(c);
              setConnection(c[0]?.connectionId || "");
            })
          }
        >
          OneDrive verbinden
        </button>
        {!meetingOnly && !storageOnly && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await connectMicrosoft(true);
                setConnections(await loadMicrosoftConnections());
              })
            }
          >
            Outlook-Kalender freigeben
          </button>
        )}
      </div>
      {connections.map((c) => (
        <p key={c.connectionId}>
          {c.accountName}
          {c.calendar ? " · Kalender freigegeben" : " · Dateien"}{" "}
          {!meetingOnly && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await disconnectMicrosoft(c.connectionId);
                  setConnections(await loadMicrosoftConnections());
                })
              }
            >
              Verbindung entfernen
            </button>
          )}
        </p>
      ))}
      {!meetingOnly && !storageOnly && (
        <label className="form-field">
          Kalender für neue Zuordnungen
          <select
            className="field"
            value={calendar}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value as "google" | "microsoft";
              void act(async () => {
                await saveCalendarProvider(next);
                setCalendar(next);
              });
            }}
          >
            <option value="google">Google Kalender</option>
            <option value="microsoft">Outlook / Microsoft 365</option>
          </select>
        </label>
      )}
      <p>
        <strong>
          {home
            ? `OneDrive · ${home.rootName}`
            : "Kein OneDrive-Standardspeicher ausgewählt"}
        </strong>
      </p>
      <div className="actions">
        {meetingOnly && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void act(() => select(null))}
          >
            Google Drive wählen
          </button>
        )}
        {connections.length > 0 && (
          <>
            <select
              className="field"
              aria-label="Microsoft-Verbindung"
              value={connection}
              onChange={(e) => {
                setConnection(e.target.value);
                setCurrent(null);
              }}
            >
              {connections.map((c) => (
                <option value={c.connectionId} key={c.connectionId}>
                  {c.accountName}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={busy || !connection}
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
            disabled={busy || defaultSelectionDisabled}
            onClick={() =>
              void act(async () => {
                await select({
                  provider: "microsoft",
                  connectionId: connection,
                  driveId: current.parentReference!.driveId,
                  rootId: current.id,
                  rootName: current.name || "OneDrive",
                  ...(current.webUrl && safeMicrosoftLink(current.webUrl)
                    ? { webUrl: current.webUrl }
                    : {}),
                });
              })
            }
          >
            Diesen Ordner verwenden
          </button>
          {trail.length > 0 && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const next = [...trail];
                  const parent = next.pop()!;
                  await browse(parent);
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
        </div>
      )}
      {!meetingOnly && home && (
        <button
          className="btn"
          disabled={busy}
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
        </p>
      )}
    </section>
  );
}
