import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import "./recording-camera.css";

export default function RecordingCamera({
  onCapture,
  onClose,
  onFallback,
}: {
  onCapture: (blob: Blob) => Promise<void> | void;
  onClose: () => void;
  onFallback: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const callbacks = useRef({ onCapture, onClose, onFallback });
  callbacks.current = { onCapture, onClose, onFallback };
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let stream: MediaStream | undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error("unsupported");
        // This stream belongs exclusively to the camera. Never request or stop audio here.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
        }
      } catch {
        stream?.getTracks().forEach((track) => track.stop());
        if (!disposed)
          setError(
            "Kamera nicht verfügbar. Erlaube den Kamerazugriff oder wähle ein vorhandenes Foto.",
          );
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy.current) callbacks.current.onClose();
      }
      if (event.key === "Tab") {
        const buttons = Array.from(
          dialog.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) || [],
        );
        const first = buttons[0],
          last = buttons.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    void start();
    return () => {
      disposed = true;
      mounted.current = false;
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current) video.current.srcObject = null;
      document.removeEventListener("keydown", onKey);
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  const capture = async () => {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight || busy.current) return;
    busy.current = true;
    setCapturing(true);
    setError("");
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(
        1,
        1920 / Math.max(source.videoWidth, source.videoHeight),
      );
      canvas.width = Math.round(source.videoWidth * scale);
      canvas.height = Math.round(source.videoHeight * scale);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-unavailable");
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) =>
            result ? resolve(result) : reject(new Error("capture-failed")),
          "image/jpeg",
          0.92,
        );
      });
      if (!mounted.current) return;
      await callbacks.current.onCapture(blob);
      if (mounted.current) callbacks.current.onClose();
    } catch {
      if (mounted.current)
        setError(
          "Foto konnte nicht übernommen werden. Bitte versuche es erneut.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setCapturing(false);
    }
  };

  return (
    <section
      className="walk-camera-view"
      role="dialog"
      aria-modal="true"
      aria-label="Foto aufnehmen"
      ref={dialog}
      tabIndex={-1}
    >
      <header className="walk-camera-header">
        <div>
          <span>BEGEHUNG</span>
          <h2>Foto aufnehmen</h2>
        </div>
        <button
          type="button"
          aria-label="Kamera schließen"
          onClick={onClose}
          disabled={capturing}
        >
          <X size={24} />
        </button>
      </header>
      <div className="walk-camera-preview">
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          aria-label="Live-Kamerabild"
          onCanPlay={() => setReady(true)}
        />
        {!ready && !error && (
          <div className="walk-camera-loading" role="status">
            <Loader2 className="spin" size={28} />
            <span>Kamera wird geöffnet …</span>
          </div>
        )}
        {error && (
          <div className="walk-camera-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer className="walk-camera-controls">
        <p>Das Foto wird deiner Meeting zugeordnet.</p>
        <div>
          <button
            type="button"
            className="walk-camera-library"
            onClick={onFallback}
            disabled={capturing}
          >
            <ImagePlus size={23} />
            <span>Fotos wählen</span>
          </button>
          <button
            type="button"
            className="walk-camera-shutter"
            aria-label="Foto jetzt aufnehmen"
            onClick={() => void capture()}
            disabled={!ready || capturing}
          >
            {capturing ? (
              <Loader2 className="spin" size={28} />
            ) : (
              <Camera size={30} />
            )}
          </button>
          <span className="walk-camera-balance" aria-hidden="true" />
        </div>
      </footer>
    </section>
  );
}
