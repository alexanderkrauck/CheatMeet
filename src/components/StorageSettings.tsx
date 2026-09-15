import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Download, HardDrive, RefreshCw, Trash2 } from "lucide-react";
import {
  applyUpdate,
  installState,
  runInstall,
  subscribeInstall,
} from "../lib/install";
import { inspectStorage, releaseSyncedAudio, type StorageReport } from "../lib/local";
import { plural } from "../lib/meetingMeta";
import { uid } from "../lib/reports";
import { errorMessage } from "../lib/session";

const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${Math.round(bytes / 1024 ** 2)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * What this browser is holding, and the one safe way to reduce it. Reports
 * already in Drive can be dropped and restored; unfinished recordings hold the
 * only copy of their audio, so they are reported and never touched.
 */
export default function StorageSettings() {
  const [info, setInfo] = useState<StorageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // Subscribed, not sampled: without this the install button stays on screen
  // and dead after the prompt has been consumed.
  const install = useSyncExternalStore(
    subscribeInstall,
    installState,
    installState,
  );

  const load = useCallback(() => {
    inspectStorage(uid())
      .then(setInfo)
      .catch((cause) => setMessage(errorMessage(cause)));
  }, []);
  useEffect(load, [load]);

  async function release() {
    setBusy(true);
    setMessage("");
    try {
      const count = await releaseSyncedAudio(uid());
      setMessage(
        count
          ? `${plural(count, "Aufnahme", "Aufnahmen")} freigegeben. Die Audiodateien liegen weiterhin in Drive.`
          : "Nichts freizugeben — alle Audiodaten werden hier noch gebraucht.",
      );
      load();
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="storage-title">
      <div>
        <span className="eyebrow">DIESES GERÄT</span>
        <h2 id="storage-title">Lokaler Speicher</h2>
      </div>
      <p className="muted">
        CheatMeet hält Berichte offline vor. Den Platz brauchen vor allem die
        Audiodaten, die hier liegen, bis sie in Drive gesichert sind.
      </p>
      <p className="storage-figures">
        <HardDrive size={18} aria-hidden="true" />
        <span>
          <strong>
            {info?.usageBytes !== undefined
              ? size(info.usageBytes)
              : "Größe unbekannt"}
          </strong>
          {info && (
            <small>
              {plural(info.reports, "Bericht", "Berichte")} ·{" "}
              {plural(info.drafts, "Aufnahme", "Aufnahmen")} auf diesem Gerät
            </small>
          )}
        </span>
      </p>
      <button
        type="button"
        className="btn"
        disabled={busy || !info?.releasable}
        onClick={() => void release()}
      >
        <Trash2 size={16} />
        {info?.releasable
          ? `Audio von ${plural(info.releasable, "gesicherter Aufnahme", "gesicherten Aufnahmen")} freigeben`
          : "Nichts freizugeben"}
      </button>
      <p className="muted small">
        Aufnahmen, die noch nicht in Drive sind, bleiben unangetastet — ihre
        Audiodaten liegen nur hier.
      </p>
      {(install.update || install.prompt || install.ios) && (
        <div className="app-install">
          <span className="eyebrow">APP</span>
          {install.update ? (
            <button type="button" className="btn btn-primary" onClick={applyUpdate}>
              <RefreshCw size={16} /> Neue Version laden
            </button>
          ) : install.prompt ? (
            <button
              type="button"
              className="btn"
              onClick={() => void runInstall()}
            >
              <Download size={16} /> Als App installieren
            </button>
          ) : (
            <p className="muted small">
              Als App installieren: in Safari über Teilen → Zum Home-Bildschirm.
            </p>
          )}
        </div>
      )}
      {message && (
        <p className="muted small" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
