import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeetingTranscript } from "../../shared/transcription";

const h = vi.hoisted(() => ({ slots: [] as any[], cursor: 0 }));
vi.mock("react", async (load) => ({
  ...(await load<typeof import("react")>()),
  useState: (initial: any) => {
    const index = h.cursor++;
    if (!(index in h.slots))
      h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[index],
      (next: any) => {
        h.slots[index] =
          typeof next === "function" ? next(h.slots[index]) : next;
      },
    ];
  },
  useMemo: (compute: () => unknown) => compute(),
}));
import TranscriptChat from "./TranscriptChat";
import TranscriptTimeline from "./TranscriptTimeline";
import LiveSpeakers from "./LiveSpeakers";
import InlineSpeakerName from "./InlineSpeakerName";

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
function passages(tree: React.ReactNode) {
  return nodes(tree).filter(
    (n) =>
      n.type === "div" && n.props.className?.split(" ").includes("chat-turn"),
  );
}
function timeline(props: React.ComponentProps<typeof TranscriptTimeline>) {
  h.cursor = 0;
  return TranscriptTimeline(props);
}
function screenChat(tree: React.ReactNode) {
  return nodes(tree).find(
    (n) => n.type === TranscriptChat && n.props.renderText,
  )!;
}
const speech: MeetingTranscript = {
  provider: "assemblyai",
  phase: "final",
  languages: ["de"],
  speakerNames: { "mic:a": "Alex", "system:b": "Sam" },
  turns: [
    {
      id: "mic:1",
      speaker: "mic:a",
      startMs: 1250,
      endMs: 12000,
      text: "Planung zuerst",
      final: true,
    },
    {
      id: "system:1",
      speaker: "system:b",
      startMs: 6000,
      endMs: 18000,
      text: "Antwort aus dem System",
      final: true,
    },
    {
      id: "batch:2",
      speaker: "batch:unknown",
      startMs: 18000,
      endMs: 23000,
      text: "Offene Stimme",
      final: true,
    },
  ],
};
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("gives each known timestamp a visible icon/time play action with millisecond callbacks", () => {
  const listen = vi.fn();
  const tree = TranscriptChat({
    transcript:
      "[0:12] (Sprecher A) Erste Passage\n\nOhne bekannte Zeit\n\n[1:02:03] Zweite Passage",
    onListen: listen,
    variant: "document",
  });
  const play = nodes(tree).filter((n) => n.type === "button");
  expect(play).toHaveLength(2);
  expect(text(play[0])).toContain("Abspielen");
  expect(text(play[0])).toContain("0:12");
  expect(play[0].props.className).toContain("transcript-play");
  expect(play[0].props["aria-label"]).toContain("12 Sekunden");
  expect(renderToStaticMarkup(<>{play[0]}</>)).toContain("lucide-play");
  play[0].props.onClick();
  play[1].props.onClick();
  expect(listen.mock.calls).toEqual([[12_000], [3_723_000]]);
  const unknown = passages(tree).find((n) =>
    text(n).includes("Ohne bekannte Zeit"),
  )!;
  expect(nodes(unknown).some((n) => n.type === "button")).toBe(false);
  expect(text(unknown)).toContain("Ohne Zeitmarke");
  expect(tree.props.className).toContain("is-document");
});

it("tracks actual playback using exact saved offsets and unfiltered next-turn bounds", () => {
  const listen = vi.fn();
  const render = (
    extra: Partial<React.ComponentProps<typeof TranscriptChat>> = {},
  ) =>
    TranscriptChat({
      transcript: "",
      speech,
      variant: "document",
      onListen: listen,
      positionMs: 5000,
      playing: true,
      ...extra,
    });
  let tree = render();
  let active = passages(tree).filter((n) => n.props["aria-current"] === "time");
  expect(active).toHaveLength(1);
  expect(text(active[0])).toContain("Planung zuerst");
  expect(active[0].props.className).toContain("is-playing");
  expect(text(active[0])).toContain("Läuft");
  nodes(active[0])
    .find((n) => n.type === "button")!
    .props.onClick();
  expect(listen).toHaveBeenCalledWith(1250); // Display text must not round away provider milliseconds.
  tree = render({ positionMs: 6000 });
  expect(
    text(passages(tree).find((n) => n.props["aria-current"] === "time")),
  ).toContain("Antwort aus dem System");
  tree = render({ filter: "mic", positionMs: 7000 });
  expect(passages(tree).some((n) => n.props["aria-current"] === "time")).toBe(
    false,
  );
  tree = render({ query: "Planung", positionMs: 7000 });
  expect(passages(tree).some((n) => n.props["aria-current"] === "time")).toBe(
    false,
  );
  tree = render({ positionMs: 5000, playing: false });
  active = passages(tree).filter((n) => n.props["aria-current"] === "time");
  expect(active).toHaveLength(1);
  expect(active[0].props.className).not.toContain("is-playing");
  expect(text(active[0])).toContain("Aktuelle Position");
  expect(
    passages(render({ positionMs: 24_000 })).some(
      (n) => n.props["aria-current"] === "time",
    ),
  ).toBe(false);
  expect(
    passages(render({ positionMs: undefined })).some(
      (n) => n.props["aria-current"] === "time",
    ),
  ).toBe(false);
});

it("uses document rows in the finished timeline while filters never narrow copy or print", async () => {
  vi.useFakeTimers();
  const copy = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  const props = {
    transcript: "Gesamter Originaltext einschließlich ausgeblendeter Passagen",
    speech,
    onListen: vi.fn(),
    onRename: vi.fn(),
    onEditTurn: vi.fn(),
    positionMs: 5000,
    playing: true,
  };
  let tree = timeline(props);
  expect(screenChat(tree).props.variant).toBe("document");
  expect(screenChat(tree).props.positionMs).toBe(5000);
  expect(screenChat(tree).props.playing).toBe(true);
  nodes(tree)
    .find(
      (n) =>
        n.type === "input" && n.props["aria-label"] === "Im Transkript suchen",
    )!
    .props.onChange({ target: { value: "Planung" } });
  nodes(tree)
    .find((n) => n.type === LiveSpeakers)!
    .props.onFilter("mic");
  tree = timeline(props);
  const visible = screenChat(tree);
  expect(visible.props.query).toBe("Planung");
  expect(visible.props.filter).toBe("mic");
  const document = TranscriptChat(visible.props);
  expect(passages(document)).toHaveLength(1);
  expect(
    nodes(document)
      .filter((n) => n.type === "mark")
      .map((n) => text(n)),
  ).toEqual(["Planung"]);
  const print = nodes(tree).find(
    (n) => n.props.className === "report-transcript-print",
  )!;
  const full = nodes(print).find((n) => n.type === TranscriptChat)!;
  expect(full.props.variant).toBe("document");
  expect(full.props.filter).toBeUndefined();
  expect(full.props.query).toBeUndefined();
  expect(full.props.onListen).toBeUndefined();
  expect(full.props.positionMs).toBeUndefined();
  expect(passages(TranscriptChat(full.props))).toHaveLength(3);
  const copyButton = nodes(tree).find(
    (n) => n.type === "button" && text(n) === "Gesamtes Transkript kopieren",
  )!;
  await copyButton.props.onClick();
  expect(copy).toHaveBeenCalledExactlyOnceWith(props.transcript);
  expect(text(timeline(props))).toContain("Kopiert");
  vi.runAllTimers();
});

it("keeps unknown timing honest instead of displaying a fabricated seek target", () => {
  const invalidSeconds = TranscriptChat({
    transcript: "[0:99] Keine gültige Zeitmarke",
    variant: "document",
    onListen: vi.fn(),
  });
  expect(nodes(invalidSeconds).some((n) => n.type === "button")).toBe(false);
  expect(text(invalidSeconds)).toContain("Ohne Zeitmarke");
  const malformed = TranscriptChat({
    transcript: "[1:02:03:04] Keine sichere Zeit",
    variant: "document",
    onListen: vi.fn(),
    positionMs: 0,
  });
  expect(nodes(malformed).some((n) => n.type === "button")).toBe(false);
  expect(text(malformed)).toContain("Ohne Zeitmarke");
  const damaged: MeetingTranscript = {
    ...speech,
    turns: [{ ...speech.turns[0], startMs: NaN }],
  };
  const unknown = TranscriptChat({
    transcript: "",
    speech: damaged,
    variant: "document",
    onListen: vi.fn(),
    positionMs: 0,
  });
  expect(nodes(unknown).some((n) => n.type === "button")).toBe(false);
  expect(text(unknown)).toContain("Ohne Zeitmarke");
  expect(text(unknown)).not.toContain("NaN");
  expect(passages(unknown).some((n) => n.props["aria-current"])).toBe(false);
});

it("retains source evidence, unknown-speaker wording, rename and turn correction", () => {
  const rename = vi.fn(),
    edit = vi.fn(),
    editing = vi.fn();
  const tree = TranscriptChat({
    transcript: "",
    speech,
    variant: "document",
    onRename: rename,
    onEditTurn: edit,
    onEditing: editing,
  });
  const rows = passages(tree);
  expect(text(rows[0])).toContain("Mikrofon");
  expect(text(rows[1])).toContain("Systemaudio");
  expect(text(rows[2])).toContain("Audioquelle offen");
  expect(text(rows[2])).toContain("Stimme nicht zugeordnet");
  expect(nodes(rows[2]).some((n) => n.type === InlineSpeakerName)).toBe(false);
  const name = nodes(rows[0]).find((n) => n.type === InlineSpeakerName)!;
  expect(name.props.id).toBe("mic:a");
  expect(name.props.onRename).toBe(rename);
  expect(name.props.onEditing).toBe(editing);
  nodes(rows[1])
    .find((n) => n.type === "button" && text(n) === "Korrigieren")!
    .props.onClick();
  expect(edit).toHaveBeenCalledWith("system:1");
  const live = TranscriptChat({
    transcript: "",
    speech: { ...speech, phase: "live" },
  });
  expect(live.props.className).toContain("is-live");
  expect(renderToStaticMarkup(<>{live}</>)).toContain("chat-turn is-mic");
  expect(renderToStaticMarkup(<>{live}</>)).toContain("chat-turn is-system");
});
