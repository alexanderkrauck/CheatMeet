import { expect, it } from "vitest";
import {
  consentFacts,
  assembleConsentText,
  acceptConsentParts,
  decisionFacts,
} from "../../shared/consent";
it("freezes the actual Microsoft storage in consent and rejects a Google-only rephrasing", () => {
  const facts = consentFacts({
    sources: ["mic"],
    folderName: "Meetings",
    retention: { audioDays: 30, textDays: null },
    storageService: "Microsoft OneDrive",
  });
  expect(assembleConsentText(facts)).toContain("Microsoft OneDrive");
  expect(assembleConsentText(facts)).not.toContain("meinem Google Drive");
  expect(
    acceptConsentParts(facts, { recipients: "Gespeichert in Google Drive." }),
  ).not.toHaveProperty("recipients");
  expect(acceptConsentParts(facts,{recipients:'Gespeichert in Google Drive und Microsoft OneDrive.'})).not.toHaveProperty('recipients');
  expect(
    decisionFacts(
      {
        storageService: "Microsoft OneDrive",
        folderName: "Meetings",
        language: "de",
        address: "du",
        retention: { audioDays: null, textDays: null },
        method: "spoken",
        participants: [],
      },
      ["mic"],
    ).storage.service,
  ).toBe("Microsoft OneDrive");
});
