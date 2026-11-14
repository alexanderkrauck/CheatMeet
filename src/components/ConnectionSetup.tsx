import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import {
  connectGoogle,
  errorMessage,
  hasCalendarGrant,
  driveToken,
  subscribeDriveSession,
} from "../lib/session";
import {
  cachedMicrosoftConnections,
  connectMicrosoft,
  loadMicrosoftConnections,
} from "../lib/microsoft";
import {
  loadProviderSettings,
  savedCalendarProvider,
  savedCalendarConnectionId,
  savedCalendarId,
  savedMeetingHome,
  saveCalendarProvider,
} from "../lib/providerSettings";
import { availableCalendars } from "../lib/calendar";
import DriveSettings from "./DriveSettings";
import MicrosoftSettings from "./MicrosoftSettings";
import type { ServiceProvider } from "../../shared/storage";

/** Defaults change only after an explicit selection; existing meetings stay pinned. */
export default function ConnectionSetup({
  onComplete,
  returnTo,
}: { onComplete?: () => void; returnTo?: string } = {}) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [home, setHome] = useState(savedMeetingHome);
  const [calendar, setCalendar] = useState(savedCalendarProvider);
  const [googleCalendar, setGoogleCalendar] = useState(hasCalendarGrant);
  const [connections, setConnections] = useState(cachedMicrosoftConnections);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(() =>
    Boolean(driveToken()),
  );
  const [selectedAccount, setSelectedAccount] = useState(
    savedCalendarConnectionId,
  );
  const [account, setAccount] = useState(
    () => savedCalendarConnectionId() || "",
  );
  const [selectedCalendar, setSelectedCalendar] = useState(savedCalendarId);
  const [choices, setChoices] = useState<
    Partial<Record<ServiceProvider, { id: string; name: string }[]>>
  >({});
  const [calendarIds, setCalendarIds] = useState({
    google: calendar === "google" ? savedCalendarId() : "primary",
    microsoft: calendar === "microsoft" ? savedCalendarId() : "primary",
  });
  const storageConnected = home
    ? connections.some((c) => c.connectionId === home.connectionId)
    : googleConnected;
  const storageLabel = home
    ? `OneDrive · ${home.rootName}${storageConnected ? "" : " · Verbindung fehlt"}`
    : googleConnected
      ? "Google Drive"
      : "Noch kein Speicher verbunden";
  const selectedMicrosoft = connections.find(
    (c) => c.connectionId === selectedAccount && c.calendar,
  );
  const calendarConnected =
    calendar === "google" ? googleCalendar : Boolean(selectedMicrosoft);
  const calendarLabel = calendarConnected
    ? `${calendar === "google" ? "Google Kalender" : `Outlook · ${selectedMicrosoft!.accountName}`} · ${selectedCalendar === "primary" ? "Hauptkalender" : selectedCalendar}`
    : calendar === "microsoft"
      ? "Outlook ausgewählt · Verbindung fehlt oder Konto noch nicht gewählt"
      : "Noch kein Kalender verbunden";

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!active) return;
      setGoogleCalendar(hasCalendarGrant());
      setGoogleConnected(Boolean(driveToken()));
      setConnections(cachedMicrosoftConnections());
      setHome(savedMeetingHome());
      setCalendar(savedCalendarProvider());
      setSelectedAccount(savedCalendarConnectionId());
      setSelectedCalendar(savedCalendarId());
    };
    const unsubscribe = subscribeDriveSession(refresh);
    window.addEventListener("cheatmeet:provider-settings", refresh);
    void loadProviderSettings()
      .then((settings) => {
        if (active) {
          setHome(settings.meetingHome);
          setCalendar(settings.calendarProvider);
          setSelectedAccount(savedCalendarConnectionId());
          setSelectedCalendar(savedCalendarId());
          setAccount((old) => old || savedCalendarConnectionId() || "");
          setCalendarIds((old) => ({
            ...old,
            [settings.calendarProvider]: savedCalendarId(),
          }));
          setReady(true);
        }
      })
      .catch((e) => active && setError(errorMessage(e)));
    void loadMicrosoftConnections()
      .then((items) => active && setConnections(items))
      .catch(() => {
        /* Optional provider must not block Google. */
      });
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("cheatmeet:provider-settings", refresh);
    };
  }, []);

  async function act(action: () => Promise<void>) {
    const owner = auth.currentUser?.uid;
    setBusy(true);
    setError("");
    try {
      await action();
      if (auth.currentUser?.uid !== owner)
        throw Error(
          "Das angemeldete Konto hat sich geändert. Bitte die Einrichtung erneut öffnen.",
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function connectCalendar(provider: ServiceProvider) {
    if (provider === "google") {
      await connectGoogle();
      setGoogleCalendar(hasCalendarGrant());
    } else {
      await connectMicrosoft(true);
      setConnections(await loadMicrosoftConnections());
    }
  }
  return (
    <div className="settings-stack connection-setup">
      <div className="page-head">
        <div>
          <h1>Arbeitsbereich einrichten</h1>
          <p className="muted">
            Anmeldung, Speicher und Kalender getrennt wählen.
          </p>
        </div>
      </div>
      <nav aria-label="Einrichtungsschritte" className="setup-stepper">
        {["Konto", "Speicher", "Kalender", "Abschluss"].map((label, index) => (
          <button
            type="button"
            className="btn"
            key={label}
            disabled={busy}
            aria-current={step === index ? "step" : undefined}
            onClick={() => setStep(index)}
          >
            <span aria-hidden="true">{index + 1}</span> {label}
          </button>
        ))}
      </nav>
      <p className="muted small" role="status">
        Schritt {step + 1} von 4
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
          {!ready && (
            <button
              className="btn"
              onClick={() =>
                void act(async () => {
                  await loadProviderSettings();
                  setReady(true);
                })
              }
            >
              Erneut laden
            </button>
          )}
        </p>
      )}
      {step === 0 && (
        <section className="panel">
          <h2>Dein Konto ist angemeldet</h2>
          <p>
            <strong>
              {auth.currentUser?.displayName || "Dein Arbeitsbereich"}
            </strong>
            <br />
            {auth.currentUser?.email}
          </p>
          <p className="muted">
            Google Drive oder OneDrive wählen, den Kalender bei Bedarf separat
            verbinden. Bestehende Meetings bleiben unverändert.
          </p>
          <button className="btn btn-primary" onClick={() => setStep(1)}>
            Weiter zum Speicher
          </button>
        </section>
      )}
      {step === 1 && (
        <>
          <section className="panel">
            <h2>Speicher für neue Meetings</h2>
            <p>
              Aktueller Standard: <strong>{storageLabel}</strong>
            </p>
            <p className="muted">
              Ordner und Standardspeicher ausdrücklich wählen. Ohne Änderung
              bleibt die bisherige Auswahl erhalten.
            </p>
          </section>
          <div className="connection-provider-grid">
            <DriveSettings
              onSelected={() => setHome(null)}
              defaultSelectionDisabled={!ready}
            />
            <MicrosoftSettings
              storageOnly
              onSaved={setHome}
              defaultSelectionDisabled={!ready}
            />
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setStep(0)}>
              Zurück
            </button>
            <button className="btn btn-primary" onClick={() => setStep(2)}>
              Weiter zum Kalender
            </button>
          </div>
        </>
      )}
      {step === 2 && (
        <section className="panel">
          <h2>Kalender verbinden (optional)</h2>
          <p className="muted">
            Unabhängig von Anmeldung und Speicher. Überspringen behält die
            bisherige Auswahl bei.
          </p>
          <p>
            Aktuelle Auswahl: <strong>{calendarLabel}</strong>
          </p>
          <div className="connection-provider-grid">
            {(["google", "microsoft"] as const).map((provider) => {
              const connected =
                provider === "google"
                  ? googleCalendar
                  : connections.some(
                      (c) => c.calendar && c.connectionId === account,
                    );
              const name =
                provider === "google"
                  ? "Google Kalender"
                  : "Outlook / Microsoft 365";
              const id = calendarIds[provider];
              const options = choices[provider] || [];
              return (
                <section key={provider} className="panel" aria-label={name}>
                  <h3>{name}</h3>
                  <p className="muted small">
                    {provider === "google"
                      ? "Kalenderfreigabe und Drive-Zugriff werden separat vom Standardspeicher verwaltet."
                      : "Kalender und OneDrive-Dateizugriff sind keine Anmeldemethode."}
                  </p>
                  <p>
                    <span className="badge">
                      {connected
                        ? "Kalender freigegeben"
                        : "Kalenderfreigabe oder Konto fehlt"}
                    </span>
                  </p>
                  {provider === "microsoft" && (
                    <label className="form-field">
                      <span>Outlook-Konto</span>
                      <select
                        className="field"
                        disabled={busy}
                        value={account}
                        onChange={(e) => {
                          setAccount(e.target.value);
                          setChoices((old) => ({
                            ...old,
                            microsoft: undefined,
                          }));
                          setCalendarIds((old) => ({
                            ...old,
                            microsoft: "primary",
                          }));
                        }}
                      >
                        <option value="">Konto ausdrücklich wählen</option>
                        {account &&
                          !connections.some(
                            (c) => c.connectionId === account && c.calendar,
                          ) && (
                            <option value={account}>
                              Gewähltes Konto nicht verbunden
                            </option>
                          )}
                        {connections
                          .filter((c) => c.calendar)
                          .map((c) => (
                            <option value={c.connectionId} key={c.connectionId}>
                              {c.accountName}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <label className="form-field">
                    <span>{name}: Zielkalender</span>
                    <select
                      className="field"
                      disabled={busy || !connected}
                      value={id}
                      onChange={(e) =>
                        setCalendarIds((old) => ({
                          ...old,
                          [provider]: e.target.value,
                        }))
                      }
                    >
                      {!options.some((c) => c.id === id) && (
                        <option value={id}>
                          {id === "primary"
                            ? "Hauptkalender"
                            : `Gespeicherter Kalender · ${id}`}
                        </option>
                      )}
                      {options.map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="actions">
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => void act(() => connectCalendar(provider))}
                    >
                      {name} verbinden
                    </button>
                    <button
                      className="btn"
                      disabled={busy || !connected}
                      onClick={() =>
                        void act(async () => {
                          const items = await availableCalendars(
                            provider,
                            provider === "microsoft" ? account : undefined,
                          );
                          setChoices((old) => ({ ...old, [provider]: items }));
                        })
                      }
                    >
                      Kalenderliste laden
                    </button>
                    <button
                      className="btn"
                      disabled={
                        busy ||
                        !connected ||
                        !ready ||
                        Boolean(
                          choices[provider] &&
                          !options.some((c) => c.id === id),
                        )
                      }
                      aria-pressed={
                        calendarConnected &&
                        calendar === provider &&
                        (provider === "google" ||
                          selectedAccount === account) &&
                        selectedCalendar === id
                      }
                      onClick={() =>
                        void act(async () => {
                          await saveCalendarProvider(
                            provider,
                            provider === "microsoft" ? account : undefined,
                            id,
                          );
                          setCalendar(provider);
                          setSelectedAccount(
                            provider === "microsoft" ? account : undefined,
                          );
                          setSelectedCalendar(id);
                        })
                      }
                    >
                      {name} verwenden
                    </button>
                  </div>
                </section>
              );
            })}
          </div>
          <div className="actions">
            <button className="btn" disabled={busy} onClick={() => setStep(1)}>
              Zurück
            </button>
            <button className="btn" disabled={busy} onClick={() => setStep(3)}>
              Kalender überspringen
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => setStep(3)}
            >
              Weiter zum Abschluss
            </button>
          </div>
        </section>
      )}
      {step === 3 && (
        <section className="panel">
          <h2>
            {storageConnected
              ? "Dein Arbeitsbereich ist bereit"
              : "Einrichtung prüfen"}
          </h2>
          <p>
            Speicher: <strong>{storageLabel}</strong>
          </p>
          <p>
            Kalenderauswahl: <strong>{calendarLabel}</strong>
          </p>
          <p className="muted">
            Fehlende Verbindungen kannst du später einrichten. Bestehende
            Meetings behalten Speicher und Kalenderzuordnung.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setStep(2)}>
              Zurück
            </button>
            <button
              className="btn btn-primary"
              onClick={() =>
                onComplete
                  ? onComplete()
                  : navigate(returnTo?.startsWith("/connect?") ? returnTo : "/")
              }
            >
              Einrichtung abschließen
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
