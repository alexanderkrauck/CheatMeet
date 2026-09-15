import {
  acceptConsentParts,
  validateConsentParts,
  type ConsentFacts,
  type ConsentParts,
} from "../../shared/consent";
import { auth } from "./firebase";

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
): Promise<ConsentParts> {
  const user = auth.currentUser;
  if (!user) throw new Error("Bitte erneut anmelden.");
  const token = await user.getIdToken();
  const response = await fetch("/api/consent-notice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ facts, instructions }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response
    .json()
    .catch(() => ({}) as { parts?: unknown; error?: string });
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
