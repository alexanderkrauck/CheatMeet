import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines, RefreshCw } from "lucide-react";
import { getServerRetranscription, type RetranscriptionEligibility } from "../lib/serverProcessing";
import { errorMessage } from "../lib/session";
import type { ReportData } from "../types";

/** Confirmation only. The report's existing owner-pinned pipeline owns execution. */
export default function RetranscriptionDialog({
  title,
  report,
  onClose,
  onConfirm,
}: {
  title: string;
  report: ReportData;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const committing = useRef(false);
  const close = useRef(onClose);
  const [eligibility, setEligibility] = useState<RetranscriptionEligibility>();
  const [attempt, setAttempt] = useState(0);
  close.current = onClose;
  useEffect(() => {
    let active = true;
    setEligibility(undefined);
    void getServerRetranscription(report).then(result => {
      if (active) setEligibility(result);
    }).catch(cause => {
      if (active) setEligibility({state:"unavailable",message:errorMessage(cause)});
    });
    return () => { active = false; };
  }, [report, attempt]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    const done = () => close.current();
    element.addEventListener("close", done);
    return () => element.removeEventListener("close", done);
  }, []);

  return createPortal(
    <dialog
      className="confirm retranscription-confirm"
      ref={dialog}
      aria-labelledby="retranscription-title"
      aria-describedby="retranscription-cost"
      onCancel={(event) => { if (committing.current) event.preventDefault(); }}
    >
      <span className="confirmation-icon" aria-hidden="true"><AudioLines size={23} /></span>
      <h2 id="retranscription-title">Die ganze Aufnahme neu transkribieren?</h2>
      <p className="muted confirmation-meeting">{title || "Unbenanntes Meeting"}</p>
      <p id="retranscription-cost">Ein zusätzlicher, kostenpflichtiger AssemblyAI-Durchlauf verarbeitet die gesamte Originalaufnahme — nicht nur den bisherigen Text.</p>
      <ul className="confirmation-facts">
        <li>Das neue Transkript ersetzt nach Erfolg den bisherigen Text. Eindeutige Sprechernamen werden übernommen; unklare Zuordnungen kannst du prüfen.</li>
        <li>Zusammenfassung, Aufgaben und Erkenntnisse werden anschließend neu erstellt. Manuelle Änderungen daran werden ersetzt.</li>
        <li>Deine bisherige Fassung wird nicht vorab geleert. Pro Meeting ist nur eine zusätzliche Volltranskription vorgesehen.</li>
      </ul>
      <p className="confirmation-eligibility" role="status">
        {eligibility?.message || "Verfügbarkeit des einmaligen Durchlaufs wird geprüft …"}
      </p>
      {eligibility && eligibility.state !== "available" && (
        <button type="button" className="btn btn-ghost" onClick={() => setAttempt(value => value + 1)}>Erneut prüfen</button>
      )}
      <div className="confirm-actions">
        <button type="button" className="btn" autoFocus onClick={() => dialog.current?.close()}>Abbrechen</button>
        <button type="button" className="btn btn-primary" disabled={eligibility?.state !== "available"} onClick={async () => {
          if (committing.current || eligibility?.state !== "available") return;
          committing.current = true;
          try { await onConfirm(); }
          catch (cause) { setEligibility({state:"unavailable",message:errorMessage(cause)}); }
          finally { committing.current = false; }
        }}><RefreshCw size={15} /> Kostenpflichtig starten</button>
      </div>
    </dialog>,
    document.body,
  );
}
