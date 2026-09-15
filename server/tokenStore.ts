import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import firebaseConfig from "../firebase-applet-config.json";

/**
 * Where a user's long-lived Google refresh token lives.
 *
 * Keyed by the Google account id (`sub`), because that is the one identifier
 * present both in the OAuth id_token at consent time and in the Firebase ID
 * token later (`firebase.identities["google.com"]`). Deriving the Firebase uid
 * server-side would need the Admin SDK, which this server deliberately avoids.
 */
export interface RefreshTokenStore {
  get(googleSub: string): Promise<string | null>;
  set(googleSub: string, refreshToken: string): Promise<void>;
  remove(googleSub: string): Promise<void>;
}

export function memoryStore(): RefreshTokenStore {
  const tokens = new Map<string, string>();
  return {
    async get(sub) {
      return tokens.get(sub) ?? null;
    },
    async set(sub, token) {
      tokens.set(sub, token);
    },
    async remove(sub) {
      tokens.delete(sub);
    },
  };
}

/**
 * Local development. The Firestore store authenticates through the Cloud Run
 * metadata server, which does not exist on a laptop, so without this the whole
 * server-held authorization flow fails at the OAuth callback.
 *
 * Files rather than memory, matching `fileSubmissionStore`: a refresh token
 * that vanished on every tsx reload would mean re-consenting constantly. Mode
 * 0600 in a gitignored directory — this is a real credential.
 */
export function fileGrantStore(
  root = path.resolve(".google-grants"),
): RefreshTokenStore {
  // The Google `sub` is an account identifier; hash it rather than name files
  // after it.
  const file = (sub: string) =>
    path.join(root, `${createHash("sha256").update(sub).digest("hex")}.json`);
  return {
    async get(sub) {
      try {
        return JSON.parse(await readFile(file(sub), "utf8")).refreshToken ?? null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async set(sub, refreshToken) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(file(sub), JSON.stringify({ refreshToken }), {
        mode: 0o600,
      });
    },
    async remove(sub) {
      await rm(file(sub), { force: true });
    },
  };
}

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/**
 * Fetches an access token for the runtime service account from the metadata
 * server. Deliberately dependency-free: no Admin SDK, no google-auth-library.
 * Off Cloud Run there is no metadata server, so this fails and the caller
 * reports the store as unavailable.
 */
let cached: { token: string; expiresAt: number } | null = null;

export async function serviceAccountToken(
  fetchImpl: typeof fetch,
): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Metadata server returned ${response.status}`);
  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) throw new Error("Metadata server returned no token");
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000,
  };
  return cached.token;
}

/** Refresh tokens in the project's Firestore, written with the runtime identity. */
export function firestoreStore({
  projectId = process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId,
  databaseId = (firebaseConfig as { firestoreDatabaseId?: string })
    .firestoreDatabaseId || "(default)",
  collection = "driveGrants",
  fetchImpl = fetch,
}: {
  projectId?: string;
  databaseId?: string;
  collection?: string;
  fetchImpl?: typeof fetch;
} = {}): RefreshTokenStore {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents/${collection}`;
  const docUrl = (sub: string) => `${base}/${encodeURIComponent(sub)}`;

  const call = async (url: string, init: RequestInit = {}) => {
    const token = await serviceAccountToken(fetchImpl);
    return fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  };

  return {
    async get(sub) {
      const response = await call(docUrl(sub));
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(`Firestore read failed (${response.status})`);
      const data = (await response.json()) as {
        fields?: { refreshToken?: { stringValue?: string } };
      };
      return data.fields?.refreshToken?.stringValue ?? null;
    },
    async set(sub, refreshToken) {
      const response = await call(docUrl(sub), {
        method: "PATCH",
        body: JSON.stringify({
          fields: {
            refreshToken: { stringValue: refreshToken },
            updatedAt: { timestampValue: new Date().toISOString() },
          },
        }),
      });
      if (!response.ok)
        throw new Error(`Firestore write failed (${response.status})`);
    },
    async remove(sub) {
      const response = await call(docUrl(sub), { method: "DELETE" });
      if (!response.ok && response.status !== 404)
        throw new Error(`Firestore delete failed (${response.status})`);
    },
  };
}
