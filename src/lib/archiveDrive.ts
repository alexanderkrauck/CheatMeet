import { findFileInFolder, uploadFileToFolder } from "./drive";
import { getRootFolder } from "./driveSettings";
import { listLocal } from "./local";
import {
  ARCHIVE_INDEX_NAME,
  ARCHIVE_SCHEMA_DOC,
  ARCHIVE_SCHEMA_NAME,
  buildArchiveIndex,
} from "./archiveIndex";

/**
 * Keeps the archive's overview and its self-description current.
 *
 * Best effort by design: this is a convenience for whoever — or whatever —
 * reads the folder later, and a meeting must never fail to save because an
 * overview could not be refreshed.
 */

/** Per session, so refreshing costs one lookup rather than one per save. */
const known = new Map<string, string>();

async function upsert(
  name: string,
  body: Blob,
  mime: string,
  rootId: string,
  token: string,
) {
  const cacheKey = `${rootId}:${name}`;
  const existing =
    known.get(cacheKey) ?? (await findFileInFolder(name, rootId, token));
  const id = await uploadFileToFolder(body, name, mime, rootId, token, existing);
  known.set(cacheKey, id);
}

export async function refreshArchiveIndex(
  owner: string,
  token: string,
  generatedAt: string,
) {
  const rootId = await getRootFolder(token);
  const reports = (await listLocal(owner)).map((entry) => entry.report);
  await upsert(
    ARCHIVE_INDEX_NAME,
    new Blob([JSON.stringify(buildArchiveIndex(reports, generatedAt), null, 2)], {
      type: "application/json",
    }),
    "application/json",
    rootId,
    token,
  );
  // Written next to the meetings so the layout explains itself to a reader who
  // has only the folder and no app.
  await upsert(
    ARCHIVE_SCHEMA_NAME,
    new Blob([ARCHIVE_SCHEMA_DOC], { type: "text/markdown;charset=utf-8" }),
    "text/markdown",
    rootId,
    token,
  );
}

/** Test seam: a fresh session must look the files up again. */
export const forgetArchiveIndexIds = () => known.clear();
