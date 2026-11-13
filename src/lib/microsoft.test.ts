import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  user: { uid: "one", getIdToken: vi.fn(async () => "identity") },
}));
vi.mock("./firebase", () => ({
  auth: {
    get currentUser() {
      return state.user;
    },
  },
}));
import {
  microsoftRequest,
  ensureMicrosoftToken,
  connectMicrosoft,
  microsoftApi,
} from "./microsoft";
beforeEach(() => {
  state.user.uid = "one";
  vi.restoreAllMocks();
});
it("pins the owner across minting and never forwards Graph credentials to arbitrary URLs", async () => {
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ accessToken: "graph", connectionId: "c" })),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    microsoftRequest("https://evil.example/v1.0/me", {}, "c"),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await microsoftRequest("/me/drive", {}, "c");
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
    "https://graph.microsoft.com/v1.0/me/drive",
  );
});
it("discards a token minted during an account switch", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      state.user.uid = "two";
      return new Response(
        JSON.stringify({ accessToken: "private", connectionId: "c" }),
      );
    }),
  );
  await expect(ensureMicrosoftToken("c")).rejects.toThrow("Konto");
});
it("does not mistake popup closure after authenticated success for canceled consent while metadata loads", async () => {
  vi.useFakeTimers();
  const popup = {
    closed: false,
    close: vi.fn(),
    location: { href: "about:blank" },
  };
  const target = Object.assign(new EventTarget(), {
    location: { origin: "https://app.example" },
    open: () => popup,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("window", target);
  let finish!: (response: Response) => void;
  const metadata = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/connect")
        ? Response.json({ url: "https://login.microsoftonline.com/authorize" })
        : metadata,
    ),
  );
  const connected = connectMicrosoft();
  let failed = false;
  void connected.catch(() => {
    failed = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  target.dispatchEvent(
    Object.assign(new Event("message"), {
      origin: "https://app.example",
      source: popup,
      data: { source: "cheatmeet-microsoft-oauth", connected: true },
    }),
  );
  popup.closed = true;
  await vi.advanceTimersByTimeAsync(800);
  expect(failed).toBe(false);
  finish(Response.json({ connections: [] }));
  await connected;
  vi.useRealTimers();
});
it("exposes Microsoft throttling without leaking provider response bodies", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: "Bitte später versuchen." },
        { status: 429, headers: { "Retry-After": "12" } },
      ),
    ),
  );
  await expect(microsoftApi("token", {})).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 12000,
  });
});
