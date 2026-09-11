import { describe, expect, it, vi } from "vitest";
import {
  TranscriptAssembler,
  formatTimestamp,
  parseTimestamp,
  parseTranscript,
  toTimestamped,
} from "./transcriptAssembler";

const segment = (name: string) => new Blob([name], { type: "audio/webm" });

describe("transcript assembler", () => {
  it("appends continuations in recording order even when calls resolve out of order", async () => {
    const resolvers: ((text: string) => void)[] = [];
    const assembler = new TranscriptAssembler(
      () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );
    assembler.push(segment("a"));
    assembler.push(segment("b"));

    // Only the first segment may be in flight: the second needs its result as context.
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0]("erster Teil");
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]("zweiter Teil");
    await assembler.settled();

    expect(assembler.transcript).toBe("erster Teil zweiter Teil");
  });

  it("stamps each appended stretch with where its speech starts", async () => {
    const assembler = new TranscriptAssembler(
      vi.fn().mockResolvedValueOnce("Guten Morgen.").mockResolvedValueOnce("Zum Budget."),
    );
    assembler.push(segment("a"), 0);
    assembler.push(segment("b"), 50_000);
    await assembler.settled();

    // Single source, so no speaker label — see the mic-only case above.
    expect(toTimestamped(assembler.entries)).toBe(
      "[0:00] Guten Morgen.\n\n[0:50] Zum Budget.",
    );
    // Model context stays free of timestamps so overlap matching is unaffected.
    expect(assembler.transcript).toBe("Guten Morgen. Zum Budget.");
  });

  it.each([
    ["0:00", 0],
    ["0:50", 50_000],
    ["10:05", 605_000],
    ["1:02:05", 3_725_000],
  ])("reads %s back as %ims", (at, ms) => {
    expect(parseTimestamp(at as string)).toBe(ms);
  });

  it.each(["", "abc", "12", "1:2:3", "0:60:00:00:00:00"])(
    "rejects %s as a timestamp rather than guessing",
    (at) => {
      expect(parseTimestamp(at)).toBeNull();
    },
  );

  it.each([
    [0, "0:00"],
    [50_000, "0:50"],
    [605_000, "10:05"],
    [3_725_000, "1:02:05"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatTimestamp(ms)).toBe(expected);
  });

  it("omits the speaker label when only one source was captured", async () => {
    // On a phone there is no system audio, so claiming "Du" would assert a
    // separation that was never made.
    const mic = new TranscriptAssembler(
      vi.fn().mockResolvedValue("Nur ich rede hier."),
      () => {},
      "mic",
    );
    mic.push(segment("a"), 0);
    await mic.settled();

    const rendered = toTimestamped(mic.entries);
    expect(rendered).toBe("[0:00] Nur ich rede hier.");
    expect(rendered).not.toContain("(Du)");
    // Still parses, just without a source.
    expect(parseTranscript(rendered)).toEqual([
      { at: "0:00", source: null, text: "Nur ich rede hier." },
    ]);
  });

  it("keeps each source's entries labelled and ordered by time", async () => {
    const mic = new TranscriptAssembler(
      vi.fn().mockResolvedValue("Ich frage nach dem Budget."),
      () => {},
      "mic",
    );
    const system = new TranscriptAssembler(
      vi.fn().mockResolvedValue("Das Budget ist freigegeben."),
      () => {},
      "system",
    );
    mic.push(segment("a"), 0);
    system.push(segment("b"), 12_000);
    await Promise.all([mic.settled(), system.settled()]);

    const merged = toTimestamped([...mic.entries, ...system.entries]);
    expect(merged).toBe(
      "[0:00] (Du) Ich frage nach dem Budget.\n\n" +
        "[0:12] (Andere) Das Budget ist freigegeben.",
    );
    // Round-trips through the stored string form for the chat view.
    expect(parseTranscript(merged)).toEqual([
      { at: "0:00", source: "mic", text: "Ich frage nach dem Budget." },
      { at: "0:12", source: "system", text: "Das Budget ist freigegeben." },
    ]);
  });

  it("keeps one source's overlap context out of the other's", async () => {
    const micTranscribe = vi.fn().mockResolvedValue("Mikrofontext");
    const mic = new TranscriptAssembler(micTranscribe, () => {}, "mic");
    const system = new TranscriptAssembler(
      vi.fn().mockResolvedValue("Systemtext"),
      () => {},
      "system",
    );
    system.push(segment("s"), 0);
    await system.settled();
    mic.push(segment("m"), 0);
    await mic.settled();
    expect(micTranscribe.mock.calls[0][1]).toBe("");
  });

  it("gives each segment the transcript built so far as overlap context", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce("Guten Morgen.")
      .mockResolvedValueOnce("Zum Budget.");
    const assembler = new TranscriptAssembler(transcribe);
    assembler.push(segment("a"));
    assembler.push(segment("b"));
    await assembler.settled();

    expect(transcribe.mock.calls[0][1]).toBe("");
    expect(transcribe.mock.calls[1][1]).toBe("Guten Morgen.");
    expect(assembler.transcript).toBe("Guten Morgen. Zum Budget.");
  });

  it("keeps transcribing after a failed segment and counts the gap", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce("vorher")
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce("nachher");
    const assembler = new TranscriptAssembler(transcribe);
    for (const name of ["a", "b", "c"]) assembler.push(segment(name));
    await assembler.settled();

    expect(assembler.transcript).toBe("vorher nachher");
    expect(assembler.failedSegments).toBe(1);
    // A lost segment must not poison the context of the following one.
    expect(transcribe.mock.calls[2][1]).toBe("vorher");
  });

  it("ignores empty output and empty segments without notifying", async () => {
    const onChange = vi.fn();
    const transcribe = vi.fn().mockResolvedValue("   ");
    const assembler = new TranscriptAssembler(transcribe, onChange);
    assembler.push(new Blob([], { type: "audio/webm" }));
    assembler.push(segment("a"));
    await assembler.settled();

    expect(transcribe).toHaveBeenCalledOnce();
    expect(assembler.transcript).toBe("");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports outstanding work so the recording can wait before analysing", async () => {
    let release!: (text: string) => void;
    const assembler = new TranscriptAssembler(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    assembler.push(segment("a"));
    expect(assembler.pendingSegments).toBe(1);

    await vi.waitFor(() => expect(release).toBeDefined());
    release("fertig");
    await assembler.settled();
    expect(assembler.pendingSegments).toBe(0);
  });
});
