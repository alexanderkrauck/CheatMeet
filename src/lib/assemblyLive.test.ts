import { afterEach, beforeEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({
  currentUser: { uid: "alice", getIdToken: async () => "test-identity" } as any,
}));
vi.mock("./firebase", () => ({ auth }));
import { startAssemblyLive } from "./assemblyLive";

let sockets: Socket[],
  nodes: Node[],
  live: ReturnType<typeof startAssemblyLive>;
let clock = 1000;
class Socket {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  onmessage?: (event: any) => void;
  onclose?: () => void;
  sent: any[] = [];
  constructor(public url: string) {
    sockets.push(this);
  }
  send(data: any) {
    this.sent.push(data);
  }
  message(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}
class Node {
  port = {
    postMessage: vi.fn(),
    onmessage: undefined as ((event: any) => void) | undefined,
  };
  constructor() {
    nodes.push(this);
  }
  connect() {
    return this;
  }
  disconnect() {}
}
class Context {
  currentTime = 1;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  createMediaStreamSource() {
    return { connect: (node: any) => node };
  }
  createGain() {
    return { gain: { value: 0 }, connect() {} };
  }
  close = async () => {};
  resume = async () => {};
}
beforeEach(() => {
  sockets = [];
  nodes = [];
  clock = 1000;
  auth.currentUser = { uid: "alice", getIdToken: async () => "test-identity" };
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Node);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ token: "temporary" })),
  );
});
afterEach(async () => {
  const finished = live?.finish();
  await Promise.resolve();
  await Promise.resolve();
  for (const socket of sockets) socket.message({ type: "Termination" });
  await finished;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const begin = async () => {
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  sockets
    .at(-1)!
    .message({
      type: "Begin",
      configuration: { model: "universal-3-5-pro", mode: "max_accuracy" },
    });
};
it.each(["open", "retry"])("drops a system source with an %s connection without resurrection or affecting mic", async mode => {
  const changed = vi.fn();
  live = startAssemblyLive({ mic: {} as MediaStream, system: {} as MediaStream }, () => clock, changed, "meeting", ["de"]);
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  sockets.forEach(socket => socket.message({ type: "Begin", configuration: { model: "universal-3-5-pro", mode: "max_accuracy" } }));
  vi.useFakeTimers();
  if (mode === "retry") sockets[1].close();
  live.dropSource!("system");
  const sent = sockets[1].sent.length;
  nodes[1].port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 1 } });
  expect(sockets[1].sent).toHaveLength(sent);
  expect(sockets[1].readyState).toBe(3);
  expect(sockets[0].readyState).toBe(1);
  expect(changed.mock.calls.at(-1)?.[0].liveConnection).toBe("live");
  nodes[0].port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 1 } });
  expect(sockets[0].sent.filter(value => typeof value !== "string")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(sockets).toHaveLength(2);
  const paused = live.pause();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].message({ type: "Termination" });
  await paused;
  await live.resume();
  expect(sockets).toHaveLength(3);
  const calls = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(calls.filter(call => call.source === "system")).toHaveLength(1);
});

it("sends a frame once, retains visible text, and ignores global closing speaker revisions", async () => {
  const changed = vi.fn();
  live = startAssemblyLive(
    { mic: {} as MediaStream },
    () => clock,
    changed,
    "meeting",
    ["de", "en"],
  );
  await begin();
  nodes[0].port.onmessage!({
    data: { pcm: new ArrayBuffer(3200), contextTime: 1 },
  });
  sockets[0].message({
    type: "Turn",
    turn_order: 0,
    end_of_turn: true,
    words: [{ text: "Keine Zusage.", start: 0, end: 100, speaker: "A" }],
  });
  sockets[0].message({
    type: "Turn",
    turn_order: 1,
    end_of_turn: false,
    words: [{ text: "Unfertig", start: 0, end: 100, speaker: "A" }],
  });
  let done = false;
  const finish = live.finish().then((value) => {
    done = true;
    return value;
  });
  await vi.waitFor(() =>
    expect(
      sockets[0].sent.some(
        (v) => typeof v === "string" && v.includes("Terminate"),
      ),
    ).toBe(true),
  );
  expect(done).toBe(false);
  sockets[0].message({
    type: "SpeakerRevision",
    revisions: [
      { turn_order: 0, words: [{ start: 0, end: 100, speaker: "B" }] },
    ],
  });
  sockets[0].message({ type: "Termination" });
  expect(await finish).toContain("Unfertig");
  expect(changed.mock.calls.at(-1)?.[0].turns[0].speaker).toBe("mic:0:A");
  expect(changed.mock.calls.at(-1)?.[0].liveWarning).toContain("unbestätigte");
  expect(sockets[0].sent.filter((v) => typeof v !== "string")).toHaveLength(1);
});
it("drops stale frames without a catch-up burst and exposes the live gap", async () => {
  const changed = vi.fn();
  live = startAssemblyLive(
    { mic: {} as MediaStream },
    () => clock,
    changed,
    "meeting",
    ["de"],
  );
  await begin();
  nodes[0].port.onmessage!({
    data: { pcm: new ArrayBuffer(3200), contextTime: 0 },
  });
  expect(sockets[0].sent).toHaveLength(0);
  expect(changed.mock.calls.at(-1)?.[0].liveWarning).toContain("Lücken");
});
it("stops transmitting immediately after an account change", async () => {
  live = startAssemblyLive(
    { mic: {} as MediaStream },
    () => clock,
    vi.fn(),
    "meeting",
    ["de"],
  );
  await begin();
  auth.currentUser = { uid: "bob" };
  nodes[0].port.onmessage!({
    data: { pcm: new ArrayBuffer(3200), contextTime: 1 },
  });
  expect(sockets[0].sent).toHaveLength(0);
});
it("reconnects with future audio only, never replaying buffered or previous frames", async () => {
  live = startAssemblyLive(
    { mic: {} as MediaStream },
    () => clock,
    vi.fn(),
    "meeting",
    ["de"],
  );
  await begin();
  const first = new ArrayBuffer(3200);
  nodes[0].port.onmessage!({ data: { pcm: first, contextTime: 1 } });
  vi.useFakeTimers();
  sockets[0].close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(sockets).toHaveLength(2);
  sockets[1].message({
    type: "Begin",
    configuration: { model: "universal-3-5-pro", mode: "max_accuracy" },
  });
  expect(sockets[1].sent).toEqual([]);
  clock = 6000;
  const second = new ArrayBuffer(3200);
  nodes[1].port.onmessage!({ data: { pcm: second, contextTime: 1 } });
  expect(sockets[0].sent).toEqual([first]);
  expect(sockets[1].sent).toEqual([second]);
  expect(sockets[1].sent[0]).not.toBe(first);
});
it("pauses without sending paused audio and resumes with a distinct speaker session", async () => {
  const changed = vi.fn();
  live = startAssemblyLive(
    { mic: {} as MediaStream },
    () => clock,
    changed,
    "meeting",
    ["de"],
  );
  await begin();
  const paused = live.pause();
  await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
  nodes[0].port.onmessage!({
    data: { pcm: new ArrayBuffer(3200), contextTime: 1 },
  });
  expect(sockets[0].sent).toHaveLength(1);
  sockets[0].message({ type: "Termination" });
  await paused;
  await live.resume();
  expect(sockets).toHaveLength(2);
  sockets[1].message({
    type: "Begin",
    configuration: { model: "universal-3-5-pro", mode: "max_accuracy" },
  });
  sockets[1].message({
    type: "Turn",
    turn_order: 0,
    end_of_turn: true,
    words: [{ start: 0, end: 100, text: "Weiter", speaker: "A" }],
  });
  expect(changed.mock.calls.at(-1)?.[0].turns[0].speaker).toBe("mic:1:A");
});

it("reports slow stream startup separately from dropped audio", async () => {
  const changed = vi.fn();
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, changed, "meeting", ["de"]);
  await begin();
  clock = 1800;
  nodes[0].port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 1 } });
  expect(sockets[0].sent).toHaveLength(1);
  expect(live.failedSegments).toBe(0);
  expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ liveStartDelayed: true });
  expect(changed.mock.calls.at(-1)?.[0].liveWarning).toBeUndefined();
});
it("does not treat elapsed meeting time as delayed startup after resume", async () => {
  const changed = vi.fn();
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, changed, "meeting", ["de"]);
  await begin();
  nodes[0].port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 1 } });
  const paused = live.pause();
  await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(2));
  sockets[0].message({ type: "Termination" });
  await paused;
  clock = 100000;
  await live.resume();
  await begin();
  nodes[1].port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 1 } });
  expect(live.failedSegments).toBe(0);
  expect(changed.mock.calls.at(-1)?.[0].liveStartDelayed).toBeUndefined();
});

it.each(["mic", "system"] as const)("keeps confirmed %s identity across sessions while the other source still distinguishes voices", async source => {
  const changed = vi.fn();
  live = startAssemblyLive({mic: {} as MediaStream, system: {} as MediaStream}, () => clock,
    changed, "meeting", ["de"], {[source]: true});
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  const sendTurn = (socket: Socket) => {
    socket.message({type: "Begin", configuration: {model: "universal-3-5-pro", mode: "max_accuracy"}});
    socket.message({type: "Turn", turn_order: 0, end_of_turn: true, words: [
      {text: "Hallo", start: 0, end: 100, speaker: "A"},
      {text: "weiter", start: 100, end: 200, speaker: "B"},
      {text: "ja", start: 200, end: 300, speaker: "UNKNOWN"},
    ]});
  };
  sockets.forEach(sendTurn);
  const before = changed.mock.calls.at(-1)![0];
  expect(before.turns.filter((t: any) => t.speaker === `${source}:single`)).toHaveLength(1);
  expect(before.turns.find((t: any) => t.speaker === `${source}:single`).text).toBe("Hallo weiter ja");
  const other = source === "mic" ? "system" : "mic";
  expect(new Set(before.turns.filter((t: any) => t.speaker.startsWith(`${other}:`)).map((t: any) => t.speaker)).size).toBe(3);
  const paused = live.pause();
  await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
  sockets.forEach(socket => socket.message({type: "Termination"}));
  await paused;
  await live.resume();
  sockets.slice(2).forEach(sendTurn);
  const after = changed.mock.calls.at(-1)![0];
  const turns = after.turns.filter((t: any) => t.speaker === `${source}:single`);
  expect(turns).toHaveLength(2);
  expect(turns[0].id).not.toBe(turns[1].id);
  expect(new Set(after.turns.filter((t: any) => t.speaker.startsWith(`${other}:`)).map((t: any) => t.speaker)).size).toBe(6);
});

it("keeps two confirmed single speakers separate by source", async () => {
  const changed = vi.fn();
  live = startAssemblyLive({mic: {} as MediaStream, system: {} as MediaStream}, () => clock,
    changed, "meeting", ["de"], {mic: true, system: true});
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  sockets.forEach(socket => {
    socket.message({type: "Begin", configuration: {model: "universal-3-5-pro", mode: "max_accuracy"}});
    socket.message({type: "Turn", turn_order: 0, end_of_turn: false,
      words: [{text: "Hallo", start: 0, end: 100, speaker: "PENDING"}]});
  });
  expect(changed.mock.calls.at(-1)![0].turns.map((t: any) => t.speaker)).toEqual(["mic:single", "system:single"]);
});

const usageCalls = () => vi.mocked(fetch).mock.calls
  .filter(([url]) => String(url).startsWith('/api/usage/live/'))
  .map(([url, init]) => ({ url, init, body: JSON.parse(String(init?.body)) }));
const trackedFetch = (deliver: () => Promise<Response> = async () => Response.json({ ok: true })) => vi.mocked(fetch).mockImplementation(async (url, init) => {
  if (url === '/api/transcription/token') {
    const request = JSON.parse(String(init?.body));
    return Response.json({ token: 'temporary', usageId: `usage-${request.source}-${request.session}` });
  }
  return deliver();
});
const trackedBegin = (socket: Socket, id: string) => socket.message({
  type: 'Begin', id, configuration: { model: 'universal-3-5-pro', mode: 'max_accuracy' },
});

it('relays each actual source Begin and Termination independently, never meeting time or sent-audio estimates', async () => {
  trackedFetch();
  live = startAssemblyLive({ mic: {} as MediaStream, system: {} as MediaStream }, () => clock,
    vi.fn(), 'meeting', ['de'], {}, 'microsoft');
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  expect(usageCalls()).toEqual([]); // A token is not an opened session.
  expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).storage))
    .toEqual(['microsoft', 'microsoft']);
  trackedBegin(sockets[0], 'provider-mic');
  trackedBegin(sockets[1], 'provider-system');
  await vi.waitFor(() => expect(usageCalls()).toHaveLength(2));
  expect(usageCalls().map(call => ({ url: call.url, body: call.body }))).toEqual([
    { url: '/api/usage/live/usage-mic-0', body: { stage: 'begin', providerRequestId: 'provider-mic' } },
    { url: '/api/usage/live/usage-system-1', body: { stage: 'begin', providerRequestId: 'provider-system' } },
  ]);
  clock = 999999; // Elapsed meeting time must not become provider usage.
  const finished = live.finish();
  await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
  sockets[0].message({ type: 'Termination', session_duration_seconds: 12.5, audio_duration_seconds: 2 });
  sockets[1].message({ type: 'Termination', session_duration_seconds: 11, audio_duration_seconds: 3.5 });
  await finished;
  await vi.waitFor(() => expect(usageCalls()).toHaveLength(4));
  expect(usageCalls().slice(2).map(call => call.body)).toEqual([
    { stage: 'end', providerRequestId: 'provider-mic', sessionSeconds: 12.5, audioSeconds: 2 },
    { stage: 'end', providerRequestId: 'provider-system', sessionSeconds: 11, audioSeconds: 3.5 },
  ]);
  expect(usageCalls().every(call => (call.init?.headers as any).Authorization === 'Bearer test-identity')).toBe(true);
});

it.each(['disconnect', 'drop', 'begin-timeout', 'finish-timeout'])(
  'keeps usage unknown without invented durations when a tracked socket ends by %s', async reason => {
    trackedFetch();
    vi.useFakeTimers();
    live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, vi.fn(), 'meeting', ['de']);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    if (reason !== 'begin-timeout') trackedBegin(sockets[0], 'provider-mic');
    if (reason === 'disconnect') sockets[0].close();
    if (reason === 'drop') live.dropSource!('mic');
    if (reason === 'begin-timeout') await vi.advanceTimersByTimeAsync(15001);
    if (reason === 'finish-timeout') {
      const finished = live.finish();
      await vi.advanceTimersByTimeAsync(10001);
      await finished;
    }
    await vi.advanceTimersByTimeAsync(0);
    const interrupted = usageCalls().filter(call => call.body.stage === 'interrupted');
    expect(interrupted.map(call => ({ url: call.url, body: call.body }))).toEqual([{
      url: '/api/usage/live/usage-mic-0',
      body: { stage: 'interrupted', ...(reason === 'begin-timeout' ? {} : { providerRequestId: 'provider-mic' }) },
    }]);
    expect(usageCalls().some(call => call.body.stage === 'end')).toBe(false);
  },
);

it('retains an unsolicited terminal receipt across reconnect, late close, source drop and sign-out', async () => {
  trackedFetch();
  vi.useFakeTimers();
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, vi.fn(), 'meeting', ['de']);
  await vi.advanceTimersByTimeAsync(0);
  trackedBegin(sockets[0], 'provider-first');
  sockets[0].message({ type: 'Termination', session_duration_seconds: 9, audio_duration_seconds: 1 });
  sockets[0].close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(sockets).toHaveLength(2);
  trackedBegin(sockets[1], 'provider-second');
  await vi.advanceTimersByTimeAsync(0);
  const first = usageCalls().filter(call => String(call.url).endsWith('usage-mic-0'));
  expect(first.map(call => call.body)).toEqual([
    { stage: 'begin', providerRequestId: 'provider-first' },
    { stage: 'end', providerRequestId: 'provider-first', sessionSeconds: 9, audioSeconds: 1 },
  ]);
  expect(usageCalls().filter(call => call.body.stage === 'begin').map(call => call.url))
    .toEqual(['/api/usage/live/usage-mic-0', '/api/usage/live/usage-mic-1']);
  live.dropSource!('mic');
  await vi.advanceTimersByTimeAsync(0);
  expect(usageCalls().at(-1)).toMatchObject({ url: '/api/usage/live/usage-mic-1',
    body: { stage: 'interrupted', providerRequestId: 'provider-second' } });
  auth.currentUser = null;
  live.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(usageCalls().filter(call => String(call.url).endsWith('usage-mic-0'))).toHaveLength(2);
});

it.each([
  { event: {}, counts: {} },
  { event: { session_duration_seconds: '12', audio_duration_seconds: -1 }, counts: {} },
  { event: { session_duration_seconds: 0, audio_duration_seconds: 0 }, counts: { sessionSeconds: 0, audioSeconds: 0 } },
])('omits unknown or invalid termination counts rather than manufacturing zero ($event)', async ({ event, counts }) => {
  trackedFetch();
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, vi.fn(), 'meeting', ['de']);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  trackedBegin(sockets[0], 'provider-mic');
  sockets[0].message({ type: 'Termination', ...event });
  await vi.waitFor(() => expect(usageCalls()).toHaveLength(2));
  expect(usageCalls()[1].body).toEqual({ stage: 'end', providerRequestId: 'provider-mic', ...counts });
  expect(usageCalls().some(call => call.body.stage === 'interrupted')).toBe(false);
});

it.each(['network', 'rejected', 'pending'] as const)('never couples transcript delivery or finish to a %s receipt', async outcome => {
  trackedFetch(async () => {
    if (outcome === 'network') throw Error('receipt unavailable');
    if (outcome === 'pending') return new Promise<Response>(() => {});
    return Response.json({ error: 'fixture' }, { status: 503 });
  });
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, vi.fn(), 'meeting', ['de']);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  trackedBegin(sockets[0], 'provider-mic');
  nodes[0].port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 1 } });
  sockets[0].message({ type: 'Turn', turn_order: 0, end_of_turn: true,
    words: [{ text: 'Unabhängiges Transkript', start: 0, end: 100, speaker: 'A' }] });
  expect(live.transcript).toContain('Unabhängiges Transkript');
  const finished = live.finish();
  await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(2));
  sockets[0].message({ type: 'Termination', session_duration_seconds: 5, audio_duration_seconds: 1 });
  expect(await finished).toContain('Unabhängiges Transkript');
  expect(live.failedSegments).toBe(0);
  expect(sockets).toHaveLength(1);
});

it('pins receipt token delivery to the original owner across an asynchronous token refresh', async () => {
  trackedFetch();
  let release!: (token: string) => void;
  auth.currentUser.getIdToken = vi.fn()
    .mockResolvedValueOnce('test-identity')
    .mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  live = startAssemblyLive({ mic: {} as MediaStream }, () => clock, vi.fn(), 'meeting', ['de']);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  trackedBegin(sockets[0], 'provider-alice');
  expect(release).toBeTypeOf('function');
  auth.currentUser = { uid: 'bob', getIdToken: vi.fn(async () => 'bob-token') };
  release('alice-refreshed-token');
  await Promise.resolve(); await Promise.resolve();
  live.tick();
  nodes[0].port.onmessage!({ data: { pcm: new ArrayBuffer(3200), contextTime: 1 } });
  expect(usageCalls()).toEqual([]);
  expect(auth.currentUser.getIdToken).not.toHaveBeenCalled();
  expect(sockets[0].sent.filter(value => typeof value !== 'string')).toHaveLength(0);
});
