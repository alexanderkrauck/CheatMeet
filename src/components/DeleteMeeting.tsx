import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { deleteReport } from "../lib/deleteReport";
import { errorMessage } from "../lib/session";
import { uid } from "../lib/reports";
import { getLocal } from "../lib/local";
import type { ReportData } from "../types";

/**
 * Deleting a meeting means three stores, one of which holds the only copy of
 * the audio — so the Drive files are a deliberate, separate choice rather than
 * something that happens quietly alongside removing the entry.
 */
export default function DeleteMeeting({
  id,
  title,
  driveFolderId,
  onDeleted,
  onOpenChange,
  onWarning,
}: {
  id: string;
  title: string;
  driveFolderId?: string;
  onDeleted?: () => void;
  onOpenChange?: (open: boolean) => void;
  /** Survives this component being unmounted by the delete it just performed. */
  onWarning?: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fromDrive, setFromDrive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const close = () => {
      setBusy(false);
      onOpenChange?.(false);
    };
    node.addEventListener("close", close);
    return () => node.removeEventListener("close", close);
  }, [onOpenChange]);

  async function confirm() {
    const owner = uid();
    setBusy(true);
    setError("");
    // Whatever happens, the dialog must not lock the user in.
    try {
      const stored = await getLocal(owner, id);
      // The folder id comes from the row, not only from the local copy: a
      // report restored on another device may not be in this IndexedDB.
      const report =
        stored?.report ?? ({ id, title, driveFolderId } as ReportData);
      const { removed, warnings } = await deleteReport(owner, report, { fromDrive });
      if (!removed) {
        // Nothing was removed; the dialog is still mounted and can be retried.
        setError(warnings.join(" "));
        return;
      }
      // Removed locally, so this dialog is about to be unmounted with its row —
      // any warning has to reach the page instead.
      if (warnings.length) onWarning?.(warnings.join(" "));
      dialog.current?.close();
      onDeleted?.();
    } catch (cause) {
      setError(errorMessage(cause));
      onWarning?.(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="danger"
        onClick={() => {
          setError("");
          setFromDrive(false);
          onOpenChange?.(true);
          dialog.current?.showModal();
        }}
      >
        <Trash2 size={16} /> Meeting löschen
      </button>
      {/* Portalled: the trigger lives inside a <details> menu, and a dialog
          under a collapsed one is display:none and never opens. */}
      {createPortal(
        <dialog
          className="confirm"
          ref={dialog}
          aria-labelledby={`del-${id}`}
        >
          <h2 id={`del-${id}`}>„{title || "Unbenanntes Meeting"}“ löschen?</h2>
          <p className="muted">
            Der Bericht wird von diesem Gerät und aus der Cloud-Übersicht
            entfernt.
            {!driveFolderId &&
              " Diese Aufnahme ist noch nirgends gesichert — auch die Audiodatei ist danach weg."}
          </p>
          {driveFolderId && (
            <label className="confirm-option">
              <input
                type="checkbox"
                checked={fromDrive}
                onChange={(event) => setFromDrive(event.target.checked)}
              />
              <span>
                <strong>Auch aus Google Drive löschen</strong>
                <small>
                  Verschiebt Aufnahme, Transkript und Bericht in den
                  Drive-Papierkorb. Ohne dieses Häkchen bleiben die Dateien dort.
                </small>
              </span>
            </label>
          )}
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <div className="confirm-actions">
            {/* Never disabled: an in-flight delete is resumable by design, and
                a dialog with no exit is worse than a re-run. */}
            <button
              type="button"
              className="btn"
              onClick={() => dialog.current?.close()}
            >
              Abbrechen
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? "Löschen …" : "Endgültig löschen"}
            </button>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
