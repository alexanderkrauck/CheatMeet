import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./firebase", () => ({
  auth: { currentUser: { getIdToken: async () => "token" } },
}));

const { draftConsentNotice } = await import("./consentDraft");
const { consentFacts, assembleConsentText } = await import("../../shared/consent");

const facts = consentFacts({
  sources: ["mic", "system"],
  folderName: "Ordner",
  retention: { audioDays: 30, textDays: null },
});

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status < 400,
      status,
      json: async () => body,
    }),
  );

beforeEach(() => vi.unstubAllGlobals());

describe("draftConsentNotice", () => {
  it("sends the facts and the situation the user described", async () => {
    respond(200, { parts: { opening: "Kurz vorab:" } });
    await draftConsentNotice(facts, ["Sergio von StackFuel, Verkaufsgespräch"]);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/consent-notice");
    const sent = JSON.parse(init.body as string);
    expect(sent.facts.sources).toEqual(["mic", "system"]);
    expect(sent.instructions).toEqual([
      "Sergio von StackFuel, Verkaufsgespräch",
    ]);
  });

  it("keeps only phrasing for elements the notice actually has", async () => {
    respond(200, {
      parts: { opening: "  Kurz vorab:  ", boshaft: "<script>", ask: "" },
    });
    const parts = await draftConsentNotice(facts, []);

    expect(parts).toEqual({ opening: "Kurz vorab:" });
    // The assembled notice still carries every required element.
    expect(assembleConsentText(facts, parts)).toContain(
      "Die Aufnahme lösche ich nach 30 Tagen",
    );
  });

  it("reports a refusal in German instead of silently using nothing", async () => {
    respond(503, { error: "KI ist noch nicht eingerichtet." });
    await expect(draftConsentNotice(facts, [])).rejects.toThrow(
      /nicht eingerichtet/,
    );
  });

  it("treats an empty response as a failure, not as an empty notice", async () => {
    respond(200, { parts: {} });
    await expect(draftConsentNotice(facts, [])).rejects.toThrow(
      /Standardtext bleibt gültig/,
    );
  });
});
