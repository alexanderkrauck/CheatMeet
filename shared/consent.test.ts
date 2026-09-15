import { describe, expect, it } from "vitest";
import {
  ASSEMBLYAI_PROCESSOR,
  acceptConsentParts,
  CONSENT_TEMPLATE_VERSION,
  GEMINI_PROCESSOR,
  assembleConsentText,
  buildConsentRecord,
  validateConsentParts,
  consentFacts,
  retentionDays,
  validateConsentRecord,
  type ConsentAddress,
  type ConsentLanguage,
  type ConsentSource,
} from "./consent";

const FOLDER = "CheatMeet Recordings (App)";

const facts = (over: Partial<Parameters<typeof consentFacts>[0]> = {}) =>
  consentFacts({
    sources: ["mic"],
    folderName: FOLDER,
    retention: { audioDays: 30, textDays: null },
    ...over,
  });

const meta = {
  obtainedAt: "2026-09-15T12:00:00.000Z",
  method: "spoken" as const,
  allInformed: true,
};

describe("the notice a real meeting produces", () => {
  const sourceSets: ConsentSource[][] = [["mic"], ["mic", "system"]];
  const audioDays = [30, 1, null];
  const textDays = [null, 90];
  const recipientSets = [[], ["Sergio", "Anna"]];
  const languages: ConsentLanguage[] = ["de", "en"];
  const addresses: ConsentAddress[] = ["du", "sie"];

  for (const sources of sourceSets)
    for (const audio of audioDays)
      for (const text of textDays)
        for (const recipients of recipientSets)
          for (const language of languages)
            for (const address of addresses) {
              const label = `${sources.join("+")} audio=${audio} text=${text} recipients=${recipients.length} ${language}/${address}`;
              it(`covers every required element: ${label}`, () => {
                const result = assembleConsentText(
                  facts({
                    sources,
                    recipients,
                    language,
                    address,
                    retention: { audioDays: audio, textDays: text },
                  }),
                );

                // Purpose.
                expect(result).toContain(
                  language === "de"
                    ? "Ich möchte dieses Gespräch aufzeichnen"
                    : "I'd like to record this conversation",
                );
                // Technical means, including whether others are captured.
                expect(result).toContain(
                  language === "de" ? "Mikrofons" : "microphone",
                );
                if (sources.includes("system"))
                  expect(result).toContain(
                    language === "de"
                      ? "Stimmen der anderen Teilnehmenden"
                      : "other participants",
                  );
                expect(result).toContain("AssemblyAI");
                expect(result).toContain("Google Gemini");
                // Recipients and storage location.
                expect(result).toContain("Google Drive");
                expect(result).toContain(FOLDER);
                if (recipients.length) expect(result).toContain("Sergio");
                // Retention, with the literal number that was promised.
                expect(result).toContain(
                  audio === null
                    ? language === "de"
                      ? "Audioaufnahme bewahre ich unbefristet auf"
                      : "keep the audio recording indefinitely"
                    : language === "de"
                      ? `nach ${audio} ${audio === 1 ? "Tag" : "Tagen"}`
                      : `after ${audio} ${audio === 1 ? "day" : "days"}`,
                );
                if (text !== null)
                  expect(result).toContain(
                    language === "de"
                      ? "Transkript und Zusammenfassung lösche ich"
                      : "delete the transcript and the summary",
                  );
                // The ask always closes the notice.
                expect(result.trim().endsWith("?")).toBe(true);
                if (language === "de")
                  expect(result).toContain(
                    address === "sie" ? "Sind Sie damit" : "Bist du damit",
                  );
              });
            }
});

describe("processors are named only when they actually process", () => {
  it("says no external service when the list is empty", () => {
    const result = assembleConsentText(facts({ processors: [] }));
    expect(result).not.toContain("AssemblyAI");
    expect(result).not.toContain("Gemini");
    expect(result).toContain("von keinem externen Dienst verarbeitet");
  });

  it("names only the processors that are in play", () => {
    const result = assembleConsentText(
      facts({ processors: [ASSEMBLYAI_PROCESSOR] }),
    );
    expect(result).toContain("AssemblyAI (Transkription, Server in der EU)");
    expect(result).not.toContain("Gemini");
  });

  it("does not claim an EU region for the summarising model", () => {
    const result = assembleConsentText(facts({ processors: [GEMINI_PROCESSOR] }));
    expect(result).toContain("Server außerhalb der EU möglich");
  });
});

describe("retentionDays", () => {
  it("rejects anything that is not a whole number of days in range", () => {
    for (const bad of [0.5, -1, 0, 99999, "30", null, undefined, NaN])
      expect(retentionDays(bad)).toBeNull();
  });

  it("passes whole days in range through", () => {
    expect(retentionDays(1)).toBe(1);
    expect(retentionDays(30)).toBe(30);
    expect(retentionDays(3650)).toBe(3650);
  });

  it("renders an unusable value as indefinite rather than as a number", () => {
    const result = assembleConsentText(
      facts({ retention: { audioDays: 0 as number, textDays: null } }),
    );
    expect(result).toContain("Audioaufnahme bewahre ich unbefristet auf");
    expect(result).not.toMatch(/nach \d+ Tag/);
  });
});

describe("consentFacts normalises its inputs", () => {
  it("clamps an overlong folder name", () => {
    expect(facts({ folderName: "x".repeat(400) }).storage.folder).toHaveLength(
      120,
    );
  });

  it("trims recipients, drops the empty ones and caps the list", () => {
    const result = facts({
      recipients: ["  Anna  ", "", "   ", "B", "C", "D", "E", "F", "G"],
    }).recipients;
    expect(result[0]).toBe("Anna");
    expect(result).not.toContain("");
    expect(result).toHaveLength(6);
  });

  it("never reports a recording with no source at all", () => {
    expect(facts({ sources: [] }).sources).toEqual(["mic"]);
  });
});

describe("phrasing overrides", () => {
  it("emits supplied phrasing in order and falls back where blank", () => {
    const base = facts();
    const result = assembleConsentText(base, {
      opening: "Kurz vorab:",
      purpose: "Ich schreibe mit, damit ich dir zuhören kann statt zu tippen.",
      retention: "   ",
    });
    expect(result.startsWith("Kurz vorab: Ich schreibe mit,")).toBe(true);
    // The blank override falls back to the deterministic promise.
    expect(result).toContain("Die Audioaufnahme lösche ich nach 30 Tagen");
    expect(result).not.toContain("Ich möchte dieses Gespräch aufzeichnen");
  });
});

describe("validateConsentRecord", () => {
  const record = () =>
    buildConsentRecord(facts(), { ...meta, participants: ["Sergio"] });

  it("accepts a record it built itself", () => {
    const built = record();
    expect(validateConsentRecord(built)).toBe(built);
    expect(built.templateVersion).toBe(CONSENT_TEMPLATE_VERSION);
  });

  it("accepts a record whose phrasing was overridden", () => {
    const built = buildConsentRecord(facts(), {
      ...meta,
      parts: { opening: "Kurz vorab:" },
    });
    expect(() => validateConsentRecord(built)).not.toThrow();
  });

  it("rejects a blank text", () => {
    expect(() => validateConsentRecord({ ...record(), text: "  " })).toThrow(
      /gesprochene Text fehlt/,
    );
  });

  it("rejects an unreadable timestamp", () => {
    expect(() =>
      validateConsentRecord({ ...record(), obtainedAt: "nicht-ein-datum" }),
    ).toThrow(/Zeitpunkt/);
  });

  it("rejects a missing facts block", () => {
    expect(() =>
      validateConsentRecord({ ...record(), facts: undefined }),
    ).toThrow(/Angaben fehlen/);
  });

  it("rejects a text that no longer covers what it promises", () => {
    const built = record();
    const truncated = built.text.slice(
      0,
      built.text.indexOf("Die Audioaufnahme"),
    );
    expect(() =>
      validateConsentRecord({ ...built, text: truncated }),
    ).toThrow(/retention/);
  });
});

describe("acceptConsentParts", () => {
  const base = facts({ sources: ["mic", "system"] });

  it("keeps a warmer wording that still states the facts", () => {
    const kept = acceptConsentParts(base, {
      opening: "Kurz vorab:",
      purpose: "Ich schreibe mit, damit ich dir zuhören kann.",
      means: `Mikro und Call-Ton, verarbeitet von AssemblyAI und Google Gemini.`,
      recipients: `Alles landet in meinem Drive-Ordner „${FOLDER}“.`,
      retention: "Die Aufnahme lösche ich nach 30 Tagen, den Text behalte ich.",
    });

    expect(Object.keys(kept).sort()).toEqual(
      ["opening", "purpose", "means", "recipients", "retention"].sort(),
    );
  });

  it("drops a retention sentence that names the wrong period", () => {
    const kept = acceptConsentParts(base, {
      retention: "Die Aufnahme lösche ich nach 90 Tagen.",
    });
    expect(kept.retention).toBeUndefined();
  });

  it("drops a deadline invented for audio that is kept indefinitely", () => {
    const indefinite = facts({ retention: { audioDays: null, textDays: null } });
    expect(
      acceptConsentParts(indefinite, {
        retention: "Ich lösche das alles nach 14 Tagen.",
      }).retention,
    ).toBeUndefined();
  });

  it("drops a means sentence that forgets a processor", () => {
    expect(
      acceptConsentParts(base, {
        means: "Aufgenommen wird alles, transkribiert von AssemblyAI.",
      }).means,
    ).toBeUndefined();
  });

  it("drops a means sentence that claims the others are recorded when they are not", () => {
    const micOnly = facts({ sources: ["mic"] });
    expect(
      acceptConsentParts(micOnly, {
        means:
          "Aufgenommen wird der ganze Call mit allen Teilnehmenden, von AssemblyAI und Google Gemini verarbeitet.",
      }).means,
    ).toBeUndefined();
  });

  it("drops a recipients sentence that names no storage location", () => {
    expect(
      acceptConsentParts(base, { recipients: "Das sieht sonst niemand." })
        .recipients,
    ).toBeUndefined();
  });

  it("is what stops a rephrasing from reaching the record", () => {
    const record = buildConsentRecord(base, {
      ...meta,
      parts: { retention: "Gelöscht wird nach 365 Tagen." },
    });

    expect(record.parts).toBeNull();
    // The deterministic promise is spoken instead.
    expect(record.text).toContain("Die Audioaufnahme lösche ich nach 30 Tagen");
    expect(() => validateConsentRecord(record)).not.toThrow();
  });
});

describe("validateConsentParts", () => {
  it("rejects an element too long to be spoken rather than cutting it short", () => {
    const parts = validateConsentParts({ purpose: "x".repeat(601) });
    expect(parts.purpose).toBeUndefined();
    expect(validateConsentParts({ purpose: "x".repeat(600) }).purpose).toHaveLength(600);
  });
});
