import { auth } from "./firebase";
import { ownSpeakerName } from "./meetingDefaults";
import {
  renderTranscript,
  type LiveConnection,
  type MeetingTranscript,
} from "../../shared/transcription";
import { AssemblyEvents, liveDocument } from "./assemblyEvents";
import type { LiveTranscription } from "./liveTranscription";

/** When a silent connection is rebuilt. Evaluated from tick(), on the injected clock. */
export const WATCHDOG = {
  /** No provider message at all; heartbeats arrive every 5 s, the provider's own cutoff is 20 s. */
  silenceMs: 15000,
  /** No audio frame from the worklet: first try to resume the AudioContext... */
  resumeAudioMs: 3000,
  /** ...then rebuild the source. */
  noAudioMs: 12000,
  /** The socket has not drained for this long. */
  blockedMs: 10000,
};
/** A connection that lived this long counts as a fresh start for the retry back-off. */
const HEALTHY_MS = 30000;
const backoff = (attempt: number) =>
  Math.min(30000, 2000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);

class TokenError extends Error {
  constructor(readonly status: number) {
    super("Streaming nicht verfügbar.");
  }
}

export interface ConnectionEvent {
  at: number;
  source: "mic" | "system";
  kind: string;
  code?: number | string;
  attempt: number;
}
const history: ConnectionEvent[] = [];
/** The last 100 connection events (no transcript text), for diagnosing the next stall. */
export const liveConnectionLog = () => history.slice();
const record = (event: ConnectionEvent) => {
  history.push(event);
  if (history.length > 100) history.shift();
  console.info("[live]", event.source, event.kind, event.code ?? "", `attempt=${event.attempt}`);
};

/** Each packet is sent at most once. The live transcript is the saved transcript;
 * connection failures remain visible instead of triggering retranscription. */
export function startAssemblyLive(
  sources: Partial<Record<"mic" | "system", MediaStream>>,
  now: () => number,
  changed: (speech: MeetingTranscript) => void,
  reportId: string,
  languages: string[],
  singleSpeakerSources: Partial<Record<"mic" | "system", boolean>> = {},
  storage: 'google' | 'microsoft' = 'google',
): LiveTranscription {
  const user = auth.currentUser;
  const owner = user?.uid;
  const microphoneName = ownSpeakerName(auth.currentUser?.displayName);
  const events: AssemblyEvents[] = [];
  let warning = "",
    startDelayed = false,
    stopped = false,
    paused = false,
    generation = 0,
    pending = 0;
  let session = 0;
  let contexts: AudioContext[] = [];
  let connections: { source: "mic" | "system"; close: () => Promise<void>; drop: () => void }[] = [];
  const reconnects = new Map<ReturnType<typeof setTimeout>, "mic" | "system">();
  const owned = () => Boolean(owner && auth.currentUser?.uid === owner);
  const names: Record<string, string> = {};
  let speakerCount = 0;
  const states = new Map<"mic" | "system", LiveConnection>();
  const watchers = new Set<() => void>();
  const authFailures = new Map<"mic" | "system", number>();
  const connection = (): LiveConnection | undefined => {
    if (stopped || paused || !states.size) return undefined;
    const all = [...states.values()];
    return all.includes("stopped") ? "stopped"
      : all.includes("reconnecting") ? "reconnecting"
        : all.includes("connecting") ? "connecting" : "live";
  };
  let shown: LiveConnection | undefined;
  const setState = (source: "mic" | "system", state: LiveConnection | undefined) => {
    if (state) states.set(source, state);
    else states.delete(source);
    if (connection() !== shown) publish();
  };
  const doc = () => {
    shown = connection();
    const current = liveDocument(languages, events, stopped, warning);
    for (const turn of current.turns)
      if (!names[turn.speaker])
        names[turn.speaker] = turn.speaker === "mic:single"
          ? microphoneName
          : turn.speaker.endsWith(":unknown")
            ? "Unbekannt"
            : `Sprecher ${++speakerCount}`;
    return {
      ...current,
      speakerNames: { ...names },
      ...(startDelayed ? { liveStartDelayed: true } : {}),
      ...(shown ? { liveConnection: shown } : {}),
    };
  };
  const publish = () => {
    if (owned()) changed(doc());
  };
  const failed = () => {
    // Every dropped frame lands here; only the first one changes anything.
    if (warning) return;
    warning =
      "Das Live-Transkript kann Lücken oder unbestätigte Beiträge enthalten. Es wird ohne erneute Transkription gespeichert.";
    publish();
  };
  let transitions = Promise.resolve();
  /** Sources whose device is gone; never reconnected, even on resume. */
  const dropped = new Set<"mic" | "system">();
  const transition = (operation: () => Promise<void>) => {
    transitions = transitions.then(operation, operation);
    return transitions;
  };
  async function startSource(
    source: "mic" | "system",
    stream: MediaStream,
    epoch: number,
    sequence: number,
    attempt = 0,
  ) {
    if (dropped.has(source) || stopped || paused || !owned() || epoch !== generation) return;
    const requestedAt = now();
    let context: AudioContext | undefined, socket: WebSocket | undefined;
    let usageId: string | undefined, providerRequestId: string | undefined;
    let usageEnded = false;
    // Provider messages are relayed as browser evidence, never billing proof.
    // Delivery is deliberately detached from the audio/transcript lifecycle.
    const receipt = (stage: 'begin' | 'end' | 'interrupted', durations: {
      audioSeconds?: number; sessionSeconds?: number;
    } = {}) => {
      if (!usageId || !owned()) return;
      const id = usageId;
      const body = JSON.stringify({ stage, ...(providerRequestId ? { providerRequestId } : {}), ...durations });
      void (async () => {
        const token = await user?.getIdToken();
        if (!token || !owned()) return;
        await fetch(`/api/usage/live/${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body, keepalive: true, signal: AbortSignal.timeout(10000),
        });
      })().catch(() => {});
    };
    let closed = false,
      begun = false,
      terminating = false,
      sentMs = 0;
    let resolveEnd: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let node: AudioWorkletNode | undefined;
    // Liveness, all on the injected clock.
    let beganAt = 0,
      lastMessageAt = 0,
      lastFrameAt = 0,
      blockedSince: number | undefined,
      resumeTried = false;
    const blocks: { sent: number; at: number }[] = [];
    const mapTime = (ms: number) => {
      let lo = 0,
        hi = blocks.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (blocks[mid].sent <= ms) lo = mid;
        else hi = mid - 1;
      }
      const block = blocks[lo];
      return block
        ? Math.max(0, block.at + Math.min(100, Math.max(0, ms - block.sent)))
        : 0;
    };
    // Turn IDs remain session-specific; a confirmed single person keeps the same
    // identity across pauses/reconnects and never merges with the other source.
    const reducer = new AssemblyEvents(`${source}:${sequence}`, mapTime,
      singleSpeakerSources[source] ? `${source}:single` : undefined);
    events.push(reducer);
    const watch = () => {
      if (closed || terminating || !begun || paused || stopped || dropped.has(source) || epoch !== generation)
        return;
      const at = now();
      if (at - lastMessageAt > WATCHDOG.silenceMs) return interrupted("watchdog-silent");
      if (blockedSince !== undefined && at - blockedSince > WATCHDOG.blockedMs)
        return interrupted("watchdog-blocked");
      const quiet = at - lastFrameAt;
      if (quiet > WATCHDOG.noAudioMs) return interrupted("watchdog-no-audio");
      if (quiet > WATCHDOG.resumeAudioMs && !resumeTried) {
        resumeTried = true;
        void context?.resume().catch(() => {});
      }
    };
    const dispose = () => {
      if (closed) return;
      closed = true;
      // An issued token / disconnected session has no defensible zero-duration
      // estimate. Never downgrade a Termination receipt during disposal/retry.
      if (!usageEnded) receipt('interrupted');
      watchers.delete(watch);
      connections = connections.filter((entry) => entry !== handle);
      contexts = contexts.filter((entry) => entry !== context);
      clearTimeout(timeout);
      clearTimeout(expiry);
      node?.disconnect();
      void context?.close().catch(() => {});
      socket?.close();
      if (reducer.hasUnfinishedTurns()) failed();
      publish();
      resolveEnd();
    };
    const close = async () => {
      if (closed) return;
      if (!owned() || dropped.has(source)) { drop(); return; }
      if (terminating) return ended;
      terminating = true;
      node?.port.postMessage({ active: false });
      // Drain the last live Turn events without starting another transcription.
      if (socket?.readyState === WebSocket.OPEN && begun) {
        timeout = setTimeout(() => {
          failed();
          dispose();
        }, 10000);
        socket.send(JSON.stringify({ type: "Terminate" }));
        await ended;
      } else dispose();
    };
    const drop = () => {
      if (closed) return;
      terminating = true;
      node?.port.postMessage({ active: false });
      if (socket?.readyState === WebSocket.OPEN && begun)
        socket.send(JSON.stringify({ type: "Terminate" }));
      dispose();
    };
    let retryScheduled = false;
    /** The one path every failure takes: a socket that closed, errored, was ended
     * by the provider, never began, or went quiet is rebuilt - for as long as the
     * meeting is being recorded. Only a rejected request or a lost login gives up. */
    function interrupted(kind: string, code?: number | string, error?: unknown) {
      const tokenStatus = error instanceof TokenError ? error.status : undefined;
      record({ at: now(), source, kind, code: code ?? tokenStatus, attempt });
      failed();
      dispose();
      if (
        retryScheduled ||
        terminating ||
        stopped ||
        paused ||
        dropped.has(source) ||
        !owned() ||
        epoch !== generation
      )
        return;
      if (tokenStatus !== undefined) {
        if ([400, 404, 413, 415, 422].includes(tokenStatus))
          return setState(source, "stopped");
        if (tokenStatus === 401 || tokenStatus === 403) {
          const failures = (authFailures.get(source) ?? 0) + 1;
          authFailures.set(source, failures);
          if (failures >= 3) return setState(source, "stopped");
        }
      }
      retryScheduled = true;
      setState(source, "reconnecting");
      // A connection that was healthy for a while starts the back-off over.
      const streak = begun && now() - beganAt >= HEALTHY_MS ? 0 : attempt;
      const retry = setTimeout(() => {
        reconnects.delete(retry);
        if (!stopped && !paused && !dropped.has(source) && owned() && epoch === generation)
          void startSource(source, stream, epoch, session++, streak + 1);
      }, backoff(streak));
      reconnects.set(retry, source);
    }
    const handle = { source, close, drop };
    connections.push(handle);
    watchers.add(watch);
    setState(source, states.has(source) ? "reconnecting" : "connecting");
    pending++;
    try {
      // Prefer the browser's native band-limited resampler. The worklet also
      // handles devices/browsers that only accept their native sample rate.
      try {
        context = new AudioContext({ sampleRate: 16000 });
      } catch {
        context = new AudioContext();
      }
      contexts.push(context);
      await context.audioWorklet.addModule(
        new URL("./pcmWorklet.js", import.meta.url),
      );
      if (!owned() || epoch !== generation || closed || dropped.has(source)) { dispose(); return; }
      const token = await user?.getIdToken();
      if (!owned() || epoch !== generation || closed) {
        dispose();
        return;
      }
      const response = await fetch("/api/transcription/token", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reportId,
          source,
          session: sequence,
          languages,
          storage,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new TokenError(response.status);
      const data = await response.json();
      if (typeof data.usageId === 'string') usageId = data.usageId;
      if (!owned() || epoch !== generation || closed) {
        dispose();
        return;
      }
      if (typeof data.token !== "string")
        throw new Error("Streaming-Token fehlt.");
      const params = new URLSearchParams({
        token: data.token,
        sample_rate: "16000",
        encoding: "pcm_s16le",
        speech_model: "universal-3-5-pro",
        mode: "max_accuracy",
        speaker_labels: "true",
        continuous_partials: "true",
        language_codes: JSON.stringify(languages),
        inactivity_timeout: "20",
        session_heartbeat: "true",
      });
      socket = new WebSocket(
        `wss://streaming.eu.assemblyai.com/v3/ws?${params}`,
      );
      timeout = setTimeout(() => interrupted("begin-timeout"), 15000);
      socket.onmessage = ({ data }) => {
        try {
          if (closed) return;
          if (!owned()) {
            dispose();
            return;
          }
          const event = JSON.parse(data);
          lastMessageAt = now();
          if (event.type === "Begin") {
            if (typeof event.id === 'string') providerRequestId = event.id;
            receipt('begin');
            if (
              event.configuration?.model !== "universal-3-5-pro" ||
              event.configuration?.mode !== "max_accuracy"
            )
              throw new Error("Abweichendes Streaming-Modell.");
            begun = true;
            beganAt = lastMessageAt = lastFrameAt = now();
            blockedSince = undefined;
            authFailures.delete(source);
            setState(source, "live");
            clearTimeout(timeout);
            if (terminating || epoch !== generation) {
              void close();
              return;
            }
            const input = context!.createMediaStreamSource(stream);
            node = new AudioWorkletNode(context!, "meeting-pcm");
            const silent = context!.createGain();
            silent.gain.value = 0;
            input.connect(node).connect(silent).connect(context!.destination);
            node.port.onmessage = ({ data: frame }) => {
              if (
                closed ||
                terminating ||
                paused ||
                stopped ||
                dropped.has(source) ||
                epoch !== generation ||
                !owned()
              )
                return;
              lastFrameAt = now();
              const lag = (context!.currentTime - frame.contextTime) * 1000;
              const blocked = socket!.bufferedAmount > 6400;
              if (blocked) blockedSince ??= lastFrameAt;
              else blockedSince = undefined;
              // Never burst queued audio after a background stall or reconnect.
              if (
                lag > 500 ||
                blocked ||
                socket!.readyState !== WebSocket.OPEN
              ) {
                failed();
                return;
              }
              if (!blocks.length && now() - requestedAt > 500 && !startDelayed) {
                startDelayed = true;
                publish();
              }
              blocks.push({ sent: sentMs, at: now() - Math.max(0, lag) - 100 });
              sentMs += 100;
              socket!.send(frame.pcm);
            };
            node.port.postMessage({ active: true });
            void context!.resume().catch(() => {
              failed();
              dispose();
            });
            // Roll over before the provider's three-hour limit, without replay.
            expiry = setTimeout(() => {
              void close().then(() => {
                if (!stopped && !paused && !dropped.has(source) && owned() && epoch === generation)
                  void startSource(source, stream, epoch, session++);
              });
            }, 10740 * 1000);
          } else if (event.type === "Termination") {
            usageEnded = true;
            const seconds = (value: unknown): value is number =>
              typeof value === 'number' && Number.isFinite(value) && value >= 0;
            receipt('end', {
              ...(seconds(event.session_duration_seconds) ? { sessionSeconds: event.session_duration_seconds } : {}),
              ...(seconds(event.audio_duration_seconds) ? { audioSeconds: event.audio_duration_seconds } : {}),
            });
            // Ours (terminating) ends quietly; one the provider decided on is an outage.
            if (terminating) dispose();
            else interrupted("termination");
          } else if (event.type === "Error") {
            interrupted("error", event.error_code);
          } else if (event.type === "Heartbeat") {
            // Liveness only; it never touches the transcript.
          } else if (event.type !== "SpeakerRevision") {
            // Keep the speaker labels the user maintained during the recording.
            // The provider's end-of-session global relabeling must not swap them.
            reducer.apply(event);
            publish();
          }
        } catch {
          interrupted("message-error");
        }
      };
      socket.onerror = () => interrupted("socket-error");
      socket.onclose = () => {
        if (!closed) interrupted("closed");
      };
    } catch (error) {
      interrupted(error instanceof TokenError ? "token" : "setup-error", undefined, error);
    } finally {
      pending--;
    }
  }
  const launch = async () => {
    const epoch = ++generation;
    await Promise.all(
      (["mic", "system"] as const)
        .filter(source => sources[source] && !dropped.has(source))
        .map(source =>
          startSource(source, sources[source]!, epoch, session++),
        ),
    );
  };
  const closeAll = async () => {
    ++generation;
    for (const timer of reconnects.keys()) clearTimeout(timer);
    reconnects.clear();
    const current = connections;
    connections = [];
    await Promise.all(current.map((c) => c.close()));
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    contexts = [];
    states.clear();
    watchers.clear();
  };
  void transition(launch);
  return {
    get transcript() {
      return renderTranscript(doc());
    },
    get pendingSegments() {
      return pending;
    },
    get failedSegments() {
      return warning ? 1 : 0;
    },
    tick() {
      if (!owned()) void closeAll();
      else for (const check of [...watchers]) check();
    },
    /** The device behind a source ended; stop paying for its connection. */
    dropSource(source: "mic" | "system") {
      dropped.add(source);
      for (const [timer, retrySource] of reconnects) {
        if (retrySource !== source) continue;
        clearTimeout(timer);
        reconnects.delete(timer);
      }
      for (const connection of [...connections])
        if (connection.source === source) connection.drop();
      authFailures.delete(source);
      setState(source, undefined);
    },
    pause: () => {
      paused = true;
      return transition(closeAll);
    },
    resume: () => {
      paused = false;
      return transition(async () => {
        if (!stopped && owned()) await launch();
      });
    },
    restart: () => {
      authFailures.clear();
      return transition(async () => {
        if (stopped || paused || !owned()) return;
        await closeAll();
        await launch();
      });
    },
    finish: async () => {
      stopped = true;
      await transition(closeAll);
      publish();
      return renderTranscript(doc());
    },
  };
}
