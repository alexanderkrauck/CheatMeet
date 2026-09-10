import {
  createStore,
  get,
  set,
  del,
  entries,
  update,
  setMany,
  delMany,
  keys,
  getMany,
} from "idb-keyval";
import type { Draft, ReportData } from "../types";
const store = createStore("cheatmeet", "workspace");
const key = (uid: string, id: string) => `${uid}:report:${id}`;
export interface LocalReport {
  report: ReportData;
  dirty: boolean;
}
const listeners = new Set<(uid: string) => void>();
const channel =
  typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("cheatmeet:local-reports")
    : null;
function emit(uid: string, broadcast = true) {
  for (const listener of listeners) listener(uid);
  if (broadcast) channel?.postMessage(uid);
}
if (channel)
  channel.onmessage = (event) => {
    if (typeof event.data === "string") emit(event.data, false);
  };
export function watchLocalReports(uid: string, onChange: () => void) {
  const listener = (changedUser: string) => {
    if (uid === changedUser) onChange();
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export async function putLocal(uid: string, report: ReportData, dirty = true) {
  await set(key(uid, report.id), { report, dirty }, store);
  emit(uid);
}
// Check and update in one IndexedDB transaction: an older cloud response must not
// replace an edit that was saved while the network request was in flight.
export async function acceptRemoteReport(uid: string, report: ReportData) {
  let changed = false;
  await update<LocalReport>(
    key(uid, report.id),
    (existing) => {
      const sameRevision =
        !!report.updatedAt && report.updatedAt === existing?.report.updatedAt;
      if (existing?.dirty && !sameRevision) return existing;
      const remoteTime = Date.parse(report.updatedAt || report.date) || 0;
      const localTime = existing
        ? Date.parse(existing.report.updatedAt || existing.report.date) || 0
        : 0;
      if (existing && remoteTime < localTime) return existing;
      changed = true;
      return { report, dirty: false };
    },
    store,
  );
  if (changed) emit(uid);
}
export const getLocal = (uid: string, id: string) =>
  get<LocalReport>(key(uid, id), store);
export async function listLocal(uid: string) {
  return (await entries<string, LocalReport>(store))
    .filter(([k]) => k.startsWith(`${uid}:report:`))
    .map(([, v]) => v);
}
const draftKey = (uid: string, id: string) => `${uid}:draft:${id}`;
const activeDraftKey = (uid: string) => `${uid}:active-draft`;

// Preserve the old single-slot draft before any new capture can replace it.
// The old key is removed only after its per-recording copy has committed.
async function migrateDraft(uid: string) {
  const legacy = await get<Draft>(`${uid}:draft`, store);
  if (!legacy) return;
  await update<Draft>(
    draftKey(uid, legacy.report.id),
    (existing) => existing ?? legacy,
    store,
  );
  await del(`${uid}:draft`, store);
}

export async function putDraft(uid: string, draft: Draft) {
  await migrateDraft(uid);
  // IndexedDB commits both keys atomically. A quota failure leaves the previous
  // complete audio/photo snapshot intact and is surfaced to the recording UI.
  await setMany(
    [
      [draftKey(uid, draft.report.id), draft],
      [activeDraftKey(uid), draft.report.id],
    ],
    store,
  );
  emit(uid);
}

interface RecordingChunk {
  sequence: number;
  blob: Blob;
  durationMs: number;
}
const progressKey = (uid: string, id: string) =>
  `${uid}:capture-progress:${id}`;
const chunkPrefix = (uid: string, id: string) => `${uid}:audio-chunk:${id}:`;

// Each recorder event is committed independently; growing recordings never
// rewrite all previous audio on every autosave. Callers serialize chunk writes.
export async function appendRecordingChunk(
  uid: string,
  reportId: string,
  sequence: number,
  blob: Blob,
  durationMs: number,
) {
  if (!blob.size) return;
  await setMany(
    [
      [
        `${chunkPrefix(uid, reportId)}${sequence}`,
        { sequence, blob, durationMs } satisfies RecordingChunk,
      ],
      [progressKey(uid, reportId), { durationMs }],
    ],
    store,
  );
}

function recoverAudio(
  uid: string,
  draft: Draft,
  records: [string, unknown][],
): Draft {
  const chunks = records
    .filter(([k]) => k.startsWith(chunkPrefix(uid, draft.report.id)))
    .map(([, value]) => value as RecordingChunk)
    .sort((a, b) => a.sequence - b.sequence);
  if (!chunks.length) return draft;
  const journalBytes = chunks.reduce((sum, chunk) => sum + chunk.blob.size, 0);
  return {
    ...draft,
    audio:
      draft.audio && draft.audio.size >= journalBytes
        ? draft.audio
        : new Blob(
            chunks.map((chunk) => chunk.blob),
            {
              type: chunks[0].blob.type || draft.audio?.type || "audio/webm",
            },
          ),
    report: {
      ...draft.report,
      durationMs: Math.max(
        draft.report.durationMs || 0,
        ...chunks.map((chunk) => chunk.durationMs),
      ),
    },
  };
}

async function readMatchingRecords(
  matches: (key: string) => boolean,
): Promise<[string, unknown][]> {
  const selected = (await keys<string>(store)).filter(matches);
  const values = await getMany<unknown>(selected, store);
  return selected.map((key, index) => [key, values[index]]);
}

export async function listDrafts(
  uid: string,
  options: { includeAudio?: boolean } = {},
): Promise<Draft[]> {
  await migrateDraft(uid);
  const records = await readMatchingRecords(
    (key) =>
      key.startsWith(`${uid}:draft:`) ||
      key.startsWith(`${uid}:capture-progress:`) ||
      (options.includeAudio !== false && key.startsWith(`${uid}:audio-chunk:`)),
  );
  return records
    .filter(([k]) => k.startsWith(`${uid}:draft:`))
    .map(([, value]) => {
      const draft = value as Draft;
      if (options.includeAudio !== false)
        return recoverAudio(uid, draft, records);
      const progress = records.find(
        ([key]) => key === progressKey(uid, draft.report.id),
      )?.[1] as { durationMs: number } | undefined;
      return {
        ...draft,
        audio: undefined,
        report: {
          ...draft.report,
          durationMs: Math.max(
            draft.report.durationMs || 0,
            progress?.durationMs || 0,
          ),
        },
      };
    })
    .sort((a, b) =>
      (b.report.updatedAt || b.report.date).localeCompare(
        a.report.updatedAt || a.report.date,
      ),
    );
}

export async function getDraft(
  uid: string,
  id?: string,
): Promise<Draft | undefined> {
  await migrateDraft(uid);
  const selected = id || (await get<string>(activeDraftKey(uid), store));
  if (selected) {
    const draft = await get<Draft>(draftKey(uid, selected), store);
    if (draft) {
      const chunks = await readMatchingRecords((key) =>
        key.startsWith(chunkPrefix(uid, selected)),
      );
      return recoverAudio(uid, draft, chunks);
    }
    if (id) return undefined;
  }
  return (await listDrafts(uid))[0];
}

export async function deleteDraft(uid: string, id?: string) {
  const draft = await getDraft(uid, id);
  if (!draft) return;
  const storedKeys = await keys<string>(store);
  await delMany(
    [
      draftKey(uid, draft.report.id),
      progressKey(uid, draft.report.id),
      ...storedKeys.filter((k) =>
        k.startsWith(chunkPrefix(uid, draft.report.id)),
      ),
    ],
    store,
  );
  // Do not clear a newer capture's pointer if a different report finished saving.
  await update<string | undefined>(
    activeDraftKey(uid),
    (active) => (active === draft.report.id ? undefined : active),
    store,
  );
  emit(uid);
}
