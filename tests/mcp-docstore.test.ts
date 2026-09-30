import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Contention,
  fileDocStore,
  firestoreDocStore,
  memoryDocStore,
  type DocStore,
} from "../server/mcp/docStore";
import { fakeFirestore } from "./helpers/fakeFirestore";

interface Item {
  n: number;
  owner?: string;
}
const soon = () => ({ ownerKey: "alice", expireAt: new Date(Date.now() + 3_600_000) });

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const stores: [string, () => Promise<DocStore<Item>>][] = [
  ["memory", async () => memoryDocStore<Item>()],
  ["file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docstore-"));
    dirs.push(dir);
    return fileDocStore<Item>(dir);
  }],
  ["firestore (fake REST)", async () =>
    firestoreDocStore<Item>({
      collection: "mcpTest",
      projectId: "p",
      databaseId: "(default)",
      fetchImpl: fakeFirestore().fetch,
      token: async () => "test-token",
    })],
];

describe.each(stores)("DocStore contract: %s", (_name, make) => {
  it("reads nothing before anything was written", async () => {
    expect(await (await make()).get("missing")).toBeNull();
  });

  it("creates from absent, updates, and reads back", async () => {
    const store = await make();
    expect(await store.mutate("a", () => ({ n: 1 }), soon())).toEqual({ n: 1 });
    expect(await store.mutate("a", (cur) => ({ n: (cur?.n ?? 0) + 1 }), soon())).toEqual({ n: 2 });
    expect(await store.get("a")).toEqual({ n: 2 });
  });

  it("leaves the document alone when the function returns undefined, and deletes on null", async () => {
    const store = await make();
    await store.mutate("a", () => ({ n: 1 }), soon());
    expect(await store.mutate("a", () => undefined, soon())).toEqual({ n: 1 });
    expect(await store.mutate("a", () => null, soon())).toBeNull();
    expect(await store.get("a")).toBeNull();
  });

  it("lets exactly one of 20 parallel claims win", async () => {
    const store = await make();
    await store.mutate("claim", () => ({ n: 0 }), soon());
    // `fn` may run again after a collision, so it must not be what counts winners:
    // a claim won exactly when the value that came back is the caller's own.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.mutate("claim", (cur) => {
          if (!cur || cur.n !== 0) return undefined;
          return { n: 1, owner: String(i) };
        }, soon()),
      ),
    );
    const winners = results.map((value, i) => (value?.owner === String(i) ? i : -1)).filter((i) => i >= 0);
    expect(winners).toHaveLength(1);
    expect((await store.get("claim"))?.owner).toBe(String(winners[0]));
  });

  it("never loses an increment under parallel writers", async () => {
    const store = await make();
    await Promise.all(
      Array.from({ length: 15 }, () => store.mutate("counter", (cur) => ({ n: (cur?.n ?? 0) + 1 }), soon())),
    );
    expect((await store.get("counter"))?.n).toBe(15);
  });

  it("lists only the caller's documents", async () => {
    const store = await make();
    await store.mutate("a", () => ({ n: 1 }), { ...soon(), ownerKey: "alice" });
    await store.mutate("b", () => ({ n: 2 }), { ...soon(), ownerKey: "bob" });
    await store.mutate("c", () => ({ n: 3 }), { ...soon(), ownerKey: "alice" });
    expect((await store.listByOwner("alice")).map((x) => x.n).sort()).toEqual([1, 3]);
    expect(await store.listByOwner("nobody")).toEqual([]);
  });

  it("lets the owner and expiry be derived from the value being stored", async () => {
    const store = await make();
    await store.mutate("derived", () => ({ n: 7, owner: "carol" }), (next) => ({
      ownerKey: next.owner!,
      expireAt: new Date(Date.now() + 3_600_000),
    }));
    expect((await store.listByOwner("carol")).map((x) => x.n)).toEqual([7]);
    expect(await store.listByOwner("alice")).toEqual([]);
  });

  it("treats an expired document as absent", async () => {
    const store = await make();
    await store.mutate("old", () => ({ n: 1 }), { ownerKey: "alice", expireAt: new Date(Date.now() - 1000) });
    expect(await store.get("old")).toBeNull();
    expect(await store.listByOwner("alice")).toEqual([]);
  });
});

describe("firestore store specifics", () => {
  it("writes the owner and the expiry as real fields, so a TTL policy and owner queries work", async () => {
    const fake = fakeFirestore();
    const store = firestoreDocStore<Item>({
      collection: "mcpTest", projectId: "p", databaseId: "(default)", fetchImpl: fake.fetch, token: async () => "t",
    });
    const expireAt = new Date("2030-01-01T00:00:00.000Z");
    await store.mutate("a", () => ({ n: 1 }), { ownerKey: "alice", expireAt });
    const raw = fake.documents.get("projects/p/databases/(default)/documents/mcpTest/a")!;
    expect(raw.fields.ownerKey).toEqual({ stringValue: "alice" });
    expect(raw.fields.expireAt).toEqual({ timestampValue: "2030-01-01T00:00:00.000Z" });
  });

  it("gives up with a typed error when contention never clears", async () => {
    const fake = fakeFirestore({ alwaysConflict: true });
    const store = firestoreDocStore<Item>({
      collection: "mcpTest", projectId: "p", databaseId: "(default)", fetchImpl: fake.fetch, token: async () => "t",
    });
    await expect(store.mutate("a", () => ({ n: 1 }), soon())).rejects.toBeInstanceOf(Contention);
  });

  it("does not swallow a real failure as if it were contention", async () => {
    const fake = fakeFirestore({ failWith: 500 });
    const store = firestoreDocStore<Item>({
      collection: "mcpTest", projectId: "p", databaseId: "(default)", fetchImpl: fake.fetch, token: async () => "t",
    });
    await expect(store.get("a")).rejects.toThrow(/500/);
  });
});
