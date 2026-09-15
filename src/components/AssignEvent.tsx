import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import CalendarMatch from "./CalendarMatch";
import { assignReportToEvent } from "../lib/assignEvent";
import { uid } from "../lib/reports";
import { errorMessage } from "../lib/session";
import { timeLabel } from "../lib/upcoming";
import type { CalendarEvent } from "../lib/calendar";
import type { ReportSummary } from "../lib/meetingMeta";

/**
 * Connects a finished recording to the calendar entry it was held for, and
 * offers to put its summary into that entry's notes.
 *
 * Two ways in, one dialog: dropping a meeting onto an event arrives with the
 * target already decided, while the row menu arrives with nothing and picks
 * from the events around the recording's own time. Drag is a shortcut, never
 * the only route — it is unavailable by keyboard and on touch.
 */
export default function AssignEvent({
  report,
  event,
  onClose,
  onWarning,
}: {
  report: ReportSummary;
  /** Preselected by a drop. Undefined opens the picker instead. */
  event?: CalendarEvent;
  onClose: () => void;
  /** Outlives this dialog, which closes on a partial success. */
  onWarning?: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<CalendarEvent | null>(event ?? null);
  const [writeBack, setWriteBack] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    node.addEventListener("close", onClose);
    return () => node.removeEventListener("close", onClose);
  }, [onClose]);

  async function confirm() {
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      const { assigned, warnings } = await assignReportToEvent(
        uid(),
        report.id,
        picked,
        { writeBack },
      );
      if (!assigned) {
        // Nothing was written; the dialog stays open and can be retried.
        setError(warnings.join(" "));
        return;
      }
      // Assigned, but the calendar may still have refused the notes. The link
      // is real either way, so the dialog closes and the page carries the news.
      if (warnings.length) onWarning?.(warnings.join(" "));
      dialog.current?.close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const relinking = report.calendarEventId && report.calendarEventId !== picked?.id;

  return createPortal(
    <dialog className="confirm" ref={dialog} aria-labelledby={`assign-${report.id}`}>
      <h2 id={`assign-${report.id}`}>Termin zuordnen</h2>
      <p className="muted">
        „{report.title || "Unbenanntes Meeting"}“
        {picked ? ` wird dem Termin „${picked.title}“ zugeordnet.` : " gehört zu welchem Termin?"}
      </p>

      {/* A drop already decided the target; the menu route keeps choosing. */}
      {event ? (
        <p className="assign-target">
          <strong>{event.title}</strong>
          <small>
            {timeLabel(event)}
            {event.attendees.length ? ` · ${event.attendees.join(", ")}` : ""}
          </small>
        </p>
      ) : (
        <CalendarMatch
          atMs={Date.parse(report.date) || Date.now()}
          selectedId={picked?.id}
          onPick={setPicked}
        />
      )}

      <label className="confirm-option">
        <input
          type="checkbox"
          checked={writeBack}
          onChange={(e) => setWriteBack(e.target.checked)}
        />
        <span>
          <strong>Zusammenfassung in die Terminnotizen schreiben</strong>
          <small>
            Ergänzt die Notizen des Termins um Zusammenfassung, To-Dos und den
            Drive-Link. Bestehender Text bleibt erhalten.
          </small>
        </span>
      </label>

      {relinking && (
        <p className="muted small">
          Dieses Meeting war bereits einem anderen Termin zugeordnet. Dessen
          Notizen bleiben unverändert.
        </p>
      )}

      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}

      <div className="confirm-actions">
        <button type="button" className="btn" onClick={() => dialog.current?.close()}>
          Abbrechen
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !picked}
          onClick={() => void confirm()}
        >
          {busy ? "Wird zugeordnet …" : "Zuordnen"}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
