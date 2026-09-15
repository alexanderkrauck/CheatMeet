import { beforeEach, describe, expect, it, vi } from "vitest";

const db = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: async (k: string) => db.get(k),
  set: async (k: string, v: unknown) => void db.set(k, v),
  update: async (k: string, fn: (v: unknown) => unknown) =>
    void db.set(k, fn(db.get(k))),
}));

const { isRealName, listPeople, rememberPeople } = await import("./people");

beforeEach(() => db.clear());

describe("isRealName", () => {
  it("rejects the labels the transcriber invents", () => {
    expect(isRealName("Sprecher 1")).toBe(false);
    expect(isRealName("Sprecher 12")).toBe(false);
    expect(isRealName("Unbekannt")).toBe(false);
    expect(isRealName("   ")).toBe(false);
  });
  it("accepts a name a person typed", () => {
    expect(isRealName("Anna")).toBe(true);
    expect(isRealName("Jean-Luc")).toBe(true);
  });
});

describe("rememberPeople", () => {
  it("keeps the most recently used name first", async () => {
    await rememberPeople("u1", ["Anna", "Ben"]);
    await rememberPeople("u1", ["Clara"]);
    expect(await listPeople("u1")).toEqual(["Clara", "Anna", "Ben"]);
  });
  it("moves a name back to the front instead of duplicating it", async () => {
    await rememberPeople("u1", ["Anna", "Ben"]);
    await rememberPeople("u1", ["Ben"]);
    expect(await listPeople("u1")).toEqual(["Ben", "Anna"]);
  });
  it("never stores a placeholder", async () => {
    await rememberPeople("u1", ["Sprecher 2", "Unbekannt", "Anna"]);
    expect(await listPeople("u1")).toEqual(["Anna"]);
  });
  it("trims, and writes nothing when there is nothing real to add", async () => {
    await rememberPeople("u1", ["  Anna  "]);
    expect(await listPeople("u1")).toEqual(["Anna"]);
    await rememberPeople("u1", ["Sprecher 3"]);
    expect(await listPeople("u1")).toEqual(["Anna"]);
  });
  it("keeps each account's people separate", async () => {
    await rememberPeople("u1", ["Anna"]);
    await rememberPeople("u2", ["Ben"]);
    expect(await listPeople("u1")).toEqual(["Anna"]);
    expect(await listPeople("u2")).toEqual(["Ben"]);
  });
  it("caps the list so it cannot grow without bound", async () => {
    await rememberPeople("u1", Array.from({ length: 250 }, (_, i) => `P${i}`));
    expect(await listPeople("u1")).toHaveLength(200);
  });
});

describe("placeholder names never become suggestions", () => {
  it("rejects both label shapes the app generates", () => {
    expect(isRealName("Sprecher 1")).toBe(false);
    expect(isRealName("Neue Person 2")).toBe(false);
    expect(isRealName("Neue Person 11")).toBe(false);
  });
  it("keeps a real name that merely starts similarly", () => {
    expect(isRealName("Sprecherin Anna")).toBe(true);
    expect(isRealName("Neue Personalchefin")).toBe(true);
  });
});

describe("rememberPeople deduplicates within one batch", () => {
  it("stores a repeated name once", async () => {
    await rememberPeople("u1", ["Anna", "Anna", " Anna ", "Ben"]);
    expect(await listPeople("u1")).toEqual(["Anna", "Ben"]);
  });
});
