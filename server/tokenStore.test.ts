import { describe, expect, it, vi } from "vitest";
import { firestoreStore, memoryStore } from "./tokenStore";

const metadata = () =>
  Response.json({ access_token: "sa-token", expires_in: 3600 });

describe("refresh token store", () => {
  it("treats a missing document as no grant rather than an error", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("metadata")
        ? metadata()
        : new Response("", { status: 404 }),
    );
    const store = firestoreStore({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await store.get("google-1")).toBeNull();
  });

  it("reads the stored refresh token out of the Firestore document shape", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("metadata")
        ? metadata()
        : Response.json({ fields: { refreshToken: { stringValue: "rt" } } }),
    );
    const store = firestoreStore({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await store.get("google-1")).toBe("rt");
  });

  it("tolerates deleting a grant that is already gone", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("metadata")
        ? metadata()
        : new Response("", { status: 404 }),
    );
    const store = firestoreStore({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(store.remove("google-1")).resolves.toBeUndefined();
  });

  it("surfaces a real write failure instead of silently losing the grant", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("metadata")
        ? metadata()
        : new Response("", { status: 500 }),
    );
    const store = firestoreStore({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(store.set("google-1", "rt")).rejects.toThrow(/500/);
  });

  it("keeps a grant per account", async () => {
    const store = memoryStore();
    await store.set("a", "token-a");
    await store.set("b", "token-b");
    await store.remove("a");
    expect(await store.get("a")).toBeNull();
    expect(await store.get("b")).toBe("token-b");
  });
});
