import { beforeEach, describe, expect, it, vi } from "vitest";

const work = vi.hoisted(() => ({ release: true, capture: { state: "ready", busy: "", saved: true }, jobs: [] as { serverOwned?: boolean }[] }));
vi.mock("./capture", () => ({ captureSnapshot: () => work.capture, canReleaseCapture: () => work.release }));
vi.mock("./pipeline", () => ({ activeJobs: () => work.jobs }));

const listeners = new Map<string, ((e: unknown) => void)[]>();
const fire = (type: string, event: Record<string, unknown> = {}) =>
  (listeners.get(type) || []).forEach((fn) => fn({ preventDefault() {}, ...event }));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  work.capture = { state: "ready", busy: "", saved: true };
  work.release = true;
  work.jobs = [];
  listeners.clear();
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: unknown) => void) =>
      listeners.set(type, [...(listeners.get(type) || []), fn]),
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh)" });
});

describe("install state", () => {
  it("defers an activated update until newly started capture and browser work are durable", async () => {
    const postMessage = vi.fn(), reload = vi.fn();
    let controllerChanged = () => {};
    vi.stubEnv("PROD", true);
    vi.stubGlobal("window", { addEventListener: vi.fn(), matchMedia: () => ({ matches: false }), location: { reload } });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0", serviceWorker: {
      register: async () => ({ waiting: { postMessage }, addEventListener: vi.fn() }),
      addEventListener: (_type: string, callback: () => void) => { controllerChanged = callback; },
    } });
    const { startInstallWatch, applyUpdate } = await import("./install");
    startInstallWatch();
    await Promise.resolve();
    applyUpdate();
    expect(postMessage).toHaveBeenCalledTimes(1);
    work.release = false;
    controllerChanged();
    expect(reload).not.toHaveBeenCalled();
    work.release = true;
    work.jobs = [{ serverOwned: false }];
    applyUpdate();
    expect(reload).not.toHaveBeenCalled();
    work.jobs = [{ serverOwned: true }];
    applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
  it("blocks reload when private capture state is unsafe despite an empty public snapshot", async () => {
    const { canApplyUpdate } = await import("./install");
    work.release = false;
    expect(work.capture.state).toBe("ready");
    expect(canApplyUpdate()).toBe(false);
    work.release = true;
    expect(canApplyUpdate()).toBe(true);
  });
  it("does not reload a recording or browser upload, but allows an acknowledged server job", async () => {
    const postMessage = vi.fn();
    vi.stubEnv("PROD", true);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0", serviceWorker: {
      register: async () => ({ waiting: { postMessage }, addEventListener: vi.fn() }),
      addEventListener: vi.fn(),
    } });
    const { startInstallWatch, applyUpdate } = await import("./install");
    startInstallWatch();
    await Promise.resolve();
    work.capture.state = "recording";
    work.release = false;
    applyUpdate();
    expect(postMessage).not.toHaveBeenCalled();
    work.capture.state = "ready";
    work.release = true;
    work.jobs = [{ serverOwned: false }];
    applyUpdate();
    expect(postMessage).not.toHaveBeenCalled();
    work.jobs = [{ serverOwned: true }];
    applyUpdate();
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });
  it("captures the install prompt and notifies subscribers", async () => {
    const { startInstallWatch, installState, subscribeInstall } = await import("./install");
    const seen = vi.fn();
    subscribeInstall(seen);
    startInstallWatch();
    expect(installState().prompt).toBe(null);

    fire("beforeinstallprompt", { prompt: async () => {}, userChoice: Promise.resolve({}) });
    expect(installState().prompt).not.toBe(null);
    expect(seen).toHaveBeenCalled();
  });

  it("registers its listeners only once, however often it is called", async () => {
    const { startInstallWatch } = await import("./install");
    startInstallWatch();
    startInstallWatch();
    startInstallWatch();
    expect(listeners.get("beforeinstallprompt")).toHaveLength(1);
  });

  it("clears the prompt once the app is installed", async () => {
    const { startInstallWatch, installState } = await import("./install");
    startInstallWatch();
    fire("beforeinstallprompt", { prompt: async () => {}, userChoice: Promise.resolve({}) });
    fire("appinstalled");
    expect(installState().prompt).toBe(null);
    expect(installState().ios).toBe(false);
  });

  it("consumes the prompt exactly once, so the button cannot be clicked twice", async () => {
    const { startInstallWatch, installState, runInstall } = await import("./install");
    startInstallWatch();
    const prompt = vi.fn().mockResolvedValue(undefined);
    fire("beforeinstallprompt", { prompt, userChoice: Promise.resolve({ outcome: "accepted" }) });

    await runInstall();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(installState().prompt).toBe(null);
    await runInstall();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("clears the prompt even when the browser rejects it", async () => {
    const { startInstallWatch, installState, runInstall } = await import("./install");
    startInstallWatch();
    fire("beforeinstallprompt", {
      prompt: vi.fn().mockRejectedValue(new Error("nope")),
      userChoice: Promise.resolve({}),
    });
    await expect(runInstall()).resolves.toBeUndefined();
    expect(installState().prompt).toBe(null);
  });

  it("detects a non-standalone iOS browser, which has no install prompt", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" });
    const { installState } = await import("./install");
    expect(installState().ios).toBe(true);
  });

  it("does not claim iOS when the app is already installed", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone)" });
    vi.stubGlobal("window", {
      addEventListener: () => {},
      matchMedia: () => ({ matches: true }),
    });
    const { installState } = await import("./install");
    expect(installState().ios).toBe(false);
  });

  it("unsubscribing stops the notifications", async () => {
    const { startInstallWatch, subscribeInstall } = await import("./install");
    const seen = vi.fn();
    subscribeInstall(seen)();
    startInstallWatch();
    fire("beforeinstallprompt", { prompt: async () => {}, userChoice: Promise.resolve({}) });
    expect(seen).not.toHaveBeenCalled();
  });
});
