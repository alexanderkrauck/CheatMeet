import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLiveShare, type LiveShare } from "./liveShare";
import type { MeetingTranscript, SpeechTurn } from "../../shared/transcription";

const turn = (id: string, startMs: number, text: string, final = true): SpeechTurn => ({
  id, startMs, endMs: startMs + 900, speaker: "mic:0:A", text, final,
});
const speech = (turns: SpeechTurn[]): MeetingTranscript => ({
  provider: "assemblyai", phase: "live", languages: ["de"], turns, speakerNames: { "mic:0:A": "Anna" },
});

interface Sent { method: string; body: any; url: string }
let sent: Sent[];
let listening: boolean;
let respond: (call: Sent) => Response | Promise<Response>;
let share: LiveShare;

const make = (overrides: Partial<Parameters<typeof startLiveShare>[0]> = {}) =>
  (share = startLiveShare({
    reportId: "m1",
    startedAt: "2030-06-01T11:00:00.000Z",
    languages: ["de"],
    getToken: async () => "id-token",
    fetchImpl: vi.fn(async (url: any, init: any) => {
      const call: Sent = { method: init.method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined };
      sent.push(call);
      return respond(call);
    }) as unknown as typeof fetch,
    ...overrides,
  }));
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const flush = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };
const texts = () => sent.flatMap((call) => (call.body?.upsert ?? []).map((t: SpeechTurn) => t.text));

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  listening = false;
  respond = (call) => {
    if (call.body?.probe) return ok({ listening });
    if (!listening) return new Response(JSON.stringify({ listening: false }), { status: 403 });
    return ok({ seq: call.body.seq, listening: true });
  };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("while nobody is listening", () => {
  it("sends only a probe, never any transcript text", async () => {
    make();
    share.update(speech([turn("1", 0, "geheim")]));
    await flush(60_000);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((call) => call.body.probe === true)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("geheim");
  });
  it("probes about every 30 seconds", async () => {
    make();
    await flush(95_000);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.length).toBeLessThanOrEqual(5);
  });
  it("starts sending everything said so far as soon as an assistant is listening", async () => {
    make();
    share.update(speech([turn("1", 0, "früher gesagt"), turn("2", 5000, "auch früher")]));
    await flush(31_000);
    listening = true;
    await flush(31_000);
    const first = sent.find((call) => !call.body.probe)!;
    expect(first.body.reset).toBe(true);
    expect(first.body.seq).toBe(1);
    expect(first.body.upsert.map((t: SpeechTurn) => t.text)).toEqual(["früher gesagt", "auch früher"]);
  });
  it("stops sending text once the assistant is revoked, and goes back to probing", async () => {
    listening = true;
    make();
    share.update(speech([turn("1", 0, "eins")]));
    await flush(3000);
    expect(sent.some((call) => !call.body.probe)).toBe(true);
    listening = false;
    sent.length = 0;
    // The tab only learns of the revocation from the server's answer to its next push,
    // so the first attempt after revocation may carry text - but it is refused, and nothing follows.
    share.update(speech([turn("1", 0, "eins"), turn("2", 2000, "danach")]));
    await flush(3000);
    const attemptsAfterRefusal = sent.filter((call) => !call.body.probe).length;
    expect(attemptsAfterRefusal).toBeLessThanOrEqual(1);
    share.update(speech([turn("1", 0, "eins"), turn("2", 2000, "danach"), turn("3", 4000, "viel später")]));
    await flush(120_000);
    expect(texts()).not.toContain("viel später");
    expect(sent.filter((call) => !call.body.probe).length).toBe(attemptsAfterRefusal);
    expect(sent.at(-1)!.body.probe).toBe(true);
  });
});

describe("while an assistant is listening", () => {
  beforeEach(() => { listening = true; });

  it("sends a reset first, then only what changed", async () => {
    make();
    share.update(speech([turn("1", 0, "eins")]));
    await flush(3000);
    share.update(speech([turn("1", 0, "eins"), turn("2", 2000, "zwei", false)]));
    await flush(3000);
    const pushes = sent.filter((call) => !call.body.probe);
    expect(pushes[0].body).toMatchObject({ seq: 1, reset: true, state: "recording", languages: ["de"], remove: [] });
    expect(pushes[1].body.reset).toBeUndefined();
    expect(pushes[1].body.seq).toBe(2);
    expect(pushes[1].body.upsert.map((t: SpeechTurn) => t.id)).toEqual(["2"]);
  });
  it("sends at most one request per 1.5 s however often the transcript changes", async () => {
    make();
    share.update(speech([turn("1", 0, "a")]));
    await flush(2000);
    sent.length = 0;
    for (let i = 0; i < 40; i++) {
      share.update(speech([turn("1", 0, "a"), turn("2", 1000, `wort ${i}`, false)]));
      await flush(100);
    }
    await flush(2000);
    expect(sent.length).toBeLessThanOrEqual(4);
    expect(texts().at(-1)).toBe("wort 39");
  });
  it("keeps exactly one request in flight and never overlaps two", async () => {
    let active = 0, peak = 0;
    respond = async (call) => {
      if (call.body.probe) return ok({ listening: true });
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      active--;
      return ok({ seq: call.body.seq, listening: true });
    };
    make();
    for (let i = 0; i < 10; i++) { share.update(speech([turn("1", 0, `v${i}`)])); await flush(700); }
    await flush(30_000);
    expect(peak).toBe(1);
  });
  it("reports removed turns", async () => {
    make();
    share.update(speech([turn("1", 0, "a"), turn("2", 1000, "b")]));
    await flush(3000);
    share.update(speech([turn("2", 1000, "b")]));
    await flush(3000);
    expect(sent.filter((call) => !call.body.probe).at(-1)!.body.remove).toEqual(["1"]);
  });
  it("sends a heartbeat when nothing changes, so the meeting does not look abandoned", async () => {
    make();
    share.update(speech([turn("1", 0, "a")]));
    await flush(3000);
    sent.length = 0;
    await flush(50_000);
    const beats = sent.filter((call) => !call.body.probe);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.length).toBeLessThanOrEqual(5);
    expect(beats.every((call) => call.body.upsert.length === 0 && call.body.remove.length === 0)).toBe(true);
  });
  it("re-sends the gap after a failed request instead of losing it", async () => {
    let fail = true;
    respond = (call) => (call.body.probe ? ok({ listening: true }) : fail ? new Response("{}", { status: 503 }) : ok({ seq: call.body.seq, listening: true }));
    make();
    share.update(speech([turn("1", 0, "wichtig")]));
    await flush(3000);
    const failedAttempts = sent.filter((call) => !call.body.probe).length;
    fail = false;
    await flush(40_000);
    // The retry after the failure carries the same words again, and it is the one the server accepts.
    const retry = sent.filter((call) => !call.body.probe)[failedAttempts];
    expect(retry.body.upsert.map((t: SpeechTurn) => t.text)).toEqual(["wichtig"]);
    expect(retry.body.seq).toBe(1);
    expect(retry.body.reset).toBe(true);
  });
  it("starts over with a reset when the server asks for it", async () => {
    let answered = false;
    respond = (call) => {
      if (call.body.probe) return ok({ listening: true });
      if (!answered && call.body.seq === 2) { answered = true; return new Response(JSON.stringify({ resync: true }), { status: 409 }); }
      return ok({ seq: call.body.seq, listening: true });
    };
    make();
    share.update(speech([turn("1", 0, "a")]));
    await flush(3000);
    share.update(speech([turn("1", 0, "a"), turn("2", 1000, "b")]));
    await flush(3000);
    await flush(3000);
    const pushes = sent.filter((call) => !call.body.probe);
    const resent = pushes.find((call, i) => i > 1 && call.body.reset);
    expect(resent).toBeTruthy();
    expect(resent!.body.upsert.map((t: SpeechTurn) => t.id)).toEqual(["1", "2"]);
  });
  it("stops for good when the login is gone", async () => {
    respond = (call) => (call.body.probe ? new Response("{}", { status: 401 }) : ok({}));
    make();
    share.update(speech([turn("1", 0, "a")]));
    await flush(3000);
    const after = sent.length;
    await flush(120_000);
    expect(sent.length).toBe(after);
    expect(share.status()).toBe("off");
  });
  it("sends paused and ended states, and end() flushes the final words", async () => {
    make();
    share.update(speech([turn("1", 0, "a")]));
    await flush(3000);
    share.setState("paused");
    await flush(3000);
    expect(sent.filter((call) => !call.body.probe).at(-1)!.body.state).toBe("paused");
    share.setState("recording");
    share.update(speech([turn("1", 0, "a"), turn("2", 1000, "letzte Worte")]));
    const ended = share.end();
    await flush(3000);
    await ended;
    const last = sent.filter((call) => !call.body.probe).at(-1)!;
    expect(last.body.state).toBe("ended");
    expect(texts()).toContain("letzte Worte");
  });
  it("end() is idempotent and returns even while a request hangs", async () => {
    respond = (call) => (call.body.probe ? ok({ listening: true }) : new Promise<Response>(() => {}));
    make();
    share.update(speech([turn("1", 0, "a")]));
    await flush(2000);
    const first = share.end();
    const second = share.end();
    await flush(10_000);
    await expect(Promise.all([first, second])).resolves.toBeTruthy();
    const count = sent.length;
    await flush(60_000);
    expect(sent.length).toBe(count);
  });
});

describe("staying out of the recording's way", () => {
  it("update() returns immediately and never throws, whatever the network does", async () => {
    make({ fetchImpl: vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(() => share.update(speech([turn("1", 0, "a")]))).not.toThrow();
    expect(() => share.update(null as any)).not.toThrow();
    await flush(120_000);
    expect(() => share.setState("paused")).not.toThrow();
    await expect(share.end()).resolves.toBeUndefined();
  });
  it("survives a token provider that fails", async () => {
    listening = true;
    make({ getToken: async () => { throw new Error("no token"); } });
    share.update(speech([turn("1", 0, "a")]));
    await flush(60_000);
    expect(sent).toEqual([]);
  });
  it("does nothing after end()", async () => {
    listening = true;
    make();
    await share.end();
    sent.length = 0;
    share.update(speech([turn("1", 0, "nachher")]));
    await flush(60_000);
    expect(sent).toEqual([]);
  });
  it("never puts transcript text into a URL or a log line", async () => {
    listening = true;
    const info = vi.spyOn(console, "info");
    const warn = vi.spyOn(console, "warn");
    make();
    share.update(speech([turn("1", 0, "streng vertraulich")]));
    await flush(5000);
    expect(sent.every((call) => !call.url.includes("vertraulich"))).toBe(true);
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain("vertraulich");
  });
  it("announces every change of status exactly once, and survives a listener that throws", async () => {
    const seen: string[] = [];
    make({ onStatus: (status) => { seen.push(status); throw new Error("ui broke"); } });
    await flush(1000);
    listening = true;
    await flush(31_000);
    listening = false;
    await flush(200_000);
    expect(seen).toEqual(["waiting", "listening", "waiting"].filter((s, i, a) => s !== a[i - 1]));
    await share.end();
    expect(seen.at(-1)).toBe("off");
    expect(new Set(seen.slice(1).map((s, i) => `${seen[i]}>${s}`)).size).toBe(seen.length - 1);
  });
  it("reports whether an assistant is currently reading along", async () => {
    make();
    expect(share.status()).toBe("waiting");
    listening = true;
    await flush(31_000);
    expect(share.status()).toBe("listening");
  });
});
