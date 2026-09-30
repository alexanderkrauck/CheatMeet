import { diffTurns, type LivePush, type LiveState } from "../../shared/mcp";
import type { MeetingTranscript, SpeechTurn } from "../../shared/transcription";

/**
 * Lets an assistant that holds a live grant read the transcript while it is
 * being recorded.
 *
 * Two rules shape everything here. First, text leaves this tab only after the
 * server has said an assistant is listening; until then the tab sends nothing
 * but a bodyless probe. Second, it must never be able to hurt the recording:
 * `update()` is synchronous and cheap, every network step runs on its own
 * timer, and no failure ever propagates to the caller.
 */
export type ShareStatus = "waiting" | "listening" | "off";

export interface LiveShare {
  /** Called on every transcript change; returns at once. */
  update(speech: MeetingTranscript | null | undefined): void;
  setState(state: LiveState): void;
  /** Sends the last words and stops. Idempotent, and bounded in time. */
  end(): Promise<void>;
  status(): ShareStatus;
}

export interface LiveShareOptions {
  reportId: string;
  startedAt: string;
  languages: string[];
  getToken: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** Called whenever the status changes (never with the same value twice). */
  onStatus?: (status: ShareStatus) => void;
}

const PROBE_MS = 30_000;
const PUSH_GAP_MS = 1_500;
const HEARTBEAT_MS = 15_000;
const RETRY_MS = 5_000;
const END_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 10_000;

export function startLiveShare(options: LiveShareOptions): LiveShare {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `/api/live/${encodeURIComponent(options.reportId)}`;

  let latest: MeetingTranscript | null = null;
  let known: SpeechTurn[] = []; // what the server has acknowledged
  let seq = 0;
  let needReset = true;
  let state: LiveState = "recording";
  let stateSent: LiveState | null = null;
  let listening = false;
  let off = false;
  let ended = false;
  let inFlight = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = -Infinity;
  let endWaiters: (() => void)[] = [];

  const clock = () => Date.now();
  let announced: ShareStatus | null = null;
  const current = (): ShareStatus => (off ? "off" : listening ? "listening" : "waiting");
  const announce = () => {
    const status = current();
    if (status === announced) return;
    announced = status;
    try {
      options.onStatus?.(status);
    } catch {
      /* a broken indicator must not touch the recording */
    }
  };
  const schedule = (ms: number) => {
    if (off) return;
    clearTimeout(timer);
    timer = setTimeout(() => void tick(), Math.max(0, ms));
  };
  const finish = () => {
    off = true;
    clearTimeout(timer);
    announce();
    for (const wake of endWaiters.splice(0)) wake();
  };

  async function request(body: unknown): Promise<Response | null> {
    try {
      const token = await options.getToken();
      if (!token) return null;
      return await fetchImpl(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  }

  async function probe() {
    const response = await request({ probe: true });
    if (response?.status === 401) return finish();
    const answer = response?.ok ? ((await response.json().catch(() => ({}))) as { listening?: boolean }) : null;
    listening = Boolean(answer?.listening);
    if (listening) needReset = true; // everything said so far goes out first
    announce();
    if (!ended) schedule(listening ? 0 : PROBE_MS);
  }

  async function push() {
    const turns = latest?.turns ?? [];
    const reset = needReset;
    const base = reset ? [] : known;
    const { upsert, remove } = diffTurns(base, turns);
    const idle = !reset && !upsert.length && !remove.length && state === stateSent;
    if (idle && clock() - lastSentAt < HEARTBEAT_MS) {
      dirty = false;
      return schedule(HEARTBEAT_MS - (clock() - lastSentAt));
    }
    const body: LivePush = {
      seq: seq + 1,
      ...(reset ? { reset: true } : {}),
      startedAt: options.startedAt,
      languages: options.languages,
      state,
      upsert,
      remove,
      speakerNames: latest?.speakerNames ?? {},
    };
    inFlight = true;
    dirty = false;
    const sentState = state;
    const response = await request(body);
    inFlight = false;
    if (response?.ok) {
      seq = body.seq;
      known = turns.map((t) => ({ ...t }));
      needReset = false;
      stateSent = sentState;
      lastSentAt = clock();
      if (!ended) schedule(dirty || state !== stateSent ? PUSH_GAP_MS : HEARTBEAT_MS);
      return;
    }
    if (response?.status === 401) return finish();
    if (response?.status === 409) {
      needReset = true;
      return schedule(PUSH_GAP_MS);
    }
    if (response?.status === 403) {
      // The assistant was revoked: stop sending text and go back to asking.
      listening = false;
      needReset = true;
      announce();
      return schedule(PROBE_MS);
    }
    // Network trouble or a busy server: nothing was acknowledged, so the same
    // difference is computed again and the gap is re-sent with the next push.
    if (!ended) schedule(response?.status === 429 ? PUSH_GAP_MS * 2 : RETRY_MS);
  }

  async function tick() {
    if (off || inFlight) return;
    try {
      if (!listening) await probe();
      else await push();
    } catch {
      inFlight = false;
      if (!off && !ended) schedule(RETRY_MS);
    }
  }

  announce();
  schedule(0);

  return {
    update(speech) {
      if (off || ended) return;
      if (speech && Array.isArray(speech.turns)) {
        latest = speech;
        dirty = true;
      }
      // Coalesce a burst of partial words into one request per PUSH_GAP_MS.
      if (listening && !inFlight) schedule(lastSentAt + PUSH_GAP_MS - clock());
    },
    setState(next) {
      if (off || ended) return;
      state = next;
      if (listening && !inFlight) schedule(0);
    },
    async end() {
      if (ended) {
        await new Promise<void>((resolve) => (off ? resolve() : endWaiters.push(resolve)));
        return;
      }
      ended = true;
      state = "ended";
      if (!listening || off) return finish();
      const done = new Promise<void>((resolve) => endWaiters.push(resolve));
      const give = setTimeout(finish, END_TIMEOUT_MS);
      // Wait for a request that is already on its way, then send the final state once.
      const flush = async () => {
        while (inFlight && !off) await new Promise((resolve) => setTimeout(resolve, 50));
        if (off) return;
        try {
          await push();
        } catch {
          /* the recording is what matters */
        }
        finish();
      };
      void flush();
      await done;
      clearTimeout(give);
    },
    status: current,
  };
}
