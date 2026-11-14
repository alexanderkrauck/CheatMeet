import {
  acceptConsentParts,
  validateConsentParts,
  type ConsentFacts,
  type ConsentParts,
} from "../../shared/consent";
import { auth } from "./firebase";
import { usageHeaders, type MeetingUsageContext } from "./usageContext";

/**
 * Asks the model to phrase the notice for this situation.
 *
 * It returns phrasing only. The facts travel from the caller and the final
 * text is assembled locally, so a refusal, a timeout or a nonsense response
 * costs nothing but warmth — the deterministic notice is still complete.
 */
export async function draftConsentNotice(
  facts: ConsentFacts,
  instructions: string[],
  usage?: MeetingUsageContext,
): Promise<ConsentParts> {
  const user = auth.currentUser;
  if (!user) throw new Error("Bitte erneut anmelden.");
  const owner = user.uid;
  const check = () => {
    if (auth.currentUser?.uid !== owner)
      throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  const token = await user.getIdToken();
  check();
  const response = await fetch("/api/consent-notice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...usageHeaders(usage),
    },
    body: JSON.stringify({
      facts: {
        ...facts,
        storageService: facts.storage.service,
        folderName: facts.storage.folder,
      },
      instructions,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  check();
  const data = await response
    .json()
    .catch(() => ({}) as { parts?: unknown; error?: string });
  check();
  if (!response.ok)
    throw new Error(
      data.error ||
        "Die Formulierung hat nicht geklappt. Der Standardtext bleibt gültig.",
    );
  // Checked against the facts here too, so the armed screen shows exactly the
  // wording that will be recorded rather than one the record would reject.
  const parts = acceptConsentParts(facts, validateConsentParts(data.parts));
  if (!Object.keys(parts).length)
    throw new Error(
      "Die Formulierung gab die Angaben nicht korrekt wieder. Der Standardtext bleibt gültig.",
    );
  return parts;
}
