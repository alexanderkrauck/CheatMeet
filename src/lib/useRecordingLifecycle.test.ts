import { describe, expect, it, vi } from "vitest";
import { observeRecordingLifecycle } from "./useRecordingLifecycle";

function fixture() {
  const track = Object.assign(new EventTarget(), {
    muted: false,
    readyState: "live",
  });
  const recorder = Object.assign(new EventTarget(), {
    state: "recording",
    requestData: vi.fn(),
    stream: { getAudioTracks: () => [track] },
  });
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const browser = new EventTarget();
  const onInterrupted = vi.fn();
  const onVisibilityReturn = vi.fn();
  const dispose = observeRecordingLifecycle({
    recorder: recorder as unknown as MediaRecorder,
    document: page as unknown as Document,
    window: browser as unknown as Window,
    onInterrupted,
    onVisibilityReturn,
  });
  return {
    track,
    recorder,
    page,
    browser,
    onInterrupted,
    onVisibilityReturn,
    dispose,
  };
}

describe("mobile recording lifecycle", () => {
  it("flushes media before backgrounding and leaving, including during a pause", () => {
    const f = fixture();
    f.page.visibilityState = "hidden";
    f.page.dispatchEvent(new Event("visibilitychange"));
    f.recorder.state = "paused";
    f.browser.dispatchEvent(new Event("pagehide"));
    expect(f.recorder.requestData).toHaveBeenCalledTimes(2);
    f.recorder.state = "inactive";
    f.browser.dispatchEvent(new Event("pagehide"));
    expect(f.recorder.requestData).toHaveBeenCalledTimes(2);
    f.dispose();
  });

  it("reports a muted microphone immediately, without repeatedly interrupting on return", () => {
    const f = fixture();
    f.track.muted = true;
    f.track.dispatchEvent(new Event("mute"));
    expect(f.recorder.requestData).toHaveBeenCalledOnce();
    expect(f.onInterrupted).toHaveBeenCalledWith("muted");
    f.page.dispatchEvent(new Event("visibilitychange"));
    expect(f.onInterrupted).toHaveBeenCalledOnce();
    expect(f.onVisibilityReturn).toHaveBeenCalledOnce();
    f.track.muted = false;
    f.track.dispatchEvent(new Event("unmute"));
    f.track.muted = true;
    f.track.dispatchEvent(new Event("mute"));
    expect(f.onInterrupted).toHaveBeenCalledTimes(2);
    f.dispose();
  });

  it("detects a stopped recorder or lost microphone when returning from suspension", () => {
    const f = fixture();
    f.recorder.state = "inactive";
    f.page.dispatchEvent(new Event("visibilitychange"));
    expect(f.onInterrupted).toHaveBeenLastCalledWith("inactive");
    f.track.readyState = "ended";
    f.page.dispatchEvent(new Event("visibilitychange"));
    expect(f.onInterrupted).toHaveBeenLastCalledWith("ended");
    f.dispose();
  });

  it("tolerates requestData races and removes all listeners after cleanup", () => {
    const f = fixture();
    f.recorder.requestData.mockImplementation(() => {
      throw new Error("Already stopped");
    });
    expect(() => f.browser.dispatchEvent(new Event("pagehide"))).not.toThrow();
    f.dispose();
    f.track.readyState = "ended";
    f.track.dispatchEvent(new Event("ended"));
    f.browser.dispatchEvent(new Event("pagehide"));
    f.page.dispatchEvent(new Event("visibilitychange"));
    expect(f.onInterrupted).not.toHaveBeenCalled();
    expect(f.onVisibilityReturn).not.toHaveBeenCalled();
    expect(f.recorder.requestData).toHaveBeenCalledOnce();
  });
});
