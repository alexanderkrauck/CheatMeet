export type RecordingInterruption = "muted" | "ended" | "inactive";
export type RecordingWakeLockState =
  "idle" | "requesting" | "active" | "unavailable";

type LifecycleOptions = {
  recorder: MediaRecorder;
  /**
   * Tracks to watch for interruptions. When system audio is mixed in, the
   * recorder's own stream is a synthetic AudioContext destination whose track
   * never mutes or ends, so the real capture devices must be passed instead.
   */
  tracks?: MediaStreamTrack[];
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
  const tracks = options.tracks ?? recorder.stream.getAudioTracks();
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
