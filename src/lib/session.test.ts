import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firebase = vi.hoisted(() => ({
  auth: { currentUser: { uid: "alice", providerData:[{providerId:"google.com"}] } as { uid: string; providerData?:{providerId:string}[] } | null },
  provider: {},
  reauthenticate: vi.fn(),
  signIn: vi.fn(),
  credential: vi.fn(),
  unlink: vi.fn(),
  reload: vi.fn(),
  link: vi.fn(),
  credentialSignIn: vi.fn(),
}));
vi.mock("./firebase", () => ({
  auth: firebase.auth,
  provider: firebase.provider,
}));
vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class { static credentialFromResult = firebase.credential; static credential = vi.fn(); },
  reauthenticateWithPopup: firebase.reauthenticate,
  signInWithPopup: firebase.signIn,
  unlink: firebase.unlink,
  reload: firebase.reload,
  linkWithPopup: firebase.link,
  linkWithCredential: firebase.link,
  signInWithCredential: firebase.credentialSignIn,
}));
const stored = new Map<string, string>();
const key = "cheatmeet:drive-session";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T10:00:00Z"));
  firebase.auth.currentUser = { uid: "alice",providerData:[{providerId:"google.com"}] };
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
    firebase.auth.currentUser = { uid: "alice",providerData:[{providerId:"google.com"}] };
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

describe("server-held drive authorization", () => {
  async function load({
    uid = "alice",
    config = { serverAuth: true },
    mint = { accessToken: "minted", expiresInSeconds: 3600 },
    mintStatus = 200,
  } = {}) {
    const current = { uid, getIdToken: async () => "firebase-id-token" };
    const holder = { user: current as { uid: string; getIdToken: () => Promise<string> } | null };
    vi.doMock("./firebase", () => ({
      auth: {
        get currentUser() {
          return holder.user;
        },
      },
      provider: {},
    }));
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/auth/config")) return Response.json(config);
      return Response.json(mint, { status: mintStatus });
    });
    vi.stubGlobal("fetch", fetchMock);
    const session = await import("./session");
    return { session, fetchMock, holder };
  }

  it("mints a token from the server without prompting the user", async () => {
    const { session, fetchMock } = await load();
    expect(await session.ensureDriveToken()).toBe("minted");
    expect(session.driveToken()).toBe("minted");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/drive-token"))).toBe(true);
  });

  it("blocks new mints throughout partial revocation and permits a later reconnect", async () => {
    const { session, fetchMock } = await load();
    let finishRevoke!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finishRevoke = resolve; });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/config")) return Response.json({ serverAuth: true });
      if (url.endsWith("/revoke")) return response;
      return Response.json({ accessToken: "fresh-after-reconnect", expiresInSeconds: 3600 });
    });
    const pending = session.revokeDriveGrant();
    const failure = expect(pending).rejects.toThrow("Widerruf nicht bestätigt");
    await vi.advanceTimersByTimeAsync(0);
    const mintedDuringRevoke = await session.ensureDriveToken();
    finishRevoke(Response.json({ revoked: false, localDisconnected: true, warning: "Widerruf nicht bestätigt" }, { status: 502 }));
    await failure;
    expect(mintedDuringRevoke).toBeNull();
    expect(session.driveToken()).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/drive-token"))).toHaveLength(0);
    expect(await session.ensureDriveToken()).toBe("fresh-after-reconnect");
  });

  it("issues one request even when several uploads start at once", async () => {
    const { session, fetchMock } = await load();
    await Promise.all([
      session.ensureDriveToken(),
      session.ensureDriveToken(),
      session.ensureDriveToken(),
    ]);
    const mints = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/api/drive-token"),
    );
    expect(mints).toHaveLength(1);
  });

  it("never stores a token minted for an account that has since changed", async () => {
    const { session, holder } = await load({ uid: "alice" });
    const pending = session.ensureDriveToken();
    // The signed-in account changes while the mint is in flight.
    holder.user = { uid: "bob", getIdToken: async () => "bob-token" };
    expect(await pending).toBeNull();
    expect(session.driveToken()).toBeNull();
  });

  it('treats identity without a Drive connection as unconfigured, not revoked',async()=>{
    const {session}=await load({mintStatus:403,mint:{error:'not connected',reauth:true,reason:'no_grant'} as never});
    const changed=vi.fn();window.addEventListener('cheatmeet:drive-revoked',changed);
    expect(await session.ensureDriveToken()).toBeNull();expect(changed).not.toHaveBeenCalled();
  });
  it("signs the user out when the grant is gone", async () => {
    const { session } = await load({
      mintStatus: 403,
      mint: { error: "entzogen", reauth: true, reason: "revoked" } as never,
    });
    const seen: CustomEvent[] = [];
    window.addEventListener("cheatmeet:drive-revoked", (e) =>
      seen.push(e as CustomEvent),
    );
    expect(await session.ensureDriveToken()).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].detail).toMatchObject({ message: "entzogen" });
  });

  it("keeps the popup flow when the server cannot mint tokens", async () => {
    const { session, fetchMock } = await load({ config: { serverAuth: false } });
    expect(await session.ensureDriveToken()).toBeNull();
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes("/api/drive-token")),
    ).toBe(false);
  });
});

describe("grant and identity boundaries", () => {
  it("connects data without adding a Firebase login and retains a partial-revoke warning while clearing the local token", async () => {
    const user = {uid:"microsoft-owner", providerData:[{providerId:"microsoft.com"}], getIdToken:vi.fn(async()=>"firebase-id")};
    vi.doMock("./firebase", () => ({auth:{currentUser:user},provider:firebase.provider}));
    const popup = {closed:false,close:vi.fn()};
    const target = Object.assign(new EventTarget(), {location:{origin:"https://app.example"},open:vi.fn(()=>popup),setInterval,clearInterval,setTimeout,clearTimeout});
    vi.stubGlobal("window",target);
    const fetcher = vi.fn(async (url:string) => {
      if(url.endsWith("/config"))return Response.json({serverAuth:true});
      if(url.endsWith("/start"))return Response.json({url:"https://accounts.google.com/fixture"});
      if(url.endsWith("/revoke"))return Response.json({revoked:false,localDisconnected:true,warning:"Widerruf nicht bestätigt. Bitte im Google-Konto prüfen."},{status:502});
      return Response.json({accessToken:"data-access",expiresInSeconds:3600});
    });
    vi.stubGlobal("fetch",fetcher);
    const session = await import("./session");
    const connected = session.connectGoogle();
    await vi.advanceTimersByTimeAsync(0);
    target.dispatchEvent(Object.assign(new Event("message"), {origin:target.location.origin,source:popup,data:{source:"cheatmeet-oauth",idToken:`e30.${btoa(JSON.stringify({sub:"data-google"}))}.sig`}}));
    expect(await connected).toBe("data-access");
    expect(firebase.link).not.toHaveBeenCalled();
    expect(firebase.credentialSignIn).not.toHaveBeenCalled();
    expect(firebase.signIn).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([url])=>url.endsWith("/start"))).toBe(true);
    await expect(session.revokeDriveGrant()).rejects.toThrow(/nicht bestätigt.*Google-Konto/);
    expect(session.driveToken()).toBeNull();
    expect(stored.has(key)).toBe(false);
    session.stopDriveTokenRefresh();
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({serverAuth:false})));
    await expect(session.connectGoogle()).rejects.toThrow(/benötigt.*serverseitige/);
    expect(firebase.link).not.toHaveBeenCalled();
  });

  it("unlinks Google only after refreshed last-method checks and grant preservation, retaining identity on recent-auth failure", async () => {
    const user = {uid:"owner",providerData:[{providerId:"google.com"}],getIdToken:vi.fn(async()=>"firebase-id")};
    const holder = {currentUser:user};
    vi.doMock("./firebase",()=>({auth:holder,provider:firebase.provider}));
    const preserve = vi.fn(async()=>Response.json({preserved:true}));
    vi.stubGlobal("fetch",preserve);
    firebase.reload.mockResolvedValue(undefined);
    const session = await import("./session");
    await expect(session.unlinkGoogleIdentity()).rejects.toThrow(/letzte/);
    expect(firebase.unlink).not.toHaveBeenCalled();
    user.providerData.push({providerId:"microsoft.com"});
    preserve.mockResolvedValueOnce(Response.json({error:"Die serverseitige Google-Verbindung ist nicht eingerichtet."},{status:503}));
    await expect(session.unlinkGoogleIdentity()).rejects.toThrow(/serverseitige Google-Verbindung/);
    expect(firebase.unlink).not.toHaveBeenCalled();
    firebase.unlink.mockRejectedValueOnce(Object.assign(Error("private"),{code:"auth/requires-recent-login"}));
    await expect(session.unlinkGoogleIdentity()).rejects.toThrow(/erneut anmelden/);
    expect(user.providerData).toHaveLength(2);
    firebase.unlink.mockResolvedValueOnce(user);
    await session.unlinkGoogleIdentity();
    expect(firebase.unlink).toHaveBeenLastCalledWith(user,"google.com");
    expect(user.getIdToken).toHaveBeenLastCalledWith(true);
    const calls = firebase.unlink.mock.calls.length;
    firebase.reload.mockImplementationOnce(async()=>{holder.currentUser={...user,uid:"other"};});
    await expect(session.unlinkGoogleIdentity()).rejects.toThrow(/Konto.*geändert/);
    expect(firebase.unlink).toHaveBeenCalledTimes(calls);
  });
});

describe("hasCalendarGrant", () => {
  it("is false without a token, whatever was stored", async () => {
    const { rememberToken, hasCalendarGrant } = await import("./session");
    rememberToken(undefined);
    expect(hasCalendarGrant()).toBe(false);
  });
  it("follows the grant the token was minted under", async () => {
    const { rememberToken, hasCalendarGrant } = await import("./session");
    rememberToken("t", 60_000, undefined, true);
    expect(hasCalendarGrant()).toBe(true);
    rememberToken("t", 60_000, undefined, false);
    expect(hasCalendarGrant()).toBe(false);
  });
  it("defaults to false, so a Drive-only grant never claims the calendar", async () => {
    const { rememberToken, hasCalendarGrant } = await import("./session");
    rememberToken("t", 60_000);
    expect(hasCalendarGrant()).toBe(false);
  });
  it("survives a reload: the flag rides with the stored session, not a module flag", async () => {
    const first = await import("./session");
    first.rememberToken("t", 60_000, undefined, true);
    vi.resetModules();
    const reloaded = await import("./session");
    expect(reloaded.hasCalendarGrant()).toBe(true);
  });
});

describe("serverAuthAvailable", () => {
  it("remembers a real answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ serverAuth: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { serverAuthAvailable } = await import("./session");
    expect(await serverAuthAvailable()).toBe(true);
    expect(await serverAuthAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure, so one flaky request cannot downgrade the tab", async () => {
    vi.resetModules();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, json: async () => ({ serverAuth: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { serverAuthAvailable } = await import("./session");
    expect(await serverAuthAvailable()).toBe(false);
    expect(await serverAuthAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a non-2xx response as a failure it will retry", async () => {
    vi.resetModules();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValue({ ok: true, json: async () => ({ serverAuth: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { serverAuthAvailable } = await import("./session");
    expect(await serverAuthAvailable()).toBe(false);
    expect(await serverAuthAvailable()).toBe(true);
  });
});
