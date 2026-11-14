import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { RetentionSettings } from "../components/RetentionSettings";
import { onIdTokenChanged, signOut } from "firebase/auth";
import {
  ArrowUpRight,
  Bot,
  CalendarDays,
  HardDrive,
  Laptop,
  LogOut,
  Mic,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  UserRound,
} from "lucide-react";
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
import "./settings.css";

const SECTIONS = [
  { id: "konto", label: "Konto", icon: UserRound },
  { id: "verbindungen", label: "Speicher", icon: HardDrive },
  { id: "aufnahme", label: "Aufnahme", icon: Mic },
  { id: "kalender", label: "Kalender", icon: CalendarDays },
  { id: "aufbewahrung", label: "Aufbewahrung", icon: ShieldCheck },
  { id: "zusammenfassung", label: "KI-Anweisung", icon: Sparkles },
  { id: "assistenten", label: "Assistenten", icon: Bot },
  { id: "geraet", label: "Dieses Gerät", icon: Laptop },
];

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
  const [activeSection, setActiveSection] = useState("konto");
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
  useEffect(() => {
    const readHash = () => {
      const id = window.location.hash.slice(1);
      if (SECTIONS.some((section) => section.id === id)) setActiveSection(id);
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    const visibleSections = new Set<string>();
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (entry.isIntersecting) visibleSections.add(entry.target.id);
                else visibleSections.delete(entry.target.id);
              }
              const firstVisible = SECTIONS.find(({ id }) =>
                visibleSections.has(id),
              );
              if (firstVisible) setActiveSection(firstVisible.id);
            },
            {
              rootMargin: `-90px 0px -${Math.round(window.innerHeight * 0.6)}px 0px`,
            },
          );
    for (const { id } of SECTIONS) {
      const section = document.getElementById(id);
      if (section) observer?.observe(section);
    }
    return () => {
      window.removeEventListener("hashchange", readHash);
      observer?.disconnect();
    };
  }, []);

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
    <div className="settings-page">
      <div className="page-head settings-page-heading">
        <div>
          <h1>Einstellungen</h1>
          <p className="muted">Dein Arbeitsbereich. Deine Standards.</p>
        </div>
        <span className="settings-scope">
          <Settings2 size={14} aria-hidden="true" /> Konto & Geräteeinstellungen
        </span>
      </div>
      {error && <Notice>{error}</Notice>}
      {feedback && (
        <p className="notice" role="status">
          {feedback}
        </p>
      )}

      <div className="settings-workspace">
        <nav className="settings-section-nav" aria-label="Einstellungsbereiche">
          <span className="settings-nav-caption">Arbeitsbereich verwalten</span>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <a
              className="settings-section-link"
              href={`#${id}`}
              key={id}
              aria-current={activeSection === id ? "location" : undefined}
              onClick={() => setActiveSection(id)}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </a>
          ))}
          <p className="settings-nav-note">
            Anmeldung, Speicher und Kalender sind unabhängig voneinander.
          </p>
        </nav>

        <div className="settings-content">
          <section
            id="konto"
            className="panel settings-account"
            aria-labelledby="account-title"
          >
            <div className="settings-section-heading">
              <div>
                <h2 id="account-title">Dein Arbeitsbereich</h2>
                <p>
                  Anmeldemethoden gehören zu diesem Arbeitsbereich. Speicher und
                  Kalender werden separat freigegeben.
                </p>
              </div>
            </div>
            <div className="settings-account-top">
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
            </div>
            <div className="settings-identity-methods">
              {(["google", "microsoft"] as const).map((provider) => {
                const linked = methods.includes(`${provider}.com`);
                const name = provider === "google" ? "Google" : "Microsoft";
                return (
                  <div className="settings-identity-method" key={provider}>
                    <div>
                      <strong>{name}</strong>
                      <small>
                        {linked
                          ? "Anmeldung verknüpft"
                          : "Nicht als Anmeldung verknüpft"}
                      </small>
                    </div>
                    {linked ? (
                      methods.length > 1 && (
                        <button
                          type="button"
                          className="btn settings-quiet-button"
                          disabled={linking}
                          onClick={() => void unlinkIdentity(provider)}
                          aria-label={`${name}-Anmeldung entfernen`}
                        >
                          Entfernen
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        className="btn settings-quiet-button"
                        disabled={linking}
                        aria-label={`${name}-Anmeldung verknüpfen`}
                        onClick={() => void linkIdentity(provider)}
                      >
                        Verknüpfen
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="settings-session-row">
              <p>
                {methods.length === 1
                  ? "Die letzte Anmeldemethode bleibt geschützt. "
                  : ""}
                Abmelden beendet nur diese Sitzung; Verbindungen bleiben
                erhalten.
              </p>
              <button
                type="button"
                className="btn settings-quiet-button"
                onClick={() =>
                  void signOut(auth).catch((cause) =>
                    setError(errorMessage(cause)),
                  )
                }
              >
                <LogOut size={16} aria-hidden="true" /> Abmelden
              </button>
            </div>
          </section>

          <section
            id="verbindungen"
            className="settings-connections"
            aria-labelledby="connections-title"
          >
            <div className="settings-section-heading">
              <div>
                <h2 id="connections-title">Speicher für deine Meetings</h2>
                <p>
                  Google Drive oder OneDrive für neue Meetings. Bestehende
                  Meetings behalten ihren Speicherort; der Kalender bleibt
                  unabhängig davon.
                </p>
              </div>
              <Link className="btn settings-quiet-button" to="/setup">
                Verbindungen einrichten{" "}
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            </div>
            <div className="settings-provider-grid">
              <DriveSettings>
                {googleDriveConnected && (
                  <div className="provider-operation provider-danger-operation">
                    <div>
                      <strong>Google-Zugriff verwalten</strong>
                      <p>
                        Betrifft Drive und vorhandene Kalenderfreigaben auf
                        allen Geräten. Die Anmeldung bleibt erhalten; laufende
                        Verarbeitung kann anhalten.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn danger provider-quiet-button"
                      disabled={revoking}
                      onClick={() => void revoke()}
                    >
                      <ShieldOff size={16} aria-hidden="true" />
                      {revoking
                        ? "Wird entzogen …"
                        : "Google-Zugriff entziehen"}
                    </button>
                  </div>
                )}
              </DriveSettings>
              <MicrosoftSettings storageOnly />
            </div>
          </section>

          <section
            id="aufnahme"
            className="panel settings-capture"
            aria-labelledby="capture-title"
          >
            <h2 id="capture-title">Standards für neue Meetings</h2>
            <p className="muted">
              Womit eine Aufnahme startet. Pro Meeting weiterhin änderbar, und
              alles hier gilt für diesen Browser, nicht für dein Konto.
            </p>
            <div className="settings-capture-grid">
              <div>
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
              </div>
              <div>
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
                      <Mic size={17} aria-hidden="true" />
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
                  Pro Meeting weiterhin änderbar, solange die Aufnahme nicht
                  läuft.
                </p>
              </div>
            </div>
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
                  Meeting auch keine Einwilligung dokumentiert. Sinnvoll nur,
                  wenn außer dir niemand aufgenommen wird.
                </small>
              </span>
            </label>
          </section>

          <section
            id="kalender"
            className="panel"
            aria-labelledby="calendar-title"
          >
            <h2 id="calendar-title">Termine und Zusammenfassungen</h2>
            <Link className="btn settings-quiet-button" to="/setup">
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
                      Termins ergänzt. Ohne Zuordnung passiert nichts — im
                      Bericht kannst du über „In den Kalender“ jederzeit einen
                      Termin anlegen. Outlook-Änderungen können
                      Benachrichtigungen auslösen; ein schreibgeschützter Termin
                      wird nicht ersetzt.
                    </small>
                  </span>
                </label>
              </>
            ) : (
              <p className="muted">
                Für dieses Konto ist der Kalender noch nicht freigegeben. Gib
                den gewünschten Anbieter in den Verbindungseinstellungen frei.
              </p>
            )}
          </section>
          <RetentionSettings />
          <Preferences />
          <McpClients />
          <StorageSettings />
        </div>
      </div>
    </div>
  );
}
