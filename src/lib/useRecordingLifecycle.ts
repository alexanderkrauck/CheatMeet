import { useEffect, useRef, useState, type RefObject } from "react";

export type RecordingInterruption = "muted" | "ended" | "inactive";
export type RecordingWakeLockState =
  "idle" | "requesting" | "active" | "unavailable";

type LifecycleOptions = {
  recorder: MediaRecorder;
  document: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  onInterrupted: (reason: RecordingInterruption) => void;
  onVisibilityReturn?: () => void;
};

/** Keep lifecycle handling separate so interruptions can be exercised without a microphone. */
export function observeRecordingLifecycle(options: LifecycleOptions) {
  const { recorder, document: page, window: browser } = options;
  const tracks = recorder.stream.getAudioTracks();
  let previousInterruption: RecordingInterruption | undefined;
  const interrupt = (reason: RecordingInterruption) => {
    if (previousInterruption === reason) return;
    previousInterruption = reason;
    options.onInterrupted(reason);
  };
  const flush = () => {
    if (recorder.state === "inactive") return;
    // A browser may suspend/stop between the state check and requestData.
    try {
      recorder.requestData();
    } catch {
      /* Periodic chunks remain recoverable. */
    }
  };
  const inspect = () => {
    if (tracks.some((track) => track.readyState === "ended"))
      interrupt("ended");
    else if (recorder.state === "inactive") interrupt("inactive");
    else if (
      recorder.state === "recording" &&
      tracks.some((track) => track.muted)
    )
      interrupt("muted");
    else previousInterruption = undefined;
  };
  const onMuted = () => {
    flush();
    inspect();
  };
  const onEnded = () => {
    flush();
    interrupt("ended");
  };
  const onVisible = () => {
    if (page.visibilityState === "hidden") flush();
    else {
      inspect();
      options.onVisibilityReturn?.();
    }
  };
  for (const track of tracks) {
    track.addEventListener("mute", onMuted);
    track.addEventListener("unmute", inspect);
    track.addEventListener("ended", onEnded);
  }
  recorder.addEventListener("resume", inspect);
  page.addEventListener("visibilitychange", onVisible);
  browser.addEventListener("pagehide", flush);
  inspect();
  return () => {
    for (const track of tracks) {
      track.removeEventListener("mute", onMuted);
      track.removeEventListener("unmute", inspect);
      track.removeEventListener("ended", onEnded);
    }
    recorder.removeEventListener("resume", inspect);
    page.removeEventListener("visibilitychange", onVisible);
    browser.removeEventListener("pagehide", flush);
  };
}

/** Prevent automatic screen sleep where supported; manual locking remains under OS control. */
export function useRecordingLifecycle({
  recorderRef,
  active,
  onInterrupted,
  onVisibilityReturn,
}: {
  recorderRef: RefObject<MediaRecorder | null>;
  active: boolean;
  onInterrupted: (reason: RecordingInterruption) => void;
  onVisibilityReturn?: () => void;
}) {
  const [wakeLockState, setWakeLockState] =
    useState<RecordingWakeLockState>("idle");
  const callbacks = useRef({ onInterrupted, onVisibilityReturn });
  callbacks.current = { onInterrupted, onVisibilityReturn };
  useEffect(() => {
    if (!active) {
      setWakeLockState("idle");
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder) return;
    let disposed = false;
    let pending = false;
    let sentinel: WakeLockSentinel | null = null;
    let removeReleaseListener: (() => void) | undefined;
    const acquire = async () => {
      if (
        disposed ||
        pending ||
        (sentinel && !sentinel.released) ||
        document.visibilityState !== "visible"
      )
        return;
      if (!navigator.wakeLock) {
        setWakeLockState("unavailable");
        return;
      }
      pending = true;
      setWakeLockState("requesting");
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (disposed || document.visibilityState !== "visible") {
          await lock.release();
          return;
        }
        sentinel = lock;
        const released = () => {
          if (sentinel === lock) sentinel = null;
          if (!disposed) setWakeLockState("unavailable");
        };
        removeReleaseListener?.();
        lock.addEventListener("release", released);
        removeReleaseListener = () =>
          lock.removeEventListener("release", released);
        setWakeLockState(lock.released ? "unavailable" : "active");
      } catch {
        if (!disposed) setWakeLockState("unavailable");
      } finally {
        pending = false;
      }
    };
    const stopObserving = observeRecordingLifecycle({
      recorder,
      document,
      window,
      onInterrupted: (reason) => callbacks.current.onInterrupted(reason),
      onVisibilityReturn: () => {
        void acquire();
        callbacks.current.onVisibilityReturn?.();
      },
    });
    void acquire();
    return () => {
      disposed = true;
      stopObserving();
      removeReleaseListener?.();
      void sentinel?.release().catch(() => {});
    };
  }, [active, recorderRef]);
  return { wakeLockState };
}
