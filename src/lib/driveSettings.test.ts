import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getDriveFolder: vi.fn(),
  findOrCreateRootFolder: vi.fn(),
  user: { uid: "u1" },
  getDoc: vi.fn(),
  setDoc: vi.fn(),
}));
vi.mock("./firebase", () => ({ auth: { currentUser: mocks.user }, db: {} }));
vi.mock("./drive", () => ({
  getDriveFolder: mocks.getDriveFolder,
  findOrCreateRootFolder: mocks.findOrCreateRootFolder,
}));
vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => args,
  getDoc: mocks.getDoc,
  setDoc: mocks.setDoc,
}));
import {
  getRootFolder,
  savedDriveFolder,
  loadDriveFolder,
} from "./driveSettings";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.user.uid = "u1";
});
describe("Drive folder preference", () => {
  it("never silently changes destination when a selected folder becomes inaccessible", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi
        .fn()
        .mockReturnValue(JSON.stringify({ id: "chosen", name: "Site" })),
    });
    mocks.getDriveFolder.mockRejectedValue(new Error("Zugriff verweigert"));
    await expect(getRootFolder("token")).rejects.toThrow("Zugriff verweigert");
    expect(mocks.findOrCreateRootFolder).not.toHaveBeenCalled();
  });
  it("does not save a created folder into a new account after an account switch", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem,
    });
    mocks.getDoc.mockResolvedValue({ data: () => undefined });
    mocks.findOrCreateRootFolder.mockImplementation(async () => {
      mocks.user.uid = "u2";
      return "old-account-folder";
    });
    await expect(getRootFolder("old-token")).rejects.toThrow(
      "Google-Konto wurde gewechselt",
    );
    expect(setItem).not.toHaveBeenCalled();
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });
  it("does not cache a folder returned from Firestore after an account switch", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem,
    });
    mocks.getDoc.mockImplementation(async () => {
      mocks.user.uid = "u2";
      return {
        data: () => ({ folder: { id: "private", name: "Original account" } }),
      };
    });
    await expect(loadDriveFolder()).rejects.toThrow(
      "Google-Konto wurde gewechselt",
    );
    expect(setItem).not.toHaveBeenCalled();
  });
  it("reads settings only from the signed in user namespace", () => {
    const getItem = vi.fn().mockReturnValue(null);
    vi.stubGlobal("localStorage", { getItem });
    expect(savedDriveFolder()).toBeNull();
    expect(getItem).toHaveBeenCalledWith("cheatmeet:drive-folder:u1");
  });
});
