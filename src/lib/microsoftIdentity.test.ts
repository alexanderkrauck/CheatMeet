import { expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  auth: { currentUser: null as null | { uid: string; providerData?: {providerId:string}[]; getIdToken?:(force?:boolean)=>Promise<string> } },
  signIn: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  reload: vi.fn(),
}));
vi.mock("./firebase", () => ({ auth: m.auth }));
vi.mock("firebase/auth", () => ({
  OAuthProvider: class {
    constructor(public providerId: string) {}
    setCustomParameters() {}
  },
  signInWithPopup: m.signIn,
  linkWithPopup: m.link,
  unlink: m.unlink,
  reload: m.reload,
  getAdditionalUserInfo:(result:{fresh?:boolean})=>({isNewUser:result.fresh}),
}));
import { signInMicrosoft, linkMicrosoftIdentity, unlinkMicrosoftIdentity } from "./microsoftIdentity";
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

it("protects the last Microsoft login and handles recent-auth failure without touching Graph grants or files", async () => {
  const user = {uid:"original",providerData:[{providerId:"microsoft.com"}],getIdToken:vi.fn(async()=>"fresh-id")};
  m.auth.currentUser = user;
  m.reload.mockResolvedValue(undefined);
  const fetcher = vi.fn(); vi.stubGlobal("fetch",fetcher);
  await expect(unlinkMicrosoftIdentity()).rejects.toThrow(/letzte/);
  expect(m.unlink).not.toHaveBeenCalled();
  user.providerData.push({providerId:"google.com"});
  m.unlink.mockRejectedValueOnce(Object.assign(Error("private"),{code:"auth/requires-recent-login"}));
  await expect(unlinkMicrosoftIdentity()).rejects.toThrow(/erneut anmelden/);
  expect(user.providerData).toHaveLength(2);
  m.unlink.mockResolvedValueOnce(user);
  await unlinkMicrosoftIdentity();
  expect(m.unlink).toHaveBeenLastCalledWith(user,"microsoft.com");
  expect(user.getIdToken).toHaveBeenCalledWith(true);
  expect(fetcher).not.toHaveBeenCalled();
  const count = m.unlink.mock.calls.length;
  m.reload.mockImplementationOnce(async()=>{m.auth.currentUser={...user,uid:"other"};});
  await expect(unlinkMicrosoftIdentity()).rejects.toThrow(/Konto.*geändert/);
  expect(m.unlink).toHaveBeenCalledTimes(count);
});
