import { OAuthProvider, signInWithPopup, linkWithPopup, getAdditionalUserInfo, reload, unlink } from "firebase/auth";
import { auth } from "./firebase";
import {markIdentitySetup} from './identitySetup';
function provider() {
  const p = new OAuthProvider("microsoft.com");
  p.setCustomParameters({ prompt: "select_account" });
  return p;
}
/** Firebase identity only. Graph storage/calendar consent is a separate explicit action. */
export async function signInMicrosoft() {
  if (auth.currentUser)
    throw Error(
      "Bitte Microsoft in den Einstellungen ausdrücklich mit dem bestehenden Arbeitsbereich verknüpfen.",
    );
  const result=await signInWithPopup(auth, provider());
  if(result)markIdentitySetup(result.user.uid,getAdditionalUserInfo(result)?.isNewUser===true);
}
export async function unlinkMicrosoftIdentity(): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw Error("Bitte zuerst mit dem bestehenden Konto anmelden.");
  const owner = user.uid;
  try {
    await reload(user);
    if (auth.currentUser?.uid !== owner) throw Error("Das angemeldete Konto hat sich geändert.");
    if (!user.providerData.some(p => p.providerId === "microsoft.com")) throw Error("Microsoft ist nicht als Anmeldung verknüpft.");
    if (!user.providerData.some(p => p.providerId === "google.com")) throw Error("Die letzte Anmeldemethode kann nicht entfernt werden. Bitte zuerst eine weitere Anmeldung verknüpfen.");
    await unlink(user, "microsoft.com");
    if (auth.currentUser?.uid !== owner) throw Error("Das angemeldete Konto hat sich geändert.");
    await user.getIdToken(true);
    if (auth.currentUser?.uid !== owner) throw Error("Das angemeldete Konto hat sich geändert.");
  } catch (error) {
    if ((error as {code?: string})?.code === "auth/requires-recent-login") throw Error("Bitte erneut anmelden und die Anmeldemethode danach entfernen. Die Verknüpfung wurde nicht entfernt.");
    throw error;
  }
}

export async function linkMicrosoftIdentity() {
  const user = auth.currentUser;
  if (!user) throw Error("Bitte zuerst mit dem bestehenden Konto anmelden.");
  const uid = user.uid;
  const result = await linkWithPopup(user, provider());
  if (auth.currentUser?.uid !== uid || result.user.uid !== uid)
    throw Error(
      "Das angemeldete Konto hat sich geändert. Die Verknüpfung wurde nicht übernommen.",
    );
}
