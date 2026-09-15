import { describe, expect, it } from "vitest";
import { asTodos, formatTodoLine, parseTodoLine, validateAnalysis } from "./analysis";

describe("asTodos", () => {
  it("upgrades the legacy string form without losing the text", () => {
    expect(asTodos(["Angebot senden", "  Termin fixieren  "])).toEqual([
      { text: "Angebot senden" },
      { text: "Termin fixieren" },
    ]);
  });
  it("keeps owner and a real due date, and drops a fake one", () => {
    expect(
      asTodos([
        { text: "Angebot", owner: "Anna", due: "2026-09-30" },
        { text: "Termin", due: "nächste Woche" },
        { text: "Rechnung", due: "2026-13-01" },
      ]),
    ).toEqual([
      { text: "Angebot", owner: "Anna", due: "2026-09-30" },
      { text: "Termin" },
      { text: "Rechnung" },
    ]);
  });
  it("only carries `done` when it is actually true", () => {
    expect(asTodos([{ text: "a", done: true }, { text: "b", done: false }])).toEqual([
      { text: "a", done: true },
      { text: "b" },
    ]);
  });
  it("drops entries with no text at all, whatever shape they arrive in", () => {
    expect(asTodos(["", "   ", {}, { text: "  " }, null, 42, { text: "ok" }])).toEqual([
      { text: "ok" },
    ]);
  });
  it("is empty for anything that is not a list", () => {
    expect(asTodos(undefined)).toEqual([]);
    expect(asTodos("Angebot")).toEqual([]);
  });
});

describe("formatTodoLine / parseTodoLine", () => {
  it("round-trips text, owner and due date", () => {
    const todo = { text: "Angebot senden", owner: "Anna", due: "2026-09-30" };
    expect(formatTodoLine(todo)).toBe("Angebot senden @Anna bis 2026-09-30");
    expect(parseTodoLine(formatTodoLine(todo))).toEqual(todo);
  });
  it("round-trips a bare task", () => {
    expect(parseTodoLine(formatTodoLine({ text: "Aufräumen" }))).toEqual({
      text: "Aufräumen",
    });
  });
  it("accepts a Markdown checkbox line and reads its state from the caller", () => {
    expect(parseTodoLine("- [x] Angebot senden", true)).toEqual({
      text: "Angebot senden",
      done: true,
    });
    expect(parseTodoLine("- Angebot senden")).toEqual({ text: "Angebot senden" });
  });
  it("leaves an e-mail address alone rather than reading it as an owner", () => {
    expect(parseTodoLine("Anna anschreiben @Anna")).toEqual({
      text: "Anna anschreiben",
      owner: "Anna",
    });
    expect(parseTodoLine("Antwort an anna@example.com schicken")).toMatchObject({
      text: "Antwort an anna@example.com schicken",
    });
  });
  it("ignores a due date that is not a real day", () => {
    expect(parseTodoLine("Angebot bis 2026-99-01")).toEqual({
      text: "Angebot bis 2026-99-01",
    });
  });
  it("is null for an empty line", () => {
    expect(parseTodoLine("")).toBe(null);
    expect(parseTodoLine("- [ ]   ")).toBe(null);
  });
});

describe("validateAnalysis", () => {
  const ok = { title: "T", summary: "S", todos: [], takeaways: [] };
  it("normalises whatever shape the model returns for todos", () => {
    expect(
      validateAnalysis({ ...ok, todos: ["a", { text: "b", owner: "Anna" }] }).todos,
    ).toEqual([{ text: "a" }, { text: "b", owner: "Anna" }]);
  });
  it("still rejects an incomplete report", () => {
    expect(() => validateAnalysis({ ...ok, title: "" })).toThrow();
    expect(() => validateAnalysis({ ...ok, todos: "keine" })).toThrow();
  });
});
