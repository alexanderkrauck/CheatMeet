import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { deleteReport, type DeleteOutcome } from "../lib/deleteReport";
import { errorMessage } from "../lib/session";
import { auth } from "../lib/firebase";
import { getLocal } from "../lib/local";
import { sameReportHome } from "../lib/reportProjection";
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
  home,
  onDeleted,
  onOpenChange,
  onWarning,
}: {
  id: string;
  title: string;
  driveFolderId?: string;
  home?:ReportData["home"];
  onDeleted?: (outcome: DeleteOutcome) => void;
  onOpenChange?: (open: boolean) => void;
  /** Survives this component being unmounted by the delete it just performed. */
  onWarning?: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [fromDrive, setFromDrive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const close = () => {
      onOpenChange?.(false);
      const opener = returnFocus.current;
      const target = opener?.isConnected && opener.getClientRects().length && !opener.closest("[inert]")
        ? opener : document.querySelector<HTMLElement>("main h1, h1");
      if (target) {
        if (!target.hasAttribute("tabindex") && target.tagName !== "SUMMARY" && target.tagName !== "BUTTON") target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    };
    node.addEventListener("close", close);
    return () => node.removeEventListener("close", close);
  }, [onOpenChange]);

  async function confirm() {
    if (pending.current) return;
    const owner = auth.currentUser?.uid;
    if (!owner) { setError("Bitte zuerst anmelden."); return; }
    pending.current = true;
    setBusy(true);
    setError("");
    // These writes cannot be cancelled; keep their bounded operation locked.
    try {
      const pinned = { id, title, driveFolderId, home: home && { ...home } } as ReportData;
      const stored = await getLocal(owner, id, { index: home ? "meetings" : "reports" });
      if (auth.currentUser?.uid !== owner) return;
      if (stored && !sameReportHome(stored.report, pinned))
        throw new Error("Der gespeicherte Bericht gehört zu einem anderen Archiv oder Speicherort. Es wurde nichts gelöscht.");
      // The folder id comes from the row, not only from the local copy: a
      // report restored on another device may not be in this IndexedDB.
      const report = stored ? {
        ...stored.report,
        ...(pinned.home
          ? { home: { ...stored.report.home!, ...pinned.home } }
          : { driveFolderId: pinned.driveFolderId ?? stored.report.driveFolderId }),
      } : pinned;
      const outcome = await deleteReport(owner, report, { fromDrive });
      if (auth.currentUser?.uid !== owner) return;
      const { removed, warnings } = outcome;
      if (!removed) {
        // Nothing was removed; the dialog is still mounted and can be retried.
        setError(warnings.join(" "));
        return;
      }
      // Removed locally, so this dialog is about to be unmounted with its row —
      // any warning has to reach the page instead.
      if (warnings.length) onWarning?.(warnings.join(" "));
      dialog.current?.close();
      onDeleted?.(outcome);
    } catch (cause) {
      if (auth.currentUser?.uid !== owner) return;
      setError(errorMessage(cause));
      onWarning?.(errorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={(event) => {
          if (pending.current) return;
          returnFocus.current = event.currentTarget.closest("details")?.querySelector<HTMLElement>("summary") || event.currentTarget;
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
          className="confirm is-danger"
          ref={dialog}
          aria-labelledby={`del-${id}`}
          onCancel={(event) => { if (pending.current) event.preventDefault(); }}
        >
          <h2 id={`del-${id}`}>„{title || "Unbenanntes Meeting"}“ löschen?</h2>
          <p className="muted">
            Der Bericht wird von diesem Gerät und aus der Cloud-Übersicht
            entfernt.
            {!(home?.folderId || driveFolderId) &&
              " Diese Aufnahme ist noch nirgends gesichert — auch die Audiodatei ist danach weg."}
          </p>
          {(home?.folderId || driveFolderId) && (
            <label className="confirm-option">
              <input
                type="checkbox"
                checked={fromDrive}
                disabled={busy}
                onChange={(event) => setFromDrive(event.target.checked)}
              />
              <span>
                <strong>Auch aus {home ? "OneDrive":"Google Drive"} löschen</strong>
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
          {busy && <p role="status">Löschen läuft. Bitte warten; begonnene Löschschritte können nicht abgebrochen werden.</p>}
          <div className="confirm-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => { if (!pending.current) dialog.current?.close(); }}
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
