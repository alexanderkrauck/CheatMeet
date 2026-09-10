import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import firebaseConfig from "../../firebase-applet-config.json";
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const databaseId =
  import.meta.env.VITE_FIRESTORE_DATABASE_ID ||
  (firebaseConfig as typeof firebaseConfig & { firestoreDatabaseId?: string })
    .firestoreDatabaseId ||
  "(default)";
export const db = initializeFirestore(
  app,
  {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
    ignoreUndefinedProperties: true,
  },
  databaseId,
);
export const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive.file");
