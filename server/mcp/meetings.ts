import { asTodos, type Todo } from "../../shared/analysis";

/** What the MCP tools know about one meeting, read from the user's Firestore index. */
export interface IndexEntry {
  id: string;
  date: string;
  title: string;
  summary: string;
  todos: Todo[];
  takeaways: string[];
  participants: string[];
  status?: string;
  projectName?: string;
  durationMs?: number;
  updatedAt?: string;
  /** >0 means a transcript exists somewhere, not necessarily here. */
  transcriptChars?: number;
  driveTranscriptId?: string;
}
export interface MeetingIndex {
  list(uid: string): Promise<IndexEntry[]>;
}
export interface TranscriptReader {
  /** The full `transkript.md` of a file the account owns. */
  read(googleSub: string, fileId: string): Promise<string>;
}

export type TranscriptFailure = "not_found" | "drive_revoked" | "drive_unavailable";
export class TranscriptError extends Error {
  constructor(readonly reason: TranscriptFailure) {
    super(reason);
  }
}

// ---- Firestore REST value decoding -------------------------------------------

type FirestoreValue = Record<string, any>;
function decodeValue(value: FirestoreValue | undefined): unknown {
  if (!value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue?.values ?? []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue?.fields);
  return null;
}
export function decodeFields(fields: Record<string, FirestoreValue> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([key, value]) => [key, decodeValue(value)]));
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
export function toIndexEntry(raw: Record<string, unknown>): IndexEntry | null {
  const id = str(raw.id);
  if (!id) return null;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  return {
    id,
    date: str(raw.date),
    title: str(raw.title) || "Ohne Titel",
    summary: str(raw.summary),
    todos: asTodos(raw.todos),
    takeaways: strings(raw.takeaways),
    participants: strings(raw.participants),
    status: str(raw.status) || undefined,
    projectName: str(raw.projectName) || undefined,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
    updatedAt: str(raw.updatedAt) || undefined,
    transcriptChars: typeof raw.transcriptChars === "number" ? raw.transcriptChars : undefined,
    driveTranscriptId: str(raw.driveTranscriptId) || undefined,
  };
}

const FIELDS = ["id", "date", "title", "summary", "todos", "takeaways", "participants", "status", "projectName", "durationMs", "updatedAt", "transcriptChars", "driveTranscriptId"];

/**
 * `users/{uid}/reports`, read with the runtime identity. Only the index fields
 * are requested; a projected report never held the transcript in the first place.
 */
export function firestoreReportIndex(options: {
  projectId: string;
  databaseId: string;
  fetchImpl: typeof fetch;
  token: () => Promise<string>;
}): MeetingIndex {
  const { projectId, databaseId, fetchImpl } = options;
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents/users`;
  return {
    async list(uid) {
      const found: IndexEntry[] = [];
      let pageToken = "";
      for (let page = 0; page < 40; page++) {
        const url = new URL(`${base}/${encodeURIComponent(uid)}/reports`);
        url.searchParams.set("pageSize", "300");
        for (const field of FIELDS) url.searchParams.append("mask.fieldPaths", field);
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${await options.token()}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 404) break;
        if (!response.ok) throw new Error(`Firestore list failed (${response.status})`);
        const body = (await response.json()) as { documents?: { fields?: Record<string, FirestoreValue> }[]; nextPageToken?: string };
        for (const doc of body.documents ?? []) {
          const entry = toIndexEntry(decodeFields(doc.fields));
          if (entry) found.push(entry);
        }
        pageToken = body.nextPageToken ?? "";
        if (!pageToken) break;
      }
      return found;
    },
  };
}

/**
 * Drive reads with a token minted from the server-held refresh token. The
 * token stays in this process; a tool result never contains it.
 */
export function driveTranscriptReader(options: {
  refreshToken: (googleSub: string) => Promise<string | null>;
  mint: (refreshToken: string) => Promise<{ accessToken: string; expiresInSeconds: number }>;
  fetchImpl: typeof fetch;
  now?: () => number;
  maxBytes?: number;
}): TranscriptReader {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { token: string; until: number }>();
  const limit = options.maxBytes ?? 20 * 1024 * 1024;
  const tokenFor = async (googleSub: string) => {
    const cached = cache.get(googleSub);
    if (cached && cached.until > now()) return cached.token;
    const refreshToken = await options.refreshToken(googleSub).catch(() => {
      throw new TranscriptError("drive_unavailable");
    });
    if (!refreshToken) throw new TranscriptError("drive_revoked");
    try {
      const minted = await options.mint(refreshToken);
      cache.set(googleSub, { token: minted.accessToken, until: now() + Math.max(0, minted.expiresInSeconds - 120) * 1000 });
      return minted.accessToken;
    } catch (error) {
      if ((error as { code?: string }).code === "invalid_grant") throw new TranscriptError("drive_revoked");
      throw new TranscriptError("drive_unavailable");
    }
  };
  return {
    async read(googleSub, fileId) {
      if (!/^[A-Za-z0-9_-]{6,200}$/.test(fileId)) throw new TranscriptError("not_found");
      const token = await tokenFor(googleSub);
      let response: Response;
      try {
        response = await options.fetchImpl(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) },
        );
      } catch {
        throw new TranscriptError("drive_unavailable");
      }
      if (response.status === 404) throw new TranscriptError("not_found");
      // drive.file: a file this app did not create answers 404/403 alike.
      if (response.status === 403) throw new TranscriptError("not_found");
      if (response.status === 401) {
        cache.delete(googleSub);
        throw new TranscriptError("drive_unavailable");
      }
      if (!response.ok) throw new TranscriptError("drive_unavailable");
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > limit) throw new TranscriptError("drive_unavailable");
      const text = await response.text();
      if (text.length > limit) throw new TranscriptError("drive_unavailable");
      return text;
    },
  };
}
