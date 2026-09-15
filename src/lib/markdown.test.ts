import { describe, expect, it } from "vitest";
import { consentToMarkdown, reportToMarkdown } from "./markdown";
import { buildConsentRecord, consentFacts } from "../../shared/consent";

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

const consent = (
  over: Partial<Parameters<typeof buildConsentRecord>[1]> = {},
  folderName = "CheatMeet Recordings (App)",
) =>
  buildConsentRecord(
    consentFacts({
      sources: ["mic", "system"],
      folderName,
      retention: { audioDays: 30, textDays: null },
      recipients: ["Anna"],
    }),
    {
      obtainedAt: "2026-09-15T12:00:00.000Z",
      method: "spoken",
      allInformed: true,
      ...over,
    },
  );

describe("consentToMarkdown", () => {
  it("records what was said, byte for byte", () => {
    const record = consent();
    // A notice containing Markdown must come back out as text, not as markup.
    const tricky = {
      ...record,
      text: "# Kurz vorab\n- Punkt eins mit ``` im Text",
    };
    expect(consentToMarkdown(tricky)).toContain(
      "# Kurz vorab\n- Punkt eins mit ``` im Text",
    );
  });

  it("carries every fact a reader needs in the frontmatter", () => {
    const md = consentToMarkdown(consent());
    for (const key of [
      "schema:",
      "template_version:",
      "obtained_at:",
      "language:",
      "method:",
      "all_informed:",
      "participants:",
      "objections:",
      "sources:",
      "recipients:",
      "retention_audio_days:",
      "retention_text_days:",
    ])
      expect(md, key).toContain(key);
    expect(md).toContain("retention_audio_days: 30");
    // Indefinite retention is a decision, not a missing value.
    expect(md).toContain("retention_text_days: null");
    expect(md).toContain('sources: ["mic", "system"]');
  });

  it("distinguishes nothing recorded from nothing to record", () => {
    // No participants and no objections were captured: both say so explicitly.
    expect(consentToMarkdown(consent())).toContain("participants: null");
    expect(consentToMarkdown(consent())).toContain("objections: null");
    const withObjection = consentToMarkdown(
      consent({ objections: "Sergio wollte nicht aufgenommen werden" }),
    );
    expect(withObjection).toContain('objections: "Sergio wollte nicht');
    expect(rendered(withObjection)).toContain(
      "- Widerspruch: Sergio wollte nicht aufgenommen werden",
    );
  });

  it("escapes YAML, not Markdown, in the frontmatter", () => {
    const md = consentToMarkdown(
      consent({ participants: ['Anna "die Chefin": Müller – Wien'] }),
    );
    expect(md).toContain(
      'participants: ["Anna \\"die Chefin\\": Müller – Wien"]',
    );
  });

  it("gives every required element its own heading", () => {
    const md = consentToMarkdown(consent());
    for (const headline of [
      "## Wortlaut",
      "## Zweck",
      "## Technische Mittel",
      "## Speicherort und Empfänger",
      "## Aufbewahrung",
      "## Frage nach der Zustimmung",
      "## Dokumentation",
    ])
      expect(md, headline).toContain(headline);
  });
});

describe("the consent link on a report", () => {
  it("appears once the file exists and not before", () => {
    expect(reportToMarkdown(report())).not.toContain("[Einwilligung]");
    expect(
      reportToMarkdown(report({ driveConsentId: "einwilligung-id" })),
    ).toContain("[Einwilligung](https://drive.google.com/file/d/einwilligung-id/view)");
  });
});
