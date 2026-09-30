import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DocMeta {
  /** Who the document belongs to; listByOwner is the only query the app needs. */
  ownerKey: string;
  /** Also written as a real field, so a Firestore TTL policy can delete the document. */
  expireAt: Date;
}
/** Fixed, or derived from the value about to be stored (when the owner is only known from it). */
export type DocMetaSource<T> = DocMeta | ((next: T) => DocMeta);
const metaOf = <T>(source: DocMetaSource<T>, next: T): DocMeta =>
  typeof source === "function" ? source(next) : source;

/**
 * Small keyed store with an atomic read-modify-write, the one primitive both
 * the OAuth grants (single-use codes, refresh rotation) and the live
 * transcripts (sequenced pushes) need to be correct on several instances.
 */
export interface DocStore<T> {
  get(id: string): Promise<T | null>;
  /**
   * `fn` sees the current value (null when absent) and returns the next one:
   * `undefined` leaves the document unchanged, `null` deletes it. It may run
   * more than once when writers collide, so it must be free of side effects.
   * Resolves to the value stored afterwards.
   */
  mutate(
    id: string,
    fn: (current: T | null) => T | null | undefined,
    meta: DocMetaSource<T>,
  ): Promise<T | null>;
  listByOwner(ownerKey: string): Promise<T[]>;
}

/** Writers collided more often than the store is willing to retry. */
export class Contention extends Error {
  constructor(id: string) {
    super(`Too much contention writing ${id}`);
  }
}

interface Stored<T> {
  ownerKey: string;
  expireAt: string;
  value: T;
}
const alive = (entry: { expireAt: string }) => Date.parse(entry.expireAt) > Date.now();

export function memoryDocStore<T>(): DocStore<T> {
  const docs = new Map<string, Stored<T>>();
  const current = (id: string) => {
    const entry = docs.get(id);
    if (entry && !alive(entry)) docs.delete(id);
    return docs.get(id);
  };
  return {
    async get(id) {
      return current(id)?.value ?? null;
    },
    // Synchronous between read and write: atomic on a single-threaded runtime.
    async mutate(id, fn, meta) {
      const before = current(id)?.value ?? null;
      const next = fn(before);
      if (next === undefined) return before;
      if (next === null) {
        docs.delete(id);
        return null;
      }
      const { ownerKey, expireAt } = metaOf(meta, next);
      docs.set(id, { ownerKey, expireAt: expireAt.toISOString(), value: next });
      return next;
    },
    async listByOwner(ownerKey) {
      return [...docs.keys()]
        .map((id) => current(id))
        .filter((entry): entry is Stored<T> => Boolean(entry) && entry!.ownerKey === ownerKey)
        .map((entry) => entry.value);
    },
  };
}

/**
 * Local development: private files, like `fileGrantStore`. One process, so a
 * per-document promise chain provides the atomicity. Mode 0600 in a
 * gitignored directory - grants are credentials.
 */
export function fileDocStore<T>(root: string): DocStore<T> {
  const file = (id: string) =>
    path.join(root, `${createHash("sha256").update(id).digest("hex")}.json`);
  const chains = new Map<string, Promise<unknown>>();
  const read = async (target: string): Promise<Stored<T> | null> => {
    try {
      const entry = JSON.parse(await readFile(target, "utf8")) as Stored<T>;
      return alive(entry) ? entry : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    async get(id) {
      return (await read(file(id)))?.value ?? null;
    },
    mutate(id, fn, meta) {
      const target = file(id);
      const run = (chains.get(target) ?? Promise.resolve()).then(async () => {
        const before = (await read(target))?.value ?? null;
        const next = fn(before);
        if (next === undefined) return before;
        if (next === null) {
          await rm(target, { force: true });
          return null;
        }
        await mkdir(root, { recursive: true, mode: 0o700 });
        const { ownerKey, expireAt } = metaOf(meta, next);
        const entry: Stored<T> = { ownerKey, expireAt: expireAt.toISOString(), value: next };
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
        await rename(temporary, target);
        return next;
      });
      chains.set(target, run.catch(() => undefined));
      return run;
    },
    async listByOwner(ownerKey) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const found: T[] = [];
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        const entry = await read(path.join(root, name)).catch(() => null);
        if (entry && entry.ownerKey === ownerKey) found.push(entry.value);
      }
      return found;
    },
  };
}

export interface FirestoreDocOptions {
  collection: string;
  projectId: string;
  databaseId: string;
  fetchImpl: typeof fetch;
  token: () => Promise<string>;
}
const MAX_ATTEMPTS = 8;

/**
 * Firestore over REST with the runtime identity, like the other server-side
 * stores: no Admin SDK. The value is one JSON string field beside real
 * `ownerKey` and `expireAt` fields. Compare-and-set uses the document's
 * `updateTime` (or `exists=false` for creation) as the precondition.
 */
export function firestoreDocStore<T>(options: FirestoreDocOptions): DocStore<T> {
  const { collection, projectId, databaseId, fetchImpl } = options;
  const root = `projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents`;
  const base = `https://firestore.googleapis.com/v1/${root}`;
  const docUrl = (id: string) => `${base}/${collection}/${encodeURIComponent(id)}`;

  const call = async (url: string, init: RequestInit = {}) =>
    fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${await options.token()}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  const parse = (doc: any): (Stored<T> & { updateTime?: string }) | null => {
    const json = doc?.fields?.json?.stringValue;
    const expireAt = doc?.fields?.expireAt?.timestampValue;
    if (typeof json !== "string" || typeof expireAt !== "string") return null;
    const entry = {
      ownerKey: String(doc.fields.ownerKey?.stringValue ?? ""),
      expireAt,
      value: JSON.parse(json) as T,
      updateTime: doc.updateTime as string | undefined,
    };
    return alive(entry) ? entry : null;
  };
  const load = async (id: string) => {
    const response = await call(docUrl(id));
    if (response.status === 404) return { entry: null, exists: false, updateTime: undefined };
    if (!response.ok) throw new Error(`Firestore read failed (${response.status})`);
    const doc = await response.json();
    return { entry: parse(doc), exists: true, updateTime: doc.updateTime as string | undefined };
  };
  const collided = async (response: Response) => {
    if (response.status === 409 || response.status === 412) return true;
    if (response.status !== 400) return false;
    return /FAILED_PRECONDITION|ABORTED/.test(await response.clone().text());
  };

  return {
    async get(id) {
      return (await load(id)).entry?.value ?? null;
    },
    async mutate(id, fn, meta) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const { entry, exists, updateTime } = await load(id);
        const before = entry?.value ?? null;
        const next = fn(before);
        if (next === undefined) return before;
        const precondition = exists && updateTime
          ? `currentDocument.updateTime=${encodeURIComponent(updateTime)}`
          : "currentDocument.exists=false";
        const response = next === null
          ? await call(`${docUrl(id)}?${precondition}`, { method: "DELETE" })
          : await call(`${docUrl(id)}?${precondition}`, {
              method: "PATCH",
              body: JSON.stringify({
                fields: {
                  json: { stringValue: JSON.stringify(next) },
                  ownerKey: { stringValue: metaOf(meta, next).ownerKey },
                  expireAt: { timestampValue: metaOf(meta, next).expireAt.toISOString() },
                },
              }),
            });
        if (response.ok || (next === null && response.status === 404)) return next;
        if (await collided(response)) {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * (attempt + 1)));
          continue;
        }
        throw new Error(`Firestore write failed (${response.status})`);
      }
      throw new Contention(id);
    },
    async listByOwner(ownerKey) {
      const response = await call(`${base}:runQuery`, {
        method: "POST",
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: collection }],
            where: { fieldFilter: { field: { fieldPath: "ownerKey" }, op: "EQUAL", value: { stringValue: ownerKey } } },
          },
        }),
      });
      if (!response.ok) throw new Error(`Firestore query failed (${response.status})`);
      const rows = (await response.json()) as { document?: unknown }[];
      return rows
        .map((row) => (row.document ? parse(row.document) : null))
        .filter((entry): entry is Stored<T> => Boolean(entry))
        .map((entry) => entry.value);
    },
  };
}
