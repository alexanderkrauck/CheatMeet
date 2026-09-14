import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import firebaseConfig from "../firebase-applet-config.json";
import { serviceAccountToken } from "./tokenStore";

export interface Submission {
  state: "reserved" | "submitted" | "failed";
  providerId?: string;
  languages: string[];
  createdAt: string;
}
export interface SubmissionStore {
  get(key: string): Promise<Submission | null>;
  /** Atomic create-if-absent, across instances/restarts. */
  reserve(key: string, value: Submission): Promise<boolean>;
  set(key: string, value: Submission): Promise<void>;
}
export const submissionKey = (owner: string, id: string) =>
  createHash("sha256").update(`${owner}\0${id}`).digest("hex");

/** Local development uses durable files; production never uses ephemeral disk. */
export function fileSubmissionStore(
  root = path.resolve(".transcription-jobs"),
): SubmissionStore {
  const file = (key: string) => path.join(root, `${key}.json`);
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(file(key), "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    async reserve(key, value) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      try {
        await writeFile(file(key), JSON.stringify(value), {
          flag: "wx",
          mode: 0o600,
        });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      }
    },
    async set(key, value) {
      const temp = `${file(key)}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, file(key));
    },
  };
}
export function firestoreSubmissionStore(fetchImpl = fetch): SubmissionStore {
  const database =
    (firebaseConfig as { firestoreDatabaseId?: string }).firestoreDatabaseId ||
    "(default)";
  const base = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId}/databases/${encodeURIComponent(database)}/documents/transcriptionJobs`;
  const call = async (key: string, init: RequestInit = {}, suffix = "") =>
    fetchImpl(`${base}/${key}${suffix}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await serviceAccountToken(fetchImpl)}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
  const body = (value: Submission) =>
    JSON.stringify({
      fields: { value: { stringValue: JSON.stringify(value) } },
    });
  return {
    async get(key) {
      const res = await call(key);
      if (res.status === 404) return null;
      if (!res.ok)
        throw new Error("Transkript-Auftrag konnte nicht gelesen werden.");
      return JSON.parse((await res.json()).fields.value.stringValue);
    },
    async reserve(key, value) {
      const res = await call(
        key,
        { method: "PATCH", body: body(value) },
        "?currentDocument.exists=false",
      );
      if (res.status === 409 || res.status === 412) return false;
      if (res.status === 400) {
        const body = await res.json().catch(() => ({}));
        // Firestore maps gRPC FAILED_PRECONDITION to HTTP 400.
        if (body.error?.status === "FAILED_PRECONDITION") return false;
      }
      if (!res.ok)
        throw new Error("Transkript-Auftrag konnte nicht reserviert werden.");
      return true;
    },
    async set(key, value) {
      const res = await call(key, { method: "PATCH", body: body(value) });
      if (!res.ok)
        throw new Error("Transkript-Auftrag konnte nicht gesichert werden.");
    },
  };
}
