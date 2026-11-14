import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Headphones,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { formatTimestamp } from "../lib/transcriptAssembler";
import "./meeting-audio.css";

export interface MeetingAudioPlayerProps {
  blob?: Blob;
  loading: boolean;
  durationMs: number;
  onRequestPlay: (atMs: number) => void;
  onReady: (player: HTMLAudioElement) => void;
  onTimeChange?: (atMs: number) => void;
  onPlaybackChange?: (playing: boolean) => void;
}

/** Native media stays queryable by the report's owner-pinned seek/play path. */
export default function MeetingAudioPlayer({
  blob,
  loading,
  durationMs,
  onRequestPlay,
  onReady,
  onTimeChange,
  onPlaybackChange,
}: MeetingAudioPlayerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const generation = useRef(0);
  const source = useRef<{ blob: Blob; url: string; ready: boolean } | null>(
    null,
  );
  const callbacks = useRef({ onReady, onTimeChange, onPlaybackChange });
  callbacks.current = { onReady, onTimeChange, onPlaybackChange };
  const [metadataReady, setMetadataReady] = useState(false);
  const [nativeDuration, setNativeDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState("");
  const [mediaFailed, setMediaFailed] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  useEffect(() => {
    generation.current++;
    const player = audio.current;
    setMetadataReady(false);
    setNativeDuration(0);
    setPosition(0);
    setPlaying(false);
    setError("");
    setMediaFailed(false);
    if (blob) callbacks.current.onTimeChange?.(0);
    setBuffering(false);
    setSeeking(false);
    callbacks.current.onPlaybackChange?.(false);
    if (!player || !blob)
      return () => {
        generation.current++;
      };
    const url = URL.createObjectURL(blob);
    source.current = { blob, url, ready: false };
    player.src = url;
    player.playbackRate = rateRef.current;
    player.load();
    return () => {
      generation.current++;
      source.current = null;
      player.pause();
      player.removeAttribute("src");
      player.load();
      URL.revokeObjectURL(url);
      callbacks.current.onPlaybackChange?.(false);
    };
  }, [blob]);
  const savedDuration =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const duration = nativeDuration || savedDuration;
  const preparing = loading || (!!blob && !metadataReady && !mediaFailed);
  const current = () => source.current?.blob === blob && !!source.current;
  function reportTime(player: HTMLAudioElement) {
    if (!current()) return;
    const atMs = Number.isFinite(player.currentTime)
      ? Math.max(0, player.currentTime * 1000)
      : 0;
    setPosition(atMs);
    callbacks.current.onTimeChange?.(atMs);
  }
  function reportPlayback(value: boolean) {
    if (!current()) return;
    setPlaying(value);
    if (!value) {
      setBuffering(false);
      setSeeking(false);
    }
    callbacks.current.onPlaybackChange?.(value);
  }
  function metadata(player: HTMLAudioElement) {
    if (!current()) return;
    if (Number.isFinite(player.duration) && player.duration > 0)
      setNativeDuration(player.duration * 1000);
    setMetadataReady(true);
    if (!source.current!.ready) {
      const active = source.current!;
      const ticket = generation.current;
      active.ready = true;
      const failed = (failure: unknown) => {
        if (
          generation.current !== ticket ||
          source.current !== active ||
          (failure instanceof Error && failure.name === "AbortError")
        )
          return;
        setError(
          "Wiedergabe konnte nicht gestartet werden. Bitte erneut auf Play drücken.",
        );
        reportPlayback(false);
      };
      try {
        void Promise.resolve(callbacks.current.onReady(player)).catch(failed);
      } catch (failure) {
        failed(failure);
      }
    }
    reportTime(player);
  }
  async function seek(atMs: number) {
    if (preparing || mediaFailed || !duration || !Number.isFinite(atMs)) return;
    const next = Math.min(duration, Math.max(0, atMs));
    const ticket = generation.current;
    try {
      if (!blob) {
        await onRequestPlay(next);
        return;
      }
      const player = audio.current;
      if (!player || !current() || !metadataReady) return;
      player.currentTime = next / 1000;
      setError("");
      reportTime(player);
    } catch {
      if (generation.current !== ticket) return;
      setError(
        blob
          ? "Diese Position kann noch nicht angesprungen werden. Bitte die Aufnahme zuerst abspielen."
          : "Aufnahme konnte nicht geladen werden. Bitte erneut versuchen.",
      );
    }
  }
  function changeRate(value: number) {
    if (![1, 1.25, 1.5, 2].includes(value)) return;
    if (audio.current) audio.current.playbackRate = value;
    setRate(value);
  }
  async function toggle() {
    if (preparing) return;
    const player = audio.current;
    const attempt = source.current;
    const ticket = generation.current;
    setError("");
    try {
      if (!blob) {
        await onRequestPlay(position);
        return;
      }
      if (!player || !current()) return;
      if (mediaFailed) {
        source.current!.ready = false;
        setMetadataReady(false);
        setMediaFailed(false);
        player.load();
        return;
      }
      if (!player.paused) player.pause();
      else await player.play();
    } catch (failure) {
      // Source replacement and pause can intentionally abort a pending play.
      if (
        generation.current !== ticket ||
        source.current !== attempt ||
        (failure instanceof Error && failure.name === "AbortError")
      )
        return;
      setError(
        "Wiedergabe konnte nicht gestartet werden. Bitte erneut auf Play drücken.",
      );
      reportPlayback(false);
    }
  }
  const status =
    error ||
    (preparing
      ? "Aufnahme wird geladen …"
      : seeking
        ? "Springe zur Position …"
        : buffering
          ? "Audio wird gepuffert …"
          : playing
            ? "Wiedergabe läuft"
            : blob
              ? duration
                ? "Bereit zum Abspielen"
                : "Dauer nicht verfügbar. Abspielen ist möglich, Springen nicht."
              : "Die Aufnahme wird erst beim Abspielen geladen.");
  return (
    <section
      className="meeting-audio no-print"
      aria-label="Aufnahme wiedergeben"
      aria-busy={preparing || buffering || seeking}
      style={
        {
          "--audio-progress": `${duration ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0}%`,
        } as CSSProperties
      }
    >
      <audio
        ref={audio}
        hidden
        preload="metadata"
        aria-hidden="true"
        onLoadedMetadata={(event) => metadata(event.currentTarget)}
        onDurationChange={(event) => {
          const value = event.currentTarget.duration;
          if (current() && Number.isFinite(value) && value > 0)
            setNativeDuration(value * 1000);
        }}
        onTimeUpdate={(event) => reportTime(event.currentTarget)}
        onPlay={() => reportPlayback(true)}
        onPlaying={() => {
          if (current()) {
            setBuffering(false);
            setError("");
            reportPlayback(true);
          }
        }}
        onWaiting={() => {
          if (current()) setBuffering(true);
        }}
        onSeeking={() => {
          if (current()) setSeeking(true);
        }}
        onSeeked={(event) => {
          if (current()) {
            setSeeking(false);
            reportTime(event.currentTarget);
          }
        }}
        onPause={() => reportPlayback(false)}
        onEnded={(event) => {
          reportPlayback(false);
          reportTime(event.currentTarget);
        }}
        onError={(event) => {
          if (!current()) return;
          reportPlayback(false);
          setMetadataReady(false);
          setMediaFailed(true);
          setError(
            event.currentTarget.error?.code === 4
              ? "Dieses Audioformat kann hier nicht wiedergegeben werden. Bitte einen anderen Browser versuchen."
              : "Die Aufnahme konnte nicht gelesen werden. Bitte erneut laden.",
          );
        }}
      />
      <div className="meeting-audio-heading">
        <Headphones size={17} aria-hidden="true" />
        <strong>Originalaufnahme</strong>
      </div>
      <div className="meeting-audio-transport">
        <button
          type="button"
          className="meeting-audio-play"
          disabled={preparing}
          aria-label={
            mediaFailed
              ? "Aufnahme erneut laden"
              : playing
                ? "Wiedergabe pausieren"
                : "Aufnahme abspielen"
          }
          onClick={toggle}
        >
          {preparing ? (
            <LoaderCircle
              className="meeting-audio-spinner"
              size={19}
              aria-hidden="true"
            />
          ) : playing ? (
            <Pause size={19} aria-hidden="true" />
          ) : (
            <Play size={19} aria-hidden="true" />
          )}
        </button>
        <div className="meeting-audio-track">
          <div className="meeting-audio-time">
            <span>{formatTimestamp(position)}</span>
            <span>{duration ? formatTimestamp(duration) : "–:––"}</span>
          </div>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={100}
            value={Math.min(position, duration || position)}
            disabled={preparing || mediaFailed || !duration}
            aria-label="Wiedergabeposition"
            aria-valuetext={`${formatTimestamp(position)} von ${duration ? formatTimestamp(duration) : "unbekannter Dauer"}`}
            onChange={(event) => seek(Number(event.currentTarget.value))}
          />
        </div>
        <div className="meeting-audio-secondary">
          <button
            type="button"
            disabled={preparing || mediaFailed || !duration || position <= 0}
            aria-label="10 Sekunden zurück"
            onClick={() =>
              seek((audio.current?.currentTime || 0) * 1000 - 10_000)
            }
          >
            <RotateCcw size={16} aria-hidden="true" />
            <span>10</span>
          </button>
          <button
            type="button"
            disabled={
              preparing || mediaFailed || !duration || position >= duration
            }
            aria-label="10 Sekunden vor"
            onClick={() =>
              seek((audio.current?.currentTime || 0) * 1000 + 10_000)
            }
          >
            <RotateCw size={16} aria-hidden="true" />
            <span>10</span>
          </button>
          <select
            aria-label="Wiedergabegeschwindigkeit"
            value={rate}
            onChange={(event) => changeRate(Number(event.currentTarget.value))}
          >
            {[1, 1.25, 1.5, 2].map((value) => (
              <option key={value} value={value}>
                {String(value).replace(".", ",")}×
              </option>
            ))}
          </select>
        </div>
      </div>
      <p
        className={`meeting-audio-status${error ? " is-error" : ""}`}
        role="status"
      >
        {status}
      </p>
    </section>
  );
}
