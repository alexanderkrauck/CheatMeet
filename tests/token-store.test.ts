import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileGrantStore } from "../server/tokenStore";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "grants-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("fileGrantStore", () => {
  it("round-trips a refresh token", async () => {
    const store = fileGrantStore(root);
    expect(await store.get("sub-1")).toBe(null);
    await store.set("sub-1", "refresh-abc");
    expect(await store.get("sub-1")).toBe("refresh-abc");
  });

  it("keeps accounts apart", async () => {
    const store = fileGrantStore(root);
    await store.set("sub-1", "a");
    await store.set("sub-2", "b");
    expect(await store.get("sub-1")).toBe("a");
    expect(await store.get("sub-2")).toBe("b");
  });

  it("replaces an existing grant rather than failing", async () => {
    const store = fileGrantStore(root);
    await store.set("sub-1", "old");
    await store.set("sub-1", "new");
    expect(await store.get("sub-1")).toBe("new");
  });

  it("removes a grant, and removing a missing one is not an error", async () => {
    const store = fileGrantStore(root);
    await store.set("sub-1", "a");
    await store.remove("sub-1");
    expect(await store.get("sub-1")).toBe(null);
    await expect(store.remove("sub-1")).resolves.toBeUndefined();
  });

  it("survives a restart, so a reload does not force re-consent", async () => {
    await fileGrantStore(root).set("sub-1", "refresh-abc");
    expect(await fileGrantStore(root).get("sub-1")).toBe("refresh-abc");
  });

  it("never writes the account id into a filename", async () => {
    await fileGrantStore(root).set("user@example.com", "a");
    const [name] = await readdir(root);
    expect(name).not.toContain("user");
    expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it("writes the credential owner-only", async () => {
    await fileGrantStore(root).set("sub-1", "a");
    const [name] = await readdir(root);
    expect((await stat(path.join(root, name))).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });
});
