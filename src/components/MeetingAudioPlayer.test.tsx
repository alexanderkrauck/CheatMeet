import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Match the repository's component-hook harness; only native media is mocked.
const h = vi.hoisted(() => ({
  slots: [] as any[],
  cursor: 0,
  updates: 0,
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
}));
vi.mock("react", async (load) => ({
  ...(await load<typeof import("react")>()),
  useState: (initial: any) => {
    const index = h.cursor++;
    if (!(index in h.slots))
      h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[index],
      (value: any) => {
        h.updates++;
        h.slots[index] =
          typeof value === "function" ? value(h.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: any) => {
    const index = h.cursor++;
    return (h.slots[index] ||= { current: initial });
  },
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = h.cursor++;
    if (!h.slots[index] || deps.some((dep, i) => dep !== h.slots[index][i])) {
      h.slots[index] = deps;
      h.effects.push(() => {
        h.cleanups.get(index)?.();
        const cleanup = effect();
        if (typeof cleanup === "function")
          h.cleanups.set(index, cleanup as () => void);
        else h.cleanups.delete(index);
      });
    }
  },
}));
import MeetingAudioPlayer from "./MeetingAudioPlayer";

type Element = React.ReactElement<any>;
function nodes(tree: React.ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return React.isValidElement(tree)
    ? [tree as Element, ...nodes((tree as Element).props.children)]
    : [];
}
function text(tree: React.ReactNode): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return React.isValidElement(tree)
    ? text((tree as Element).props.children)
    : "";
}
function control(tree: React.ReactNode, label: string): Element {
  const node = nodes(tree).find(
    (n) => n.type === "button" && n.props["aria-label"] === label,
  );
  expect(node, label).toBeDefined();
  return node!;
}
const request = vi.fn();
const ready = vi.fn();
const time = vi.fn();
const playback = vi.fn();
const createURL = vi.fn();
const revokeURL = vi.fn();
let props: React.ComponentProps<typeof MeetingAudioPlayer>;
let media: HTMLAudioElement;
function view() {
  h.cursor = 0;
  const tree = MeetingAudioPlayer(props);
  const audio = nodes(tree).find((n) => n.type === "audio");
  expect(
    audio,
    "native audio must remain queryable by the parent wrapper",
  ).toBeDefined();
  if (typeof audio!.props.ref === "function") audio!.props.ref(media);
  else if (audio!.props.ref) audio!.props.ref.current = media;
  return tree;
}
function flush() {
  for (const effect of h.effects.splice(0)) effect();
  return view();
}
function event(name: string) {
  const audio = nodes(view()).find((n) => n.type === "audio")!;
  audio.props[name]({ currentTarget: media });
  return view();
}
function unmount() {
  for (const cleanup of h.cleanups.values()) cleanup();
  h.cleanups.clear();
  h.effects = [];
}
beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
  ready.mockReset();
  time.mockReset();
  playback.mockReset();
  h.slots = [];
  h.cursor = 0;
  h.updates = 0;
  h.effects = [];
  h.cleanups.clear();
  createURL.mockImplementation(
    () => `blob:local-${createURL.mock.calls.length}`,
  );
  vi.spyOn(URL, "createObjectURL").mockImplementation(createURL);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeURL);
  props = {
    loading: false,
    durationMs: 90_000,
    onRequestPlay: request,
    onReady: ready,
    onTimeChange: time,
    onPlaybackChange: playback,
  };
  media = {
    currentTime: 0,
    duration: NaN,
    paused: true,
    ended: false,
    playbackRate: 1,
    src: "",
    currentSrc: "",
    error: null,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn((name: string) => {
      if (name === "src") media.src = "";
    }),
    getAttribute: vi.fn((name: string) =>
      name === "src" ? media.src || null : null,
    ),
  } as unknown as HTMLAudioElement;
});
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

it("renders a real custom transport without loading audio before the user asks", () => {
  const tree = view();
  flush();
  expect(createURL).not.toHaveBeenCalled();
  expect(media.load).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(time).not.toHaveBeenCalled(); // An unloaded source has no actual playback position.
  const audio = nodes(tree).find((n) => n.type === "audio")!;
  expect(audio.props.controls).not.toBe(true);
  expect(audio.props.hidden).toBe(true);
  expect(audio.props.src).toBeUndefined();
  expect(text(tree)).toContain("0:00");
  expect(text(tree)).toContain("1:30");
  expect(
    nodes(tree).some((n) => n.type === "input" && n.props.type === "range"),
  ).toBe(true);
  control(tree, "Aufnahme abspielen").props.onClick();
  expect(request).toHaveBeenCalledWith(0);
  const markup = renderToStaticMarkup(<>{view()}</>);
  expect(markup).not.toContain("controls=");
  expect(markup).not.toContain("https://");
});

it("owns one blob URL and releases paused media on replacement and unmount", () => {
  const first = new Blob(["synthetic audio"]);
  props.blob = first;
  view();
  flush();
  expect(createURL).toHaveBeenCalledExactlyOnceWith(first);
  expect(media.src).toBe("blob:local-1");
  expect(media.load).toHaveBeenCalledTimes(1);
  expect(ready).not.toHaveBeenCalled();
  props = { ...props, onReady: vi.fn() }; // Inline parent callbacks must not recreate URLs.
  view();
  flush();
  expect(createURL).toHaveBeenCalledTimes(1);
  props.blob = new Blob(["replacement"]);
  view();
  flush();
  expect(media.pause).toHaveBeenCalledTimes(1);
  expect(media.removeAttribute).toHaveBeenCalledWith("src");
  expect(revokeURL).toHaveBeenCalledExactlyOnceWith("blob:local-1");
  expect(media.src).toBe("blob:local-2");
  unmount();
  expect(media.pause).toHaveBeenCalledTimes(2);
  expect(media.src).toBe("");
  expect(revokeURL.mock.calls).toEqual([["blob:local-1"], ["blob:local-2"]]);
  expect(media.load).toHaveBeenCalledTimes(4); // Load each source; release each source.
});

it("hands the loaded native element to the parent and follows real media time and playback", async () => {
  props.blob = new Blob(["audio"]);
  ready.mockImplementation((player: HTMLAudioElement) => {
    player.currentTime = 12.5; // The parent still owns its requested passage.
  });
  view();
  let tree = flush();
  expect(ready).not.toHaveBeenCalled();
  expect(control(tree, "Aufnahme abspielen").props.disabled).toBe(true);
  Object.assign(media, { duration: 92.25 });
  tree = event("onLoadedMetadata");
  expect(ready).toHaveBeenCalledExactlyOnceWith(media);
  event("onLoadedMetadata");
  expect(ready).toHaveBeenCalledTimes(1);
  tree = event("onTimeUpdate");
  expect(text(tree)).toContain("0:12");
  expect(text(tree)).toContain("1:32");
  expect(time).toHaveBeenLastCalledWith(12_500);
  await control(tree, "Aufnahme abspielen").props.onClick();
  expect(media.play).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
  Object.assign(media, { paused: false });
  tree = event("onPlay");
  expect(playback).toHaveBeenLastCalledWith(true);
  control(tree, "Wiedergabe pausieren").props.onClick();
  expect(media.pause).toHaveBeenCalledTimes(1);
  Object.assign(media, { paused: true });
  tree = event("onPause");
  expect(playback).toHaveBeenLastCalledWith(false);
  expect(control(tree, "Aufnahme abspielen").props.disabled).toBe(false);
});

it("seeks in milliseconds, clamps skips and changes the native playback speed", () => {
  props.blob = new Blob(["audio"]);
  view();
  flush();
  Object.assign(media, { duration: 42.5 });
  let tree = event("onLoadedMetadata");
  const range = () =>
    nodes(tree).find((n) => n.type === "input" && n.props.type === "range")!;
  expect(range().props.max).toBe(42_500);
  expect(range().props.step).toBe(100);
  range().props.onChange({ currentTarget: { value: "36000" } });
  expect(media.currentTime).toBe(36);
  expect(time).toHaveBeenLastCalledWith(36_000);
  expect(media.play).not.toHaveBeenCalled(); // Moving an already loaded playhead doesn't force play.
  tree = view();
  control(tree, "10 Sekunden vor").props.onClick();
  expect(media.currentTime).toBe(42.5);
  tree = view();
  control(tree, "10 Sekunden zurück").props.onClick();
  expect(media.currentTime).toBe(32.5);
  tree = view();
  range().props.onChange({ currentTarget: { value: "3000" } });
  tree = view();
  control(tree, "10 Sekunden zurück").props.onClick();
  expect(media.currentTime).toBe(0);
  tree = view();
  const speed = nodes(tree).find(
    (n) =>
      n.type === "select" &&
      n.props["aria-label"] === "Wiedergabegeschwindigkeit",
  )!;
  expect(
    nodes(speed)
      .filter((n) => n.type === "option")
      .map((n) => Number(n.props.value)),
  ).toEqual([1, 1.25, 1.5, 2]);
  speed.props.onChange({ currentTarget: { value: "1.5" } });
  expect(media.playbackRate).toBe(1.5);
  expect(request).not.toHaveBeenCalled();
});

it("catches rejected native play and lets a user retry without another provider load", async () => {
  props.blob = new Blob(["audio"]);
  view();
  flush();
  Object.assign(media, { duration: 90 });
  let tree = event("onLoadedMetadata");
  vi.mocked(media.play).mockRejectedValueOnce(
    new DOMException("blocked", "NotAllowedError"),
  );
  await expect(
    control(tree, "Aufnahme abspielen").props.onClick(),
  ).resolves.toBeUndefined();
  tree = view();
  expect(text(tree)).toContain("Wiedergabe konnte nicht gestartet werden");
  expect(control(tree, "Aufnahme abspielen").props.disabled).toBe(false);
  await control(tree, "Aufnahme abspielen").props.onClick();
  expect(media.play).toHaveBeenCalledTimes(2);
  expect(request).not.toHaveBeenCalled();
});

it("explains an unsupported format and retries the existing blob without another download", async () => {
  props.blob = new Blob(["unsupported"], { type: "audio/example" });
  view();
  flush();
  Object.assign(media, { error: { code: 4 } });
  let tree = event("onError");
  expect(text(tree)).toContain(
    "Dieses Audioformat kann hier nicht wiedergegeben werden",
  );
  expect(
    nodes(tree).find((n) => n.type === "input" && n.props.type === "range")!
      .props.disabled,
  ).toBe(true);
  expect(
    nodes(tree).find((n) => n.type === "section")!.props["aria-busy"],
  ).toBe(false);
  await control(tree, "Aufnahme erneut laden").props.onClick();
  tree = view();
  expect(media.load).toHaveBeenCalledTimes(2);
  expect(createURL).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
  expect(
    nodes(tree).find((n) => n.type === "section")!.props["aria-busy"],
  ).toBe(true);
});

it("keeps playback usable without a finite duration and reports real buffering and seek events", () => {
  props.blob = new Blob(["webm"]);
  props.durationMs = 0;
  view();
  flush();
  Object.assign(media, { duration: Infinity });
  let tree = event("onLoadedMetadata");
  expect(ready).toHaveBeenCalledExactlyOnceWith(media);
  expect(control(tree, "Aufnahme abspielen").props.disabled).toBe(false);
  expect(
    nodes(tree).find((n) => n.type === "input" && n.props.type === "range")!
      .props.disabled,
  ).toBe(true);
  expect(text(tree)).toContain("Dauer nicht verfügbar");
  tree = event("onWaiting");
  expect(text(tree)).toContain("Audio wird gepuffert");
  tree = event("onPlaying");
  expect(text(tree)).toContain("Wiedergabe läuft");
  tree = event("onSeeking");
  expect(text(tree)).toContain("Springe zur Position");
  Object.assign(media, { currentTime: 4.75 });
  tree = event("onSeeked");
  expect(time).toHaveBeenLastCalledWith(4750);
  expect(text(tree)).toContain("0:04");
  Object.assign(media, { paused: true, ended: true });
  tree = event("onEnded");
  expect(playback).toHaveBeenLastCalledWith(false);
});

it("does not invent elapsed progress while a chosen unloaded position is requested", async () => {
  view();
  let tree = flush();
  const range = nodes(tree).find(
    (n) => n.type === "input" && n.props.type === "range",
  )!;
  await range.props.onChange({ currentTarget: { value: "25000" } });
  expect(request).toHaveBeenCalledExactlyOnceWith(25_000);
  expect(time).not.toHaveBeenCalledWith(25_000);
  expect(
    nodes(view()).find((n) => n.type === "input" && n.props.type === "range")!
      .props.value,
  ).toBe(0);
  props.loading = true;
  tree = view();
  expect(control(tree, "Aufnahme abspielen").props.disabled).toBe(true);
  expect(text(tree)).toContain("Aufnahme wird geladen");
  expect(createURL).not.toHaveBeenCalled();
});

it("reports an unsupported seek without moving the displayed playhead", () => {
  props.blob = new Blob(["non-seekable"]);
  view();
  flush();
  Object.assign(media, { duration: Infinity }); // Known saved duration is the honest fallback.
  let tree = event("onLoadedMetadata");
  expect(
    nodes(tree).find((n) => n.type === "input" && n.props.type === "range")!
      .props.max,
  ).toBe(90_000);
  Object.defineProperty(media, "currentTime", {
    configurable: true,
    get: () => 0,
    set: () => {
      throw new DOMException("no seek", "InvalidStateError");
    },
  });
  const range = nodes(tree).find(
    (n) => n.type === "input" && n.props.type === "range",
  )!;
  expect(() =>
    range.props.onChange({ currentTarget: { value: "15000" } }),
  ).not.toThrow();
  tree = view();
  expect(text(tree)).toContain(
    "Diese Position kann noch nicht angesprungen werden",
  );
  expect(
    nodes(tree).find((n) => n.type === "input" && n.props.type === "range")!
      .props.value,
  ).toBe(0);
});

it.each(["request", "native"])(
  "ignores a late %s play rejection after unmount",
  async (kind) => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    if (kind === "native") props.blob = new Blob(["audio"]);
    view();
    let tree = flush();
    if (kind === "native") {
      Object.assign(media, { duration: 90 });
      tree = event("onLoadedMetadata");
      vi.mocked(media.play).mockReturnValueOnce(pending);
    } else request.mockReturnValueOnce(pending);
    const action = control(tree, "Aufnahme abspielen").props.onClick();
    unmount();
    const updates = h.updates;
    reject(new DOMException("late failure", "NotAllowedError"));
    await action;
    expect(h.updates).toBe(updates);
  },
);

it("contains an asynchronous lazy-seek failure inside the transport", async () => {
  const failed = Promise.reject(new Error("synthetic load failure"));
  void failed.catch(() => {}); // Observe the fixture promise even before the UI handles it.
  request.mockReturnValueOnce(failed);
  view();
  const tree = flush();
  const range = nodes(tree).find(
    (n) => n.type === "input" && n.props.type === "range",
  )!;
  await range.props.onChange({ currentTarget: { value: "25000" } });
  await failed.catch(() => {});
  expect(text(view())).toContain("Aufnahme konnte nicht geladen werden");
  expect(createURL).not.toHaveBeenCalled();
});

it("renders seek progress from native time rather than request or decorative state", () => {
  props.blob = new Blob(["audio"]);
  view();
  flush();
  Object.assign(media, { duration: 90, currentTime: 22.5 });
  event("onLoadedMetadata");
  const tree = event("onTimeUpdate");
  const player = nodes(tree).find((n) => n.type === "section")!;
  expect(player.props.style?.["--audio-progress"]).toBe(
    `${(22.5 / 90) * 100}%`,
  );
  expect(
    nodes(tree).find((n) => n.type === "input" && n.props.type === "range")!
      .props["aria-valuetext"],
  ).toBe("0:22 von 1:30");
});

it("contains a rejected parent ready/play handoff and leaves manual playback available", async () => {
  const failed = Promise.reject(
    new DOMException("blocked handoff", "NotAllowedError"),
  );
  void failed.catch(() => {});
  ready.mockReturnValueOnce(failed);
  props.blob = new Blob(["audio"]);
  view();
  flush();
  Object.assign(media, { duration: 90 });
  event("onLoadedMetadata");
  await failed.catch(() => {});
  const tree = view();
  expect(text(tree)).toContain("Wiedergabe konnte nicht gestartet werden");
  expect(control(tree, "Aufnahme abspielen").props.disabled).toBe(false);
});
