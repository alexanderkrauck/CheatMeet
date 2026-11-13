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
  getAdditionalUserInfo:(result:{fresh?:boolean})=>({isNewUser:result.fresh}),
}));
import { signInMicrosoft, linkMicrosoftIdentity } from "./microsoftIdentity";
it('starts the same setup for a new Microsoft workspace without assigning storage',async()=>{
  m.auth.currentUser=null;m.signIn.mockResolvedValueOnce({user:{uid:'new-microsoft'},fresh:true});
  const stored=new Map<string,string>();vi.stubGlobal('window',new EventTarget());vi.stubGlobal('sessionStorage',{getItem:(k:string)=>stored.get(k)||null,setItem:(k:string,v:string)=>stored.set(k,v)});
  await signInMicrosoft();expect((await import('./identitySetup')).identitySetupPending('new-microsoft')).toBe(true);
  expect([...stored.keys()]).toEqual(['cheatmeet:identity-setup:new-microsoft']);
  m.signIn.mockReset();
});
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
