import { OAuthProvider, signInWithPopup, linkWithPopup } from "firebase/auth";
import { auth } from "./firebase";
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
  await signInWithPopup(auth, provider());
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
