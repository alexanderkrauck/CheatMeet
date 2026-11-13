import { expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  auth: { currentUser: null as null | { uid: string } },
  signIn: vi.fn(),
  link: vi.fn(),
}));
vi.mock("./firebase", () => ({ auth: m.auth }));
vi.mock("firebase/auth", () => ({
  OAuthProvider: class {
    constructor(public providerId: string) {}
    setCustomParameters() {}
  },
  signInWithPopup: m.signIn,
  linkWithPopup: m.link,
}));
import { signInMicrosoft, linkMicrosoftIdentity } from "./microsoftIdentity";
it("signs in separately from Graph and only explicitly links an existing UID, never merges by email", async () => {
  await signInMicrosoft();
  expect(m.signIn).toHaveBeenCalledOnce();
  expect(m.link).not.toHaveBeenCalled();
  m.auth.currentUser = { uid: "original" };
  m.link.mockResolvedValue({ user: { uid: "original" } });
  await linkMicrosoftIdentity();
  expect(m.link).toHaveBeenCalledWith(
    m.auth.currentUser,
    expect.objectContaining({ providerId: "microsoft.com" }),
  );
});
