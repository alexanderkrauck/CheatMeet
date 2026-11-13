import { expect, it, vi } from "vitest";
import { analyzeTranscript } from "../server/analysis";

it("summarizes existing text without requesting another full transcript in the provider output", async () => {
  const generateContent = vi.fn(async (_request: unknown) => ({ text: JSON.stringify({ title: "Meeting", summary: "Ergebnis", todos: [], takeaways: [] }) }));
  const original = "Vorhandenes Transkript. ".repeat(5000);
  const result = await analyzeTranscript(original, "", { createClient: () => ({ models: { generateContent } } as any) });
  const request = generateContent.mock.calls[0][0] as any;
  expect(request.config.responseJsonSchema.properties.transcription).toBeUndefined();
  expect(request.config.systemInstruction).toContain("Gib das Transkript nicht zurück");
  expect(result.transcription).toBe(original);
  expect(result.summary).toBe("Ergebnis");
});
