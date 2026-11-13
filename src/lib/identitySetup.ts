/** Only a newly created Firebase workspace starts setup; legacy accounts are never migrated. */
const key=(owner:string)=>`cheatmeet:identity-setup:${owner}`;
const event='cheatmeet:identity-setup';
export function identitySetupPending(owner:string){
  try{return sessionStorage.getItem(key(owner))==='pending';}catch{return false;}
}
export function markIdentitySetup(owner:string,isNewUser:boolean){
  if(!isNewUser)return;
  try{sessionStorage.setItem(key(owner),'pending');}catch{/* setup remains reachable from settings */}
  if(typeof window!=='undefined')window.dispatchEvent(new Event(event));
}
export function completeIdentitySetup(owner:string){
  try{sessionStorage.removeItem(key(owner));}catch{/* unavailable private storage */}
  if(typeof window!=='undefined')window.dispatchEvent(new Event(event));
}
export function subscribeIdentitySetup(callback:()=>void){
  window.addEventListener(event,callback);
  return()=>window.removeEventListener(event,callback);
}
