import { describe, expect, it } from "vitest";
import { mergeDescription, summaryBlock, toEvent } from "./calendar";

describe("toEvent", () => {
  const raw = {
    id: "e1",
    summary: "  Weekly Sync  ",
    start: { dateTime: "2026-09-14T09:00:00.000Z" },
    end: { dateTime: "2026-09-14T10:00:00.000Z" },
    attendees: [
      { displayName: "Anna Berger" },
      { email: "ben.klein@example.com" },
      { displayName: "Ich", self: true },
      { displayName: "Raum A", resource: true },
    ],
  };

  it("keeps the people and drops rooms and yourself", () => {
    expect(toEvent(raw, "primary")?.attendees).toEqual(["Anna Berger", "ben klein"]);
  });
  it("normalises the title and the times", () => {
    const event = toEvent(raw, "primary")!;
    expect(event.title).toBe("Weekly Sync");
    expect(event.startMs).toBe(Date.parse("2026-09-14T09:00:00.000Z"));
    expect(event.endMs).toBe(Date.parse("2026-09-14T10:00:00.000Z"));
  });
  it("reads an all-day date as a local day, not as UTC midnight", () => {
    const event = toEvent({ id: "e2", start: { date: "2026-09-14" } }, "primary");
    expect(event?.startMs).toBe(new Date(2026, 8, 14).getTime());
    expect(event?.endMs).toBe(event?.startMs);
  });
  it("skips cancelled events and anything without an id or a start", () => {
    expect(toEvent({ ...raw, status: "cancelled" }, "primary")).toBe(null);
    expect(toEvent({ summary: "x", start: { dateTime: "2026-09-14T09:00:00Z" } }, "primary")).toBe(null);
    expect(toEvent({ id: "e3" }, "primary")).toBe(null);
  });
  it("falls back to a title rather than rendering nothing", () => {
    expect(toEvent({ id: "e4", start: { dateTime: "2026-09-14T09:00:00Z" } }, "primary")?.title)
      .toBe("Ohne Titel");
  });
});

describe("mergeDescription", () => {
  const block = "Zusammenfassung";

  it("keeps what the organiser wrote", () => {
    const merged = mergeDescription("Bitte Unterlagen mitbringen.", block);
    expect(merged).toContain("Bitte Unterlagen mitbringen.");
    expect(merged).toContain("--- CheatMeet ---");
    expect(merged).toContain(block);
  });
  it("replaces its own block instead of stacking duplicates", () => {
    const once = mergeDescription("Agenda", block);
    const twice = mergeDescription(once, "Neue Zusammenfassung");
    expect(twice.match(/--- CheatMeet ---/g)).toHaveLength(1);
    expect(twice).toContain("Agenda");
    expect(twice).toContain("Neue Zusammenfassung");
    expect(twice).not.toContain("ERSTER STAND");
  });
  it("keeps what the organiser wrote BELOW the block", () => {
    const once = mergeDescription("Agenda", block);
    const edited = `${once}\n\nNachtrag: Vertrag ist unterschrieben.`;
    const twice = mergeDescription(edited, "Neue Zusammenfassung");
    expect(twice).toContain("Agenda");
    expect(twice).toContain("Nachtrag: Vertrag ist unterschrieben.");
    expect(twice).toContain("Neue Zusammenfassung");
    expect(twice).not.toContain("Zusammenfassung\n\nNachtrag");
  });
  it("appends rather than guessing when an old block has no end marker", () => {
    const legacy = "Agenda\n\n--- CheatMeet ---\nAlt\n\nWichtig: Raum 3B";
    const merged = mergeDescription(legacy, "Neu");
    // Nothing the organiser wrote is lost, even at the cost of a stale block.
    expect(merged).toContain("Wichtig: Raum 3B");
    expect(merged).toContain("Neu");
  });
  it("does not treat the marker inside the organiser's own prose as a block", () => {
    const text = "Siehe --- CheatMeet --- weiter unten\n\nWichtig: Raum 3B";
    expect(mergeDescription(text, "Neu")).toContain("Wichtig: Raum 3B");
  });
  it("works on an empty description", () => {
    expect(mergeDescription("", block)).toBe(
      `--- CheatMeet ---\n${block}\n--- Ende CheatMeet ---`,
    );
  });
});

describe("summaryBlock", () => {
  it("includes the tasks and the link when there are any", () => {
    const text = summaryBlock({
      summary: "Roadmap besprochen.",
      todos: ["Angebot senden"],
      link: "https://drive.google.com/x",
    });
    expect(text).toContain("Roadmap besprochen.");
    expect(text).toContain("• Angebot senden");
    expect(text).toContain("https://drive.google.com/x");
  });
  it("omits the sections it has nothing for", () => {
    expect(summaryBlock({ summary: "Nur Text.", todos: [] })).toBe("Nur Text.");
  });
});

describe("mergeDescription — marker collisions", () => {
  it("ignores the marker words inside the organiser's own prose", () => {
    const text =
      'Siehe --- CheatMeet --- Block unten besprechen\n\nWichtig: Raum 3B';
    const merged = mergeDescription(text, "Neu");
    expect(merged).toContain("Wichtig: Raum 3B");
    expect(merged).toContain("Siehe --- CheatMeet --- Block unten besprechen");
    expect(merged).toContain("Neu");
  });

  it("replaces the real block even when prose above mentions the marker", () => {
    const text = [
      "Notiz: der --- CheatMeet --- Block kommt automatisch",
      "",
      "--- CheatMeet ---",
      "ERSTER STAND",
      "--- Ende CheatMeet ---",
      "",
      "Nachtrag vom Organisator",
    ].join("\n");
    const merged = mergeDescription(text, "ZWEITER STAND");
    expect(merged).toContain("Notiz: der --- CheatMeet --- Block kommt automatisch");
    expect(merged).toContain("Nachtrag vom Organisator");
    expect(merged).toContain("ZWEITER STAND");
    expect(merged).not.toContain("ERSTER STAND");
  });

  it("is stable when applied repeatedly", () => {
    let text = mergeDescription("Agenda", "A");
    text = mergeDescription(text, "B");
    text = mergeDescription(text, "C");
    expect(text.match(/^--- CheatMeet ---$/gm)).toHaveLength(1);
    expect(text).toContain("Agenda");
    expect(text).toContain("C");
    expect(text).not.toContain("A\n");
  });
});

describe("mergeDescription — HTML line breaks", () => {
  it("recognises its own block after Google rewrites newlines as <br>", () => {
    const plain = mergeDescription("Agenda", "ERSTER STAND");
    // What Google can hand back on the next read.
    const html = plain.replace(/\n/g, "<br>");
    const merged = mergeDescription(html, "ZWEITER STAND");
    expect(merged.match(/--- CheatMeet ---/g)).toHaveLength(1);
    expect(merged).toContain("ZWEITER STAND");
    expect(merged).not.toContain("ERSTER STAND");
  });

  it("does not accumulate a block per sync round", () => {
    let text = mergeDescription("Agenda", "A");
    for (const value of ["B", "C", "D"]) {
      text = mergeDescription(text.replace(/\n/g, "<br>"), value);
    }
    expect(text.match(/--- CheatMeet ---/g)).toHaveLength(1);
    expect(text).toContain("Agenda");
    expect(text).toContain("D");
  });
});

describe("mergeDescription — no accumulation", () => {
  it("does not grow a blank line per sync round", () => {
    let text = mergeDescription("Agenda", "A");
    const rounds: string[] = [];
    for (const value of ["B", "C", "D", "E"]) {
      text = mergeDescription(text.replace(/\n/g, "<br>"), value);
      rounds.push(text);
    }
    // Length must converge, not creep upward with stray <br>s.
    expect(rounds[3].length).toBe(rounds[2].length);
    expect(text.match(/<br>/g) ?? []).toHaveLength(0);
    expect(text).toContain("Agenda");
    expect(text).toContain("E");
  });
});
