import {beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({auth:{currentUser:null as null|{uid:string}},signIn:vi.fn(),link:vi.fn()}));
vi.mock('./firebase',()=>({auth:f.auth,provider:{providerId:'scoped-drive-provider'}}));
vi.mock('firebase/auth',async original=>({...await original<typeof import('firebase/auth')>(),signInWithPopup:f.signIn,linkWithPopup:f.link,getAdditionalUserInfo:(r:any)=>({isNewUser:r.fresh})}));
const stored=new Map<string,string>();
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();f.auth.currentUser=null;stored.clear();vi.stubGlobal('window',new EventTarget());vi.stubGlobal('sessionStorage',{getItem:(k:string)=>stored.get(k)||null,setItem:(k:string,v:string)=>stored.set(k,v),removeItem:(k:string)=>stored.delete(k)});});
it('Google sign-in requests identity only and sends only genuinely new accounts to setup',async()=>{
 f.signIn.mockResolvedValue({user:{uid:'new'},fresh:true});
 const s=await import('./session');await s.signInGoogle();
 const provider=f.signIn.mock.calls[0][1];expect(provider.providerId).toBe('google.com');expect(provider.getScopes()).toEqual(['profile']);
 const setup=await import('./identitySetup');expect(setup.identitySetupPending('new')).toBe(true);expect(setup.identitySetupPending('existing')).toBe(false);
 setup.completeIdentitySetup('new');expect(setup.identitySetupPending('new')).toBe(false);
});
it('existing Google accounts retain their workspace and do not restart setup',async()=>{
 f.signIn.mockResolvedValue({user:{uid:'original'},fresh:false});await(await import('./session')).signInGoogle();expect((await import('./identitySetup')).identitySetupPending('original')).toBe(false);
});
it('Google identity linking requires an existing UID and never swaps that workspace',async()=>{
 const s=await import('./session');await expect(s.linkGoogleIdentity()).rejects.toThrow('bestehenden');f.auth.currentUser={uid:'original'};f.link.mockResolvedValue({user:{uid:'original'}});await s.linkGoogleIdentity();expect(f.link.mock.calls[0][1].getScopes()).toEqual(['profile']);f.link.mockResolvedValue({user:{uid:'other'}});await expect(s.linkGoogleIdentity()).rejects.toThrow('geändert');
});
