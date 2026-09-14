import { expect, it, vi } from "vitest";
import { firestoreSubmissionStore } from "./transcriptionStore";

it("uses an atomic create precondition and recognizes Firestore's duplicate reservation response", async () => {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("metadata.google.internal")) return Response.json({ access_token: "test-runtime-token", expires_in: 3600 });
    expect(url).toContain("?currentDocument.exists=false");
    expect(init.method).toBe("PATCH");
    return Response.json({ error: { status: "FAILED_PRECONDITION" } }, { status: 400 });
  });
  const store = firestoreSubmissionStore(fetchImpl as typeof fetch);
  expect(await store.reserve("test-job", { state: "reserved", languages: ["de"], createdAt: "2026-09-14" })).toBe(false);
});
it("reclaims only a retryable reservation using its exact Firestore update time", async () => {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes('metadata.google.internal')) return Response.json({access_token:'test',expires_in:3600});
    if (!init.method) return Response.json({fields:{value:{stringValue:JSON.stringify({state:'retryable'})}},updateTime:'2026-09-14T14:05:29.068123Z'});
    expect(url).toContain('currentDocument.updateTime=2026-09-14T14%3A05%3A29.068123Z');
    return Response.json({error:{status:'FAILED_PRECONDITION'}},{status:400});
  });
  const store = firestoreSubmissionStore(fetchImpl as typeof fetch);
  expect(await store.retry('job',{state:'reserved',languages:['de'],createdAt:'now'})).toBe(false);
});
