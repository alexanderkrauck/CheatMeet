import { expect, it } from "vitest";
import { speechOnly } from "./assist";
it("retains remote meeting participants, speaker labels and timestamps in assistant context", () => {
  for (const transcript of [
    "[0:00] (Andere) Können wir das Budget freigeben?\n\n[0:10] (Du) Noch nicht.",
    "[0:00] (Systemaudio · Nina) Welche Frage ist offen?\n\n[0:10] (Mikrofon · Alex) Der Termin.",
    "[0:00] Nur Mikrofon.",
  ]) expect(speechOnly(transcript)).toBe(transcript);
});
