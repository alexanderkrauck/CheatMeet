import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export default function RecordingSheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  // Keep the original opener for the whole sheet session, but give each
  // replacement step its own focus. Do not replace the opener with a removed
  // options button when settings or confirmation takes its place.
  useEffect(() => {
    const previous = opener.current;
    const key = (event: KeyboardEvent) => {
      // Google Picker owns focus while its external dialog is open.
      if (!sheet.current) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement &&
          !sheet.current.contains(active)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key === "Tab") {
        const controls = Array.from(
          sheet.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ),
        ).filter((el) => el.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === sheet.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      // The parent removes inert in this same commit; restore after that.
      queueMicrotask(() => {
        if (previous?.isConnected && previous.getClientRects().length && !previous.closest("[inert]"))
          previous.focus({ preventScroll: true });
      });
    };
  }, []);
  useEffect(() => { sheet.current?.focus({ preventScroll: true }); }, [title]);
  return (
    <div
      className="walk-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="walk-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={sheet}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="walk-icon"
            aria-label="Schließen"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="walk-sheet-content">{children}</div>
      </section>
    </div>
  );
}
