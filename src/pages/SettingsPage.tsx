import { useState, useSyncExternalStore } from "react";
import { RetentionSettings } from "../components/RetentionSettings";
import { signOut } from "firebase/auth";
import { LogOut, Mic, ShieldOff, UserRound } from "lucide-react";
import DriveSettings from "../components/DriveSettings";
import MeetingLanguages from "../components/MeetingLanguages";
import Preferences from "../components/Preferences";
import StorageSettings from "../components/StorageSettings";
import { Notice } from "../components/UI";
import { auth } from "../lib/firebase";
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
import { errorMessage, hasCalendarGrant, revokeDriveGrant, subscribeDriveSession } from "../lib/session";
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
    subscribeDriveSession,
    hasCalendarGrant,
    () => false,
  );
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState("");

  async function revoke() {
    // Google's revoke endpoint drops the grant for this app on every device,
    // which is why signing out deliberately does not do it.
    if (
      !window.confirm(
        "Der Zugriff auf Google Drive wird auf allen deinen Geräten entzogen. Bereits gespeicherte Dateien bleiben in Drive. Fortfahren?",
      )
    )
      return;
    setRevoking(true);
    setError("");
    try {
      await revokeDriveGrant();
      await signOut(auth);
    } catch (cause) {
      setError(errorMessage(cause));
      setRevoking(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Einstellungen</h1>
          <p className="muted">Speicherort, Analyse und Aufnahme.</p>
        </div>
      </div>

      {error && <Notice>{error}</Notice>}

      <div className="settings-stack">
        <section className="panel" aria-labelledby="account-title">
          <div>
            <span className="eyebrow">KONTO</span>
            <h2 id="account-title">Angemeldet mit Google</h2>
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
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => void signOut(auth).catch(() => {})}
            >
              <LogOut size={16} /> Abmelden
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={revoking}
              onClick={() => void revoke()}
            >
              <ShieldOff size={16} />
              {revoking ? "Wird entzogen …" : "Drive-Zugriff entziehen"}
            </button>
          </div>
          <p className="muted small">
            Abmelden beendet nur diese Sitzung. „Drive-Zugriff entziehen“ gilt
            für alle Geräte und meldet dich ab.
          </p>
        </section>

        <DriveSettings />

        <RetentionSettings />

        <Preferences />

        <section className="panel" aria-labelledby="capture-title">
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
            Mikrofon“ aktivierst. Leer lassen übernimmt den Google-Namen.
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
                Meeting auch keine Einwilligung dokumentiert. Sinnvoll nur,
                wenn außer dir niemand aufgenommen wird.
              </small>
            </span>
          </label>
          <div className="choice-list" role="group" aria-label="Standard-Tonquelle">
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

        <section className="panel" aria-labelledby="calendar-title">
          <div>
            <span className="eyebrow">GOOGLE KALENDER</span>
            <h2 id="calendar-title">Termine und Zusammenfassungen</h2>
          </div>
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
                    anlegen.
                  </small>
                </span>
              </label>
            </>
          ) : (
            <p className="muted">
              Für dieses Konto ist der Kalender noch nicht freigegeben. Melde
              dich ab und erneut an — Google fragt dann nach dem Kalenderzugriff.
            </p>
          )}
        </section>

        <StorageSettings />
      </div>
    </>
  );
}
