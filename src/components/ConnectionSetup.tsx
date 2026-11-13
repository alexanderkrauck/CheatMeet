import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import { connectGoogle, errorMessage, hasCalendarGrant, driveToken } from "../lib/session";
import {
  cachedMicrosoftConnections,
  connectMicrosoft,
  loadMicrosoftConnections,
} from "../lib/microsoft";
import {
  loadProviderSettings,
  savedCalendarProvider,
  savedMeetingHome,
  saveCalendarProvider,
} from "../lib/providerSettings";
import DriveSettings from "./DriveSettings";
import MicrosoftSettings from "./MicrosoftSettings";
import type { ServiceProvider } from "../../shared/storage";

/** Reopening setup never migrates meetings or changes a default without an explicit choice. */
export default function ConnectionSetup({
  onComplete,
}: { onComplete?: () => void } = {}) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [home, setHome] = useState(savedMeetingHome);
  const [calendar, setCalendar] = useState(savedCalendarProvider);
  const [googleCalendar, setGoogleCalendar] = useState(hasCalendarGrant);
  const [connections, setConnections] = useState(cachedMicrosoftConnections);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const storageLabel=home?`OneDrive · ${home.rootName}`:driveToken()?'Google Drive':'Noch kein Speicher verbunden';
  const calendarConnected=calendar==='google'?googleCalendar:connections.some(c=>c.calendar);
  const calendarLabel=calendarConnected?(calendar==='google'?'Google Kalender':'Outlook / Microsoft 365'):'Noch kein Kalender verbunden';
  useEffect(() => {
    let active = true;
    void loadProviderSettings()
      .then((settings) => {
        if (active) {
          setHome(settings.meetingHome);
          setCalendar(settings.calendarProvider);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    void loadMicrosoftConnections()
      .then((items) => {
        if (active) setConnections(items);
      })
      .catch(() => {
        /* Unconfigured Microsoft must not block Google setup. */
      });
    return () => {
      active = false;
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
            Anmeldung, Speicher und Kalender sind unabhängig voneinander.
          </p>
        </div>
      </div>
      <nav aria-label="Einrichtungsschritte" className="actions">
        {["Konto", "Speicher", "Kalender", "Abschluss"].map((label, index) => (
          <span key={label} aria-current={step === index ? "step" : undefined}>
            {index + 1}. {label}
            {index < 3 ? " →" : ""}
          </span>
        ))}
      </nav>
      {error && (
        <p className="notice" role="alert">
          {error}
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
            Wähle als Nächstes, wo neue Meetings gespeichert werden. Du kannst
            Google Drive oder OneDrive mit jeder Anmeldemethode verwenden und
            den Kalender separat verbinden.
          </p>
          <p className="muted small">
            Bestehende Konten, Freigaben und Meetings bleiben erhalten. Die
            Einrichtung kann jederzeit in den Einstellungen erneut geöffnet
            werden.
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
              Aktueller Standard:{" "}
              <strong>
                {storageLabel}
              </strong>
            </p>
            <p className="muted">
              Wähle einen Ordner und bestätige den gewünschten Standardspeicher.
              Ohne Änderung bleibt dein bisheriger Standard erhalten. Bestehende
              Meetings werden nicht verschoben.
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
            Der Kalender muss nicht vom selben Anbieter wie dein Speicher oder
            deine Anmeldung sein. Überspringen behält die bisherige
            Kalenderauswahl bei.
          </p>
          <p>
            Aktuelle Auswahl:{" "}
            <strong>
              {calendarLabel}
            </strong>
          </p>
          <div className="connection-provider-grid">
            {(["google", "microsoft"] as const).map((provider) => {
              const connected =
                provider === "google"
                  ? googleCalendar
                  : connections.some((c) => c.calendar);
              const name =
                provider === "google"
                  ? "Google Kalender"
                  : "Outlook / Microsoft 365";
              return (
                <section key={provider} className="panel" aria-label={name}>
                  <h3>{name}</h3>
                  <p>
                    {connected
                      ? "Kalender freigegeben"
                      : "Kalender noch nicht freigegeben"}
                  </p>
                  <p className="muted small">
                    {provider === "google"
                      ? "Die Google-Verbindung umfasst auch den Drive-Zugriff. Dein Standardspeicher wird dadurch nicht geändert."
                      : "Die Microsoft-Verbindung umfasst Kalender und OneDrive-Dateizugriff. Dein Standardspeicher wird dadurch nicht geändert."}
                  </p>
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
                      disabled={busy || !connected || !ready}
                      aria-pressed={connected&&calendar === provider}
                      onClick={() =>
                        void act(async () => {
                          await saveCalendarProvider(provider);
                          setCalendar(provider);
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
          <h2>Dein Arbeitsbereich ist bereit</h2>
          <p>
            Speicher:{" "}
            <strong>
              {storageLabel}
            </strong>
          </p>
          <p>
            Kalenderauswahl:{" "}
            <strong>
              {calendarLabel}
            </strong>{" "}
            (nur mit Freigabe nutzbar)
          </p>
          <p className="muted">
            Nicht verbundene Dienste kannst du später einrichten. Bestehende
            Meetings behalten ihren Speicherort und ihre Kalenderzuordnung.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setStep(2)}>
              Zurück
            </button>
            <button
              className="btn btn-primary"
              onClick={() => (onComplete ? onComplete() : navigate("/"))}
            >
              Einrichtung abschließen
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
