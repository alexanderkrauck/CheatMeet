// Live-transcription stall reproductions for src/lib/assemblyLive.ts.
//
// Harness (fake WebSocket / AudioContext / worklet node) is copied from assemblyLive.test.ts.
// `vi.mock("./firebase")` below stands in for the real Firebase module.
//
// History: written against 5770193, where 16 of these 20 failed (each REPRO named a real defect)
// and the GUARDs passed. They pass now. Keep the GUARDs green: a quiet, healthy meeting must
// never reconnect, and a deliberate pause/finish must never be "recovered".
// Nothing here needs the network.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({
  currentUser: { uid: "alice", getIdToken: async () => "test-identity" } as any,
}));
vi.mock("./firebase", () => ({ auth }));
import { startAssemblyLive } from "./assemblyLive";

let sockets: Socket[], nodes: Node[], contexts: Context[], live: ReturnType<typeof startAssemblyLive>;
let clock = 1000;
class Socket {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  onmessage?: (event: any) => void;
  onclose?: () => void;
  sent: any[] = [];
  constructor(public url: string) { sockets.push(this); }
  send(data: any) { this.sent.push(data); }
  message(data: any) { this.onmessage?.({ data: JSON.stringify(data) }); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}
class Node {
  port = { postMessage: vi.fn(), onmessage: undefined as ((event: any) => void) | undefined };
  constructor() { nodes.push(this); }
  connect() { return this; }
  disconnect() {}
}
class Context {
  currentTime = 1;
  state = "running";
  destination = {};
  audioWorklet = { addModule: async () => {} };
  constructor() { contexts.push(this); }
  createMediaStreamSource() { return { connect: (node: any) => node }; }
  createGain() { return { gain: { value: 0 }, connect() {} }; }
  close = async () => {};
  resume = vi.fn(async () => {});
}
beforeEach(() => {
  sockets = []; nodes = []; contexts = []; clock = 1000;
  auth.currentUser = { uid: "alice", getIdToken: async () => "test-identity" };
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Node);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "temporary" })));
});
afterEach(async () => {
  const finished = live?.finish();
  await Promise.resolve(); await Promise.resolve();
  for (const socket of sockets) socket.message({ type: "Termination" });
  await finished;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const BEGIN = { type: "Begin", configuration: { model: "universal-3-5-pro", mode: "max_accuracy" } };
const begin = async () => {
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  sockets.at(-1)!.message(BEGIN);
};
const start = () =>
  (live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, vi.fn(), "meeting", ["de"]));
const frame = (i = 0) => nodes[i].port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 1 } });

// The app calls live.tick() every 500 ms (capture.ts ticker) and on every MediaRecorder chunk.
const runFor = async (ms: number, { frames = true, tick = true } = {}) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    if (frames && nodes.length) frame(nodes.length - 1);
    if (tick && elapsed % 500 === 0) live.tick();
    clock += 100;
    await vi.advanceTimersByTimeAsync(100);
  }
};

it("REPRO A1: a session the server ends with an Error frame (3006 inactivity) is reconnected", async () => {
  start();
  await begin();
  vi.useFakeTimers();
  sockets[0].message({ type: "Error", error_code: 3006, error: "Session terminated due to inactivity: No messages received for 20 seconds" });
  sockets[0].close(); // the server then closes the socket
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sockets.length).toBeGreaterThanOrEqual(2);
});

it("REPRO A2: a session the server terminates on its own (unsolicited Termination) is reconnected", async () => {
  start();
  await begin();
  vi.useFakeTimers();
  sockets[0].message({ type: "Termination" }); // we did NOT send Terminate
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sockets.length).toBeGreaterThanOrEqual(2);
});

// A reconnect that works: the provider answers Begin as soon as the new socket exists.
const healthyFor = async (ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    const last = sockets.at(-1)!;
    if (!(last as any).begun && last.readyState === 1) { last.message(BEGIN); (last as any).begun = true; }
    clock += 1000;
    await vi.advanceTimersByTimeAsync(1000);
  }
};

it("REPRO B: every interruption is reconnected, however many happened earlier in the meeting", async () => {
  start();
  await begin();
  (sockets[0] as any).begun = true;
  vi.useFakeTimers();
  const counts: number[] = [];
  for (let i = 0; i < 6; i++) {
    await healthyFor(10 * 60_000); // this connection was healthy for ten minutes
    sockets.at(-1)!.close(); // a network blip closes it
    await healthyFor(40_000); // long enough for the longest back-off used today (20 s); the new socket answers Begin promptly
    counts.push(sockets.length);
  }
  // Today: [2, 3, 4, 4, 4, 4] - the initial connection plus three retries for the WHOLE meeting.
  expect(counts).toEqual([2, 3, 4, 5, 6, 7]);
});

it("REPRO C: recovers when the socket stays OPEN but accepts nothing (half-open connection)", async () => {
  start();
  await begin();
  vi.useFakeTimers();
  sockets[0].bufferedAmount = 1_000_000; // bytes never drain and no close event ever arrives
  await runFor(60_000);
  expect(sockets.length).toBeGreaterThan(1);
});

it("REPRO D: recovers when audio stops flowing although the socket is healthy (suspended AudioContext)", async () => {
  start();
  await begin();
  vi.useFakeTimers();
  const resumesAfterBegin = contexts[0].resume.mock.calls.length;
  contexts[0].state = "suspended"; // the worklet stops posting frames
  await runFor(4_000, { frames: false });
  expect(contexts[0].resume.mock.calls.length).toBeGreaterThan(resumesAfterBegin); // first attempt: resume it
  await runFor(12_000, { frames: false });
  expect(sockets.length).toBeGreaterThan(1); // still silent: rebuild the source
});

it("REPRO E: dropping frames must not republish (and re-render) the whole transcript once per dropped frame", async () => {
  const changed = vi.fn();
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, changed, "meeting", ["de"]);
  await begin();
  changed.mockClear();
  for (let i = 0; i < 100; i++) // 10 s of frames that are all older than the 500 ms lag budget
    nodes[0].port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 0 } });
  // Today: 100 - each dropped frame calls failed() -> publish() -> changed(doc()).
  expect(changed.mock.calls.length).toBeLessThanOrEqual(1);
});

it("GUARD F1: ten quiet minutes with heartbeats and no speech never cause a reconnect", async () => {
  start();
  await begin();
  vi.useFakeTimers();
  for (let s = 0; s < 600; s += 5) { // provider heartbeat every 5 s, nothing else: an empty room
    sockets[0].message({ type: "Heartbeat", realtime_factor: 1, max_speech_probability: 0, total_audio_received_ms: s * 1000, total_duration_ms: s * 1000 });
    await runFor(5_000);
  }
  expect(sockets.length).toBe(1);
});

it("REPRO F2: a session that goes completely silent on the server side (no heartbeat, no turn) is rebuilt", async () => {
  start();
  await begin();
  vi.useFakeTimers();
  await runFor(30_000); // audio keeps flowing, the provider says nothing at all
  expect(sockets.length).toBeGreaterThan(1);
});

it("REPRO G: the connection asks the provider for heartbeats, the only liveness signal a browser can see", async () => {
  start();
  await begin();
  expect(new URL(sockets[0].url).searchParams.get("session_heartbeat")).toBe("true");
});

const tokenRoute = (status: number) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
const tokenCalls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

it("REPRO H1: a token route that rejects the request (400) ends the attempts for good", async () => {
  tokenRoute(400);
  vi.useFakeTimers();
  start();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(tokenCalls()).toBe(1); // today: 4 (three pointless retries)
});

it("REPRO H2: a lost login (401 three times in a row) stops instead of hammering the route", async () => {
  tokenRoute(401);
  vi.useFakeTimers();
  start();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(tokenCalls()).toBe(3); // today: 4
});

it("REPRO H3: a server outage (503) keeps being retried for the whole meeting, with a capped back-off", async () => {
  tokenRoute(503);
  vi.useFakeTimers();
  start();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(tokenCalls()).toBeGreaterThanOrEqual(15); // today: 4
  expect(tokenCalls()).toBeLessThanOrEqual(40); // and never faster than the server allows (12 per minute)
});

it("GUARD I: nothing reconnects a source that was ended on purpose (pause) or a paused meeting's watchdog", async () => {
  start();
  await begin();
  vi.useFakeTimers();
  const paused = live.pause();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].message({ type: "Termination" }); // the provider answers our Terminate
  await paused;
  await runFor(120_000, { frames: false });
  expect(sockets.length).toBe(1);
});

it("REPRO J: only the silent source is rebuilt; the healthy one keeps its connection", async () => {
  live = startAssemblyLive({ mic: {} as MediaStream, system: {} as MediaStream }, () => clock, vi.fn(), "meeting", ["de"]);
  await vi.waitFor(() => expect(sockets.length).toBe(2));
  for (const socket of sockets) socket.message(BEGIN);
  vi.useFakeTimers();
  const healthy = sockets[1];
  for (let elapsed = 0; elapsed < 30_000; elapsed += 100) {
    for (const node of nodes) node.port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 1 } });
    if (elapsed % 5000 === 0) healthy.message({ type: "Heartbeat", realtime_factor: 1, max_speech_probability: 0, total_audio_received_ms: elapsed, total_duration_ms: elapsed });
    if (elapsed % 500 === 0) live.tick();
    clock += 100;
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(healthy.readyState).toBe(1);
  expect(sockets.length).toBe(3); // exactly one replacement, for the silent source
});

it("REPRO K: restart() opens a fresh connection on its own, the way pause -> resume does, without pausing", async () => {
  start();
  await begin();
  expect(typeof live.restart).toBe("function");
  const restarted = live.restart!();
  await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1)); // it ends the old session politely
  sockets[0].message({ type: "Termination" });
  await restarted;
  expect(sockets.length).toBe(2);
});

it("REPRO L: after the login is lost the status is 'stopped', and restart() brings the transcript back", async () => {
  const changed = vi.fn();
  tokenRoute(401);
  vi.useFakeTimers();
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, changed, "meeting", ["de"]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(changed.mock.calls.at(-1)![0].liveConnection).toBe("stopped");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "temporary" })));
  const restarted = live.restart!();
  await vi.advanceTimersByTimeAsync(0);
  await restarted;
  await vi.advanceTimersByTimeAsync(10);
  sockets.at(-1)!.message(BEGIN);
  expect(changed.mock.calls.at(-1)![0].liveConnection).toBe("live");
});

it("REPRO M: the published status follows the connection, and disappears when paused or finished", async () => {
  const changed = vi.fn();
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, changed, "meeting", ["de"]);
  const status = () => changed.mock.calls.at(-1)?.[0]?.liveConnection;
  await vi.waitFor(() => expect(sockets.length).toBe(1));
  sockets[0].message(BEGIN);
  expect(status()).toBe("live");
  vi.useFakeTimers();
  sockets[0].close();
  expect(status()).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(5_000);
  sockets[1].message(BEGIN);
  expect(status()).toBe("live");
  const finished = live.finish();
  await vi.advanceTimersByTimeAsync(0);
  sockets.forEach((s) => s.message({ type: "Termination" }));
  await finished;
  expect(status()).toBeUndefined();
});

it("GUARD N: provider heartbeats are liveness only - they never reach the transcript or republish it", async () => {
  const changed = vi.fn();
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, changed, "meeting", ["de"]);
  await begin();
  changed.mockClear();
  sockets[0].message({ type: "Heartbeat", realtime_factor: 1, max_speech_probability: 0, total_audio_received_ms: 5000, total_duration_ms: 5000 });
  expect(changed).not.toHaveBeenCalled();
});
