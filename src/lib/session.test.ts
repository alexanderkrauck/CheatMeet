import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firebase = vi.hoisted(() => ({
  auth: { currentUser: { uid: "alice" } as { uid: string } | null },
  provider: {},
  reauthenticate: vi.fn(),
  signIn: vi.fn(),
  credential: vi.fn(),
}));
vi.mock("./firebase", () => ({
  auth: firebase.auth,
  provider: firebase.provider,
}));
vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: { credentialFromResult: firebase.credential },
  reauthenticateWithPopup: firebase.reauthenticate,
  signInWithPopup: firebase.signIn,
}));
const stored = new Map<string, string>();
const key = "cheatmeet:drive-session";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T10:00:00Z"));
  firebase.auth.currentUser = { uid: "alice" };
  stored.clear();
  vi.stubGlobal("sessionStorage", {
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => stored.set(name, value),
    removeItem: (name: string) => stored.delete(name),
  });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Drive authorization session", () => {
  it("restores an unexpired token after reload without another Google popup", async () => {
    const first = await import("./session");
    first.rememberToken("drive-token");
    vi.resetModules();
    const reloaded = await import("./session");
    expect(reloaded.driveToken()).toBe("drive-token");
    expect(firebase.reauthenticate).not.toHaveBeenCalled();
  });

  it("waits for Firebase account restoration without deleting its token", async () => {
    (await import("./session")).rememberToken("drive-token");
    vi.resetModules();
    firebase.auth.currentUser = null;
    const reloaded = await import("./session");
    expect(reloaded.driveToken()).toBeNull();
    expect(stored.has(key)).toBe(true);
    firebase.auth.currentUser = { uid: "alice" };
    expect(reloaded.driveToken()).toBe("drive-token");
  });

  it("never uses a previous account's token", async () => {
    (await import("./session")).rememberToken("alice-token");
    vi.resetModules();
    firebase.auth.currentUser = { uid: "bob" };
    expect((await import("./session")).driveToken()).toBeNull();
    expect(stored.has(key)).toBe(false);
  });

  it("keeps its original expiry across reloads and permits an earlier preflight", async () => {
    (await import("./session")).rememberToken("drive-token");
    vi.advanceTimersByTime(41 * 60 * 1000);
    vi.resetModules();
    const reloaded = await import("./session");
    expect(reloaded.driveToken(10 * 60 * 1000)).toBeNull();
    expect(reloaded.driveToken()).toBe("drive-token");
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(reloaded.driveToken()).toBeNull();
    expect(stored.has(key)).toBe(false);
  });

  it("clears memory and storage on logout or token invalidation and notifies the UI", async () => {
    const session = await import("./session");
    const changed = vi.fn();
    window.addEventListener("cheatmeet:drive-session", changed);
    session.rememberToken("drive-token");
    session.rememberToken(undefined);
    expect(session.driveToken()).toBeNull();
    expect(stored.has(key)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    vi.resetModules();
    expect((await import("./session")).driveToken()).toBeNull();
  });

  it.each([
    "invalid json",
    "null",
    '{"token":3}',
    JSON.stringify({
      token: "bad",
      owner: "alice",
      expiresAt: Date.parse("2030-01-01"),
    }),
  ])("discards corrupted stored authorization: %s", async (value) => {
    stored.set(key, value);
    expect((await import("./session")).driveToken()).toBeNull();
    expect(stored.has(key)).toBe(false);
  });

  it("still works in memory when browser storage is blocked", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    const session = await import("./session");
    expect(session.driveToken()).toBeNull();
    session.rememberToken("drive-token");
    expect(session.driveToken()).toBe("drive-token");
    session.rememberToken(undefined);
    expect(session.driveToken()).toBeNull();
  });

  it("reauthorizes the existing Firebase account with the configured Drive provider", async () => {
    firebase.reauthenticate.mockResolvedValue({
      user: firebase.auth.currentUser,
    });
    firebase.credential.mockReturnValue({ accessToken: "renewed" });
    const session = await import("./session");
    expect(await session.connectGoogle()).toBe("renewed");
    expect(firebase.reauthenticate).toHaveBeenCalledWith(
      firebase.auth.currentUser,
      firebase.provider,
    );
    expect(firebase.signIn).not.toHaveBeenCalled();
    expect(session.driveToken()).toBe("renewed");
  });
});
