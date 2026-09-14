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
it("sends a frame once, waits for late speaker corrections, and excludes unfinished text", async () => {
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
  expect(await finish).not.toContain("Unfertig");
  expect(changed.mock.calls.at(-1)?.[0].turns[0].speaker).toBe("mic:0:B");
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
