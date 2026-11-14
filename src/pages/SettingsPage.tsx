import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { RetentionSettings } from "../components/RetentionSettings";
import { onIdTokenChanged, signOut } from "firebase/auth";
import { LogOut, Mic, ShieldOff, UserRound } from "lucide-react";
import DriveSettings from "../components/DriveSettings";
import MicrosoftSettings from "../components/MicrosoftSettings";
import { hasAnyCalendarGrant, subscribeCalendar } from "../lib/calendar";
import McpClients from "../components/McpClients";
import MeetingLanguages from "../components/MeetingLanguages";
import Preferences from "../components/Preferences";
import StorageSettings from "../components/StorageSettings";
import { Notice } from "../components/UI";
import { auth } from "../lib/firebase";
import {
  linkMicrosoftIdentity,
  unlinkMicrosoftIdentity,
} from "../lib/microsoftIdentity";
import {
  calendarSyncEnabled,
  consentStepEnabled,
  defaultLanguages,
  ownSpeakerName,
  setCalendarSync,
  setConsentStep,
  setDefaultLanguages,
  setOwnSpeakerName,
} from "../lib/meetingDefaults";
import {
  errorMessage,
  linkGoogleIdentity,
  unlinkGoogleIdentity,
  revokeDriveGrant,
  subscribeDriveSession,
  driveToken,
} from "../lib/session";
import {
  audioSourcePreference,
  setAudioSourcePreference,
  type AudioSourcePreference,
} from "../lib/audioSources";

const SOURCES: { id: AudioSourcePreference; label: string; hint: string }[] = [
  {
    id: "mic+system",
    label: "Mikrofon + Systemaudio",
    hint: "Für Online-Meetings: nimmt auch die Gegenseite auf.",
  },
  {
    id: "mic",
    label: "Nur Mikrofon",
    hint: "Für Gespräche im Raum. Kein Bildschirm-Dialog beim Start.",
  },
];

export default function SettingsPage() {
  const user = auth.currentUser;
  const [source, setSource] = useState(audioSourcePreference);
  const [languages, setLanguages] = useState(defaultLanguages);
  const [myName, setMyName] = useState(() => ownSpeakerName(user?.displayName));
  const [calendarSync, setCalendarSyncState] = useState(calendarSyncEnabled);
  const [consentStep, setConsentStepState] = useState(consentStepEnabled);
  const calendarReady = useSyncExternalStore(
    subscribeCalendar,
    hasAnyCalendarGrant,
    () => false,
  );
  const [revoking, setRevoking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [methods, setMethods] = useState(
    () => user?.providerData.map((p) => p.providerId) || [],
  );
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const googleDriveConnected = useSyncExternalStore(
    subscribeDriveSession,
    () => Boolean(driveToken()),
    () => false,
  );
  useEffect(
    () =>
      onIdTokenChanged(auth, (current) =>
        setMethods(current?.providerData.map((p) => p.providerId) || []),
      ),
    [],
  );

  async function linkIdentity(provider: "google" | "microsoft") {
    setLinking(true);
    setError("");
    setFeedback("");
    try {
      if (provider === "google") await linkGoogleIdentity();
      else await linkMicrosoftIdentity();
      setMethods(auth.currentUser?.providerData.map((p) => p.providerId) || []);
      setFeedback(
        "Anmeldemethode verknüpft. Speicher und Kalender bleiben unverändert.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLinking(false);
    }
  }

  async function unlinkIdentity(provider: "google" | "microsoft") {
    const name = provider === "google" ? "Google" : "Microsoft";
    if (methods.length < 2) {
      setError(
        "Die letzte Anmeldemethode kann nicht entfernt werden. Verknüpfe zuerst eine weitere.",
      );
      return;
    }
    if (
      !window.confirm(
        `${name}-Anmeldung von diesem Arbeitsbereich entfernen? Eine weitere Anmeldemethode bleibt erhalten. Dateien, Meetings sowie Speicher- und Kalenderverbindungen werden nicht gelöscht.`,
      )
    )
      return;
    setLinking(true);
    setError("");
    setFeedback("");
    try {
      if (provider === "google") await unlinkGoogleIdentity();
      else await unlinkMicrosoftIdentity();
      setMethods(auth.currentUser?.providerData.map((p) => p.providerId) || []);
      setFeedback(
        `${name}-Anmeldung entfernt. Speicher- und Kalenderzugriff bleiben separat verwaltet.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLinking(false);
    }
  }

  async function revoke() {
    // Google's revoke endpoint drops the grant for this app on every device,
    // which is why signing out deliberately does not do it.
    if (
      !window.confirm(
        "Google-Zugriff für diesen Arbeitsbereich auf allen Geräten entziehen? Das betrifft Google Drive und eine vorhandene Kalenderfreigabe. Noch laufende Uploads und Verarbeitungen können anhalten. Dateien, Meetings und Anmeldemethoden bleiben erhalten. Bestehende Meetings wechseln nicht den Speicheranbieter. Fortfahren?",
      )
    )
      return;
    setRevoking(true);
    setError("");
    setFeedback("");
    try {
      await revokeDriveGrant();
      setFeedback(
        "Google-Zugriff widerrufen. Deine CheatMeet-Anmeldung bleibt erhalten; bestehende Dateien werden nicht gelöscht.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Einstellungen</h1>
          <p className="muted">Konto, Verbindungen und Aufnahme.</p>
        </div>
      </div>

      {error && <Notice>{error}</Notice>}
      {feedback && (
        <p className="notice" role="status">
          {feedback}
        </p>
      )}
      <nav className="settings-nav actions" aria-label="Einstellungsbereiche">
        {[
          ["konto", "Konto"],
          ["verbindungen", "Speicher"],
          ["kalender", "Kalender"],
          ["aufnahme", "Aufnahme"],
          ["zusammenfassung", "KI-Anweisung"],
          ["aufbewahrung", "Aufbewahrung"],
          ["assistenten", "Assistenten"],
          ["geraet", "Dieses Gerät"],
        ].map(([id, name]) => (
          <a className="btn" href={`#${id}`} key={id}>
            {name}
          </a>
        ))}
      </nav>

      <div className="settings-stack">
        <section
          id="konto"
          className="panel settings-account"
          aria-labelledby="account-title"
        >
          <div>
            <span className="eyebrow">KONTO</span>
            <h2 id="account-title">Dein Arbeitsbereich</h2>
          </div>
          <p className="account-identity">
            <span className="avatar" aria-hidden="true">
              {user?.photoURL ? (
                <img src={user.photoURL} alt="" width={40} height={40} />
              ) : (
                <UserRound size={20} />
              )}
            </span>
            <span>
              <strong>{user?.displayName || "Angemeldet"}</strong>
              <small className="muted">{user?.email}</small>
            </span>
          </p>
          <p className="muted small">
            Anmeldemethoden gehören zu diesem Arbeitsbereich. Speicher und
            Kalender werden separat freigegeben.
          </p>
          <div className="actions">
            {(["google", "microsoft"] as const).map((provider) => {
              const linked = methods.includes(`${provider}.com`);
              const name = provider === "google" ? "Google" : "Microsoft";
              return (
                <div className="identity-method" key={provider}>
                  {linked ? (
                    <>
                      <span className="badge">
                        {name} · Anmeldung verknüpft
                      </span>
                      {methods.length > 1 && (
                        <button
                          type="button"
                          className="btn"
                          disabled={linking}
                          onClick={() => void unlinkIdentity(provider)}
                          aria-label={`${name}-Anmeldung entfernen`}
                        >
                          Entfernen
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={linking}
                      onClick={() => void linkIdentity(provider)}
                    >
                      {name}-Anmeldung verknüpfen
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void signOut(auth).catch((cause) =>
                  setError(errorMessage(cause)),
                )
              }
            >
              <LogOut size={16} /> Abmelden
            </button>
          </div>
          <p className="muted small">
            {methods.length === 1
              ? "Die letzte Anmeldemethode bleibt geschützt. "
              : ""}
            Abmelden beendet nur diese Sitzung; Verbindungen bleiben erhalten.
          </p>
        </section>

        <section
          id="verbindungen"
          className="panel"
          aria-labelledby="connections-title"
        >
          <span className="eyebrow">VERBINDUNGEN</span>
          <h2 id="connections-title">Speicher und Kalender</h2>
          <p className="muted">
            Google Drive oder OneDrive für neue Meetings; Google Kalender oder
            Outlook unabhängig davon. Änderungen verschieben keine bestehenden
            Meetings.
          </p>
          <Link className="btn btn-primary" to="/setup">
            Verbindungen einrichten
          </Link>
        </section>
        <div className="connection-provider-grid">
          <div>
            <DriveSettings />
            {googleDriveConnected && (
              <button
                type="button"
                className="btn danger"
                disabled={revoking}
                onClick={() => void revoke()}
              >
                <ShieldOff size={16} />
                {revoking ? "Wird entzogen …" : "Google-Zugriff entziehen"}
              </button>
            )}
            {googleDriveConnected && (
              <p className="muted small">
                Betrifft Drive und vorhandene Kalenderfreigaben auf allen
                Geräten. Die Anmeldung bleibt erhalten; laufende Verarbeitung
                kann anhalten.
              </p>
            )}
          </div>
          <MicrosoftSettings storageOnly />
        </div>

        <McpClients />

        <RetentionSettings />

        <Preferences />

        <section
          id="aufnahme"
          className="panel"
          aria-labelledby="capture-title"
        >
          <div>
            <span className="eyebrow">AUFNAHME</span>
            <h2 id="capture-title">Standards für neue Meetings</h2>
          </div>
          <p className="muted">
            Womit eine Aufnahme startet. Pro Meeting weiterhin änderbar, und
            alles hier gilt für diesen Browser, nicht für dein Konto.
          </p>
          <label className="form-field">
            <span>Dein Name im Transkript</span>
            <input
              className="field"
              maxLength={80}
              value={myName}
              placeholder={user?.displayName || "Ich"}
              onChange={(event) => {
                setMyName(event.target.value);
                setOwnSpeakerName(event.target.value);
              }}
            />
          </label>
          <p className="muted small">
            Wird verwendet, sobald du für ein Meeting „Nur eine Person am
            Mikrofon“ aktivierst. Leer lassen übernimmt deinen Kontonamen.
          </p>
          <label className="confirm-option">
            <input
              type="checkbox"
              checked={consentStep}
              onChange={(event) => {
                setConsentStepState(event.target.checked);
                setConsentStep(event.target.checked);
              }}
            />
            <span>
              <strong>Vor der Aufnahme nach Einwilligung fragen</strong>
              <small>
                Zeigt vor jedem Start den Hinweis, den du vorliest, und hält
                fest, wann und wie alle Anwesenden informiert wurden. Ohne
                diesen Schritt startet die Aufnahme sofort — dann wird für das
                Meeting auch keine Einwilligung dokumentiert. Sinnvoll nur, wenn
                außer dir niemand aufgenommen wird.
              </small>
            </span>
          </label>
          <div
            className="choice-list"
            role="group"
            aria-label="Standard-Tonquelle"
          >
            {SOURCES.map(({ id, label, hint }) => (
              <button
                key={id}
                type="button"
                aria-pressed={source === id}
                className={source === id ? "choice active" : "choice"}
                onClick={() => {
                  setSource(id);
                  setAudioSourcePreference(id);
                }}
              >
                <Mic size={17} />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
              </button>
            ))}
          </div>
          <MeetingLanguages
            legend="Sprachen für neue Meetings"
            value={languages}
            onChange={(next) => {
              setLanguages(next);
              setDefaultLanguages(next);
            }}
          />
          <p className="muted small">
            Pro Meeting weiterhin änderbar, solange die Aufnahme nicht läuft.
          </p>
        </section>

        <section
          id="kalender"
          className="panel"
          aria-labelledby="calendar-title"
        >
          <div>
            <span className="eyebrow">KALENDER</span>
            <h2 id="calendar-title">Termine und Zusammenfassungen</h2>
          </div>
          <Link className="btn" to="/setup">
            Kalender verbinden oder auswählen
          </Link>
          {calendarReady ? (
            <>
              <p className="muted">
                Beim Aufnehmen kannst du das Meeting einem Termin zuordnen —
                dann schlägt CheatMeet die eingeladenen Personen als Sprecher
                vor.
              </p>
              <label className="confirm-option">
                <input
                  type="checkbox"
                  checked={calendarSync}
                  onChange={(event) => {
                    setCalendarSyncState(event.target.checked);
                    setCalendarSync(event.target.checked);
                  }}
                />
                <span>
                  <strong>Zusammenfassung in den Kalender schreiben</strong>
                  <small>
                    Nach der Analyse werden die Notizen eines zugeordneten
                    Termins ergänzt. Ohne Zuordnung passiert nichts — im Bericht
                    kannst du über „In den Kalender“ jederzeit einen Termin
                    anlegen. Outlook-Änderungen können Benachrichtigungen
                    auslösen; ein schreibgeschützter Termin wird nicht ersetzt.
                  </small>
                </span>
              </label>
            </>
          ) : (
            <p className="muted">
              Für dieses Konto ist der Kalender noch nicht freigegeben. Gib den
              gewünschten Anbieter in den Verbindungseinstellungen frei.
            </p>
          )}
        </section>

        <StorageSettings />
      </div>
    </>
  );
}
