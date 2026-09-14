import { auth } from "./firebase";
import {
  renderTranscript,
  type MeetingTranscript,
} from "../../shared/transcription";
import { AssemblyEvents, liveDocument } from "./assemblyEvents";
import type { LiveTranscription } from "./liveTranscription";

/** Each packet is sent at most once. A connection failure leaves live gaps;
 * the independent final pass covers the durable recording, including those gaps. */
export function startAssemblyLive(
  sources: Partial<Record<"mic" | "system", MediaStream>>,
  now: () => number,
  changed: (speech: MeetingTranscript) => void,
  reportId: string,
  languages: string[],
): LiveTranscription {
  const owner = auth.currentUser?.uid;
  const events: AssemblyEvents[] = [];
  let warning = "",
    stopped = false,
    paused = false,
    generation = 0,
    pending = 0;
  let session = 0;
  let contexts: AudioContext[] = [];
  let connections: { close: () => Promise<void> }[] = [];
  const reconnects = new Set<ReturnType<typeof setTimeout>>();
  const owned = () => Boolean(owner && auth.currentUser?.uid === owner);
  const names: Record<string, string> = {};
  let speakerCount = 0;
  const doc = () => {
    const current = liveDocument(languages, events, stopped, warning);
    for (const turn of current.turns)
      if (!names[turn.speaker])
        names[turn.speaker] = turn.speaker.endsWith(":unknown")
          ? "Unbekannt"
          : `Sprecher ${++speakerCount}`;
    return { ...current, speakerNames: { ...names } };
  };
  const publish = () => {
    if (owned()) changed(doc());
  };
  const failed = () => {
    warning =
      "Das Live-Transkript hat Lücken. Beim Abschluss wird die gesicherte Aufnahme vollständig transkribiert.";
    publish();
  };
  let transitions = Promise.resolve();
  const transition = (operation: () => Promise<void>) => {
    transitions = transitions.then(operation, operation);
    return transitions;
  };
  async function startSource(
    source: string,
    stream: MediaStream,
    epoch: number,
    sequence: number,
    attempt = 0,
  ) {
    let context: AudioContext | undefined, socket: WebSocket | undefined;
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
    const reducer = new AssemblyEvents(`${source}:${sequence}`, mapTime);
    events.push(reducer);
    const dispose = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      clearTimeout(expiry);
      node?.disconnect();
      void context?.close().catch(() => {});
      socket?.close();
      reducer.seal();
      publish();
      resolveEnd();
    };
    const close = async () => {
      if (closed) return;
      if (terminating) return ended;
      terminating = true;
      node?.port.postMessage({ active: false });
      // Wait for final turns AND SpeakerRevision before disposing the socket.
      if (socket?.readyState === WebSocket.OPEN && begun) {
        timeout = setTimeout(() => {
          failed();
          dispose();
        }, 10000);
        socket.send(JSON.stringify({ type: "Terminate" }));
        await ended;
      } else dispose();
    };
    let retryScheduled = false;
    const interrupted = () => {
      failed();
      dispose();
      if (
        retryScheduled ||
        terminating ||
        stopped ||
        paused ||
        !owned() ||
        epoch !== generation ||
        attempt >= 3
      )
        return;
      retryScheduled = true;
      const retry = setTimeout(
        () => {
          reconnects.delete(retry);
          if (!stopped && !paused && owned() && epoch === generation)
            void startSource(source, stream, epoch, session++, attempt + 1);
        },
        5000 * 2 ** attempt,
      );
      reconnects.add(retry);
    };
    connections.push({ close });
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
      const token = await auth.currentUser?.getIdToken();
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
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Streaming nicht verfügbar.");
      const data = await response.json();
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
      });
      socket = new WebSocket(
        `wss://streaming.eu.assemblyai.com/v3/ws?${params}`,
      );
      timeout = setTimeout(interrupted, 15000);
      socket.onmessage = ({ data }) => {
        try {
          if (closed) return;
          if (!owned()) {
            dispose();
            return;
          }
          const event = JSON.parse(data);
          if (event.type === "Begin") {
            if (
              event.configuration?.model !== "universal-3-5-pro" ||
              event.configuration?.mode !== "max_accuracy"
            )
              throw new Error("Abweichendes Streaming-Modell.");
            begun = true;
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
                epoch !== generation ||
                !owned()
              )
                return;
              const lag = (context!.currentTime - frame.contextTime) * 1000;
              // Never burst queued audio after a background stall or reconnect.
              if (
                lag > 500 ||
                socket!.bufferedAmount > 6400 ||
                socket!.readyState !== WebSocket.OPEN
              ) {
                failed();
                return;
              }
              if (!blocks.length && now() > 500) failed();
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
                if (!stopped && !paused && owned() && epoch === generation)
                  void startSource(source, stream, epoch, session++);
              });
            }, 10740 * 1000);
          } else if (event.type === "Termination") dispose();
          else if (event.type === "Error") {
            failed();
            dispose();
          } else {
            reducer.apply(event);
            publish();
          }
        } catch {
          interrupted();
        }
      };
      socket.onerror = interrupted;
      socket.onclose = () => {
        if (!closed) interrupted();
      };
    } catch {
      interrupted();
    } finally {
      pending--;
    }
  }
  const launch = async () => {
    const epoch = ++generation;
    await Promise.all(
      Object.entries(sources)
        .filter(([, value]) => value)
        .map(([source, stream]) =>
          startSource(source, stream!, epoch, session++),
        ),
    );
  };
  const closeAll = async () => {
    ++generation;
    for (const timer of reconnects) clearTimeout(timer);
    reconnects.clear();
    const current = connections;
    connections = [];
    await Promise.all(current.map((c) => c.close()));
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    contexts = [];
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
    finish: async () => {
      stopped = true;
      await transition(closeAll);
      publish();
      return renderTranscript(doc());
    },
  };
}
