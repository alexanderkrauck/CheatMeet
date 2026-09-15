import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase";
import { DEFAULT_FOLDER_NAME, findOrCreateRootFolder, getDriveFolder } from "./drive";
import config from "../../firebase-applet-config.json";
export interface DriveFolder {
  id: string;
  name: string;
}
const key = (owner = auth.currentUser?.uid || "signed-out") =>
  `cheatmeet:drive-folder:${owner}`;
function requireOwner(): string {
  if (!auth.currentUser) throw new Error("Bitte zuerst anmelden.");
  return auth.currentUser.uid;
}
function assertOwner(owner: string) {
  if (auth.currentUser?.uid !== owner)
    throw new Error(
      "Das Google-Konto wurde gewechselt. Bitte den Speicherort im ursprünglichen Konto erneut öffnen.",
    );
}
export function savedDriveFolder(): DriveFolder | null {
  try {
    const value = JSON.parse(localStorage.getItem(key()) || "null");
    return value &&
      typeof value.id === "string" &&
      typeof value.name === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
export async function loadDriveFolder(): Promise<DriveFolder | null> {
  const local = savedDriveFolder();
  if (!auth.currentUser || local) return local;
  const owner = requireOwner();
  const storageKey = key(owner);
  let timer: ReturnType<typeof setTimeout>;
  const snapshot = await Promise.race([
    getDoc(doc(db, "users", owner, "settings", "drive")),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Einstellungen konnten nicht geladen werden.")),
        5000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  assertOwner(owner);
  const folder = snapshot.data()?.folder;
  if (
    folder &&
    typeof folder.id === "string" &&
    typeof folder.name === "string"
  ) {
    localStorage.setItem(storageKey, JSON.stringify(folder));
    // The record screen listens for this; without it a folder restored from
    // Firestore leaves the pill naming the default one.
    window.dispatchEvent(new Event("cheatmeet:drive-settings"));
    return folder;
  }
  return null;
}
export async function saveDriveFolder(
  folder: DriveFolder,
): Promise<string | null> {
  const owner = requireOwner();
  localStorage.setItem(key(owner), JSON.stringify(folder));
  window.dispatchEvent(new Event("cheatmeet:drive-settings"));
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      setDoc(
        doc(db, "users", owner, "settings", "drive"),
        { folder },
        { merge: true },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 6000);
      }),
    ]).finally(() => clearTimeout(timer));
    assertOwner(owner);
    return null;
  } catch {
    assertOwner(owner);
    return "Ordner auf diesem Gerät gespeichert. Die Synchronisierung der Einstellung mit Firebase ist noch nicht bestätigt.";
  }
}
export async function getRootFolder(token: string): Promise<string> {
  const owner = requireOwner();
  // A saved explicit location must never silently fall back to another folder.
  const folder = await loadDriveFolder().catch(() => {
    assertOwner(owner);
    return savedDriveFolder();
  });
  assertOwner(owner);
  if (folder) {
    await getDriveFolder(folder.id, token);
    assertOwner(owner);
    return folder.id;
  }
  const id = await findOrCreateRootFolder(token);
  assertOwner(owner);
  await saveDriveFolder({ id, name: DEFAULT_FOLDER_NAME });
  assertOwner(owner);
  return id;
}
let pickerLoader: Promise<void> | undefined;
function loadPicker(): Promise<void> {
  if (pickerLoader) return pickerLoader;
  pickerLoader = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Google-Ordnerauswahl konnte nicht geladen werden. Verbindung prüfen und erneut versuchen.",
          ),
        ),
      15000,
    );
    const ready = () =>
      (window as any).gapi.load("picker", {
        callback: () => {
          clearTimeout(timer);
          resolve();
        },
        onerror: () => {
          clearTimeout(timer);
          reject(new Error("Google Picker konnte nicht geladen werden."));
        },
      });
    if ((window as any).gapi) ready();
    else {
      const script = document.createElement("script");
      script.src = "https://apis.google.com/js/api.js";
      script.onload = ready;
      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Google-Ordnerauswahl ist nicht erreichbar."));
      };
      document.head.appendChild(script);
    }
  }).catch((error) => {
    pickerLoader = undefined;
    throw error;
  });
  return pickerLoader;
}
export async function chooseDriveFolder(
  token: string,
): Promise<DriveFolder | null> {
  const owner = requireOwner();
  await loadPicker();
  assertOwner(owner);
  const picker = (window as any).google.picker;
  return new Promise((resolve, reject) => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes("application/vnd.google-apps.folder");
    new picker.PickerBuilder()
      .setTitle("Speicherordner für CheatMeet wählen")
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(import.meta.env.VITE_GOOGLE_API_KEY || config.apiKey)
      .setAppId(
        import.meta.env.VITE_GOOGLE_PROJECT_NUMBER || config.messagingSenderId,
      )
      .setOrigin(window.location.origin)
      .setLocale("de")
      .setCallback((data: any) => {
        try {
          assertOwner(owner);
        } catch (error) {
          reject(error);
          return;
        }
        if (data.action === picker.Action.CANCEL) resolve(null);
        if (data.action === picker.Action.PICKED) {
          const selected = data.docs?.[0];
          if (!selected?.id)
            reject(new Error("Es wurde kein gültiger Ordner ausgewählt."));
          else
            getDriveFolder(selected.id, token)
              .then((folder) => {
                assertOwner(owner);
                resolve(folder);
              })
              .catch(reject);
        }
      })
      .build()
      .setVisible(true);
  });
}
