import { describe, expect, it } from "vitest";
import { reportToMarkdown } from "./markdown";

/** What a reader sees: the escaping is deliberately paranoid, and `\.` is `.`. */
const rendered = (md: string) => md.replace(/\\(.)/g, "$1");
import type { ReportData } from "../types";

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: "2026-09-14T08:30:00.000Z",
  title: "Weekly Sync",
  summary: "Roadmap besprochen.",
  transcription: "",
  todos: [],
  takeaways: [],
  ...over,
});

describe("reportToMarkdown", () => {
  it("emits real checkbox syntax, not an escaped literal", () => {
    const md = reportToMarkdown(
      report({ todos: [{ text: "Angebot senden" }, { text: "Erledigt", done: true }] }),
    );
    expect(md).toContain("- [ ] Angebot senden");
    expect(md).toContain("- [x] Erledigt");
    expect(md).not.toContain("\\-");
    expect(md).not.toContain("\\[");
  });

  it("keeps the owner and due date on the task line", () => {
    const md = reportToMarkdown(
      report({ todos: [{ text: "Angebot", owner: "Anna", due: "2026-09-30" }] }),
    );
    expect(rendered(md)).toContain("- [ ] Angebot @Anna bis 2026-09-30");
  });

  it("still escapes Markdown metacharacters inside the task text", () => {
    const md = reportToMarkdown(report({ todos: [{ text: "Preis [netto] prüfen" }] }));
    expect(md).toMatch(/^- \[ \] /m);
    expect(md).toContain("\\[netto\\]");
  });

  it("carries the title, summary and takeaways", () => {
    const md = reportToMarkdown(report({ takeaways: ["Launch verschiebt sich"] }));
    expect(rendered(md)).toContain("Weekly Sync");
    expect(rendered(md)).toContain("Roadmap besprochen.");
    expect(rendered(md)).toContain("- Launch verschiebt sich");
  });

  it("omits sections it has nothing for", () => {
    const md = reportToMarkdown(report());
    expect(md).not.toContain("Aufgaben (To-Dos)");
    expect(md).not.toContain("Wichtigste Erkenntnisse");
  });

  it("survives a date it cannot parse instead of printing Invalid Date", () => {
    expect(reportToMarkdown(report({ date: "irgendwann" }))).not.toContain(
      "Invalid Date",
    );
  });
});
