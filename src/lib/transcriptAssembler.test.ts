import { describe, expect, it, vi } from "vitest";
import { TranscriptAssembler } from "./transcriptAssembler";

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
