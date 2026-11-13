import {
  microsoftApi,
  microsoftRequest,
  microsoftOwner,
  microsoftRetryAfter,
} from "./microsoft";
import type { MicrosoftHome } from "../../shared/storage";
export interface OneDriveItem {
  id: string;
  name?: string;
  size?: number;
  eTag?: string;
  webUrl?: string;
  folder?: object;
  parentReference?: { driveId: string; id?: string };
}
const enc = encodeURIComponent;
const revisionKey = (home: MicrosoftHome, id: string) =>
  `cheatmeet:microsoft-revision:${microsoftOwner().owner}:${home.connectionId}:${home.driveId}:${id}`;
function knownRevision(home: MicrosoftHome, id: string) {
  try {
    return localStorage.getItem(revisionKey(home, id));
  } catch {
    return null;
  }
}
function rememberRevision(home: MicrosoftHome, item: OneDriveItem) {
  if (item.eTag)
    try {
      localStorage.setItem(revisionKey(home, item.id), item.eTag);
    } catch {
      /* no persistent cache; conditional writes still require explicit restoration */
    }
}
export const itemPath = (home: Pick<MicrosoftHome, "driveId">, id: string) =>
  `/drives/${enc(home.driveId)}/items/${enc(id)}`;
async function json<T>(
  path: string,
  init: RequestInit,
  connectionId: string,
): Promise<T> {
  const { check } = microsoftOwner();
  const r = await microsoftRequest(path, init, connectionId);
  check();
  const data = await r.json();
  check();
  return data as T;
}
export async function oneDriveRoot(
  connectionId: string,
): Promise<OneDriveItem> {
  return json("/me/drive/root", {}, connectionId);
}
export async function listOneDriveFolders(
  connectionId: string,
  driveId?: string,
  parentId?: string,
): Promise<OneDriveItem[]> {
  const { check } = microsoftOwner();
  let path =
    driveId && parentId
      ? `${itemPath({ driveId }, parentId)}/children?$select=id,name,folder,parentReference,webUrl`
      : "/me/drive/root/children?$select=id,name,folder,parentReference,webUrl";
  const out: OneDriveItem[] = [];
  while (path) {
    const page = await json<{
      value: OneDriveItem[];
      "@odata.nextLink"?: string;
    }>(path, {}, connectionId);
    check();
    out.push(...page.value.filter((v) => v.folder));
    path = page["@odata.nextLink"] || "";
  }
  return out;
}
export async function getOneDriveItem(home: MicrosoftHome, id: string) {
  return json<OneDriveItem>(itemPath(home, id), {}, home.connectionId);
}
export async function createOneDriveFolder(
  home: MicrosoftHome,
  name: string,
): Promise<OneDriveItem> {
  const { check } = microsoftOwner();
  const existing = (await listOneDriveItems(home, home.rootId)).find(
    (item) => item.name === name,
  );
  check();
  if (existing) {
    if (!existing.folder)
      throw Error(
        "Der Meetingname ist in OneDrive bereits durch eine Datei belegt.",
      );
    return existing;
  }
  return json(
    `${itemPath(home, home.rootId)}/children`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
    home.connectionId,
  );
}
export async function listOneDriveItems(home: MicrosoftHome, parentId: string) {
  const out: OneDriveItem[] = [];
  let path = `${itemPath(home, parentId)}/children`;
  while (path) {
    const page = await json<{
      value: OneDriveItem[];
      "@odata.nextLink"?: string;
    }>(path, {}, home.connectionId);
    out.push(...page.value);
    path = page["@odata.nextLink"] || "";
  }
  return out;
}
export async function downloadOneDrive(
  home: MicrosoftHome,
  id: string,
): Promise<Blob> {
  // Graph /content redirects to a preauthenticated URL. Resolve it from metadata,
  // then fetch without a Graph bearer. Never persist that capability.
  const { check } = microsoftOwner();
  const item = await json<
    OneDriveItem & { "@microsoft.graph.downloadUrl"?: string }
  >(itemPath(home, id), {}, home.connectionId);
  check();
  const url = item["@microsoft.graph.downloadUrl"];
  if (!url || new URL(url).protocol !== "https:")
    throw new Error("OneDrive hat keinen sicheren Download bereitgestellt.");
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(120_000),
  });
  check();
  if (!response.ok)
    throw new Error(`OneDrive-Download fehlgeschlagen (${response.status}).`);
  const blob = await response.blob();
  check();
  rememberRevision(home, item);
  return blob;
}
export async function trashOneDrive(home: MicrosoftHome, id: string) {
  await microsoftRequest(
    itemPath(home, id),
    { method: "DELETE" },
    home.connectionId,
  );
}
const FRAGMENT = 10 * 320 * 1024;
export async function uploadOneDrive(
  home: MicrosoftHome,
  blob: Blob,
  name: string,
  options: {
    reportId?: string;
    handle?: string;
    itemId?: string;
    etag?: string;
    checkpoint?: (handle: string) => Promise<void>;
  } = {},
): Promise<OneDriveItem> {
  const { check } = microsoftOwner();
  if (!home.folderId) throw new Error("OneDrive-Meetingordner fehlt.");
  let handle = options.handle;
  if (handle) {
    try {
      const completed = await microsoftApi<OneDriveItem>("uploads/complete", {
        handle,
      });
      check();
      if (!completed.id || completed.size !== blob.size)
        throw Error("OneDrive konnte die vollständige Datei nicht bestätigen.");
      rememberRevision(home, completed);
      return completed;
    } catch (error) {
      check();
      if (![404, 409, 410].includes((error as { status?: number }).status || 0))
        throw error;
    }
  }
  if (!handle) {
    const created = await microsoftApi<{ handle: string }>("uploads", {
      connectionId: home.connectionId,
      driveId: home.driveId,
      parentId: home.folderId,
      name,
      size: blob.size,
      ...(options.reportId ? { reportId: options.reportId } : {}),
      ...(options.itemId ? { itemId: options.itemId, etag: options.etag } : {}),
    });
    check();
    handle = created.handle;
    if (!handle) throw new Error("OneDrive-Uploadsitzung fehlt.");
    await options.checkpoint?.(handle);
    check();
  }
  const session = await microsoftApi<{
    uploadUrl: string;
    nextExpectedRanges: string[];
    expirationDateTime: string;
  }>("uploads/session", { handle });
  check();
  if (
    !Number.isFinite(Date.parse(session.expirationDateTime)) ||
    Date.parse(session.expirationDateTime) <= Date.now()
  )
    throw Object.assign(
      new Error(
        "OneDrive-Uploadsitzung abgelaufen. Bitte den Upload erneut starten.",
      ),
      { status: 410 },
    );
  if (new URL(session.uploadUrl).protocol !== "https:")
    throw new Error("Ungültige OneDrive-Uploadadresse.");
  let offset =
    Array.isArray(session.nextExpectedRanges) &&
    session.nextExpectedRanges.length === 0
      ? blob.size
      : Number(session.nextExpectedRanges?.[0]?.split("-")[0] || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > blob.size)
    throw new Error("Ungültiger OneDrive-Uploadfortschritt.");
  while (offset < blob.size) {
    check();
    const end = Math.min(offset + FRAGMENT, blob.size);
    const response = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes ${offset}-${end - 1}/${blob.size}`,
        "Content-Type": "application/octet-stream",
      },
      body: blob.slice(offset, end),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    check();
    if (!response.ok)
      throw Object.assign(
        new Error(
          `OneDrive-Upload fehlgeschlagen (${response.status}). Der lokale Entwurf bleibt erhalten.`,
        ),
        {
          status: response.status,
          retryAfterMs: microsoftRetryAfter(response),
        },
      );
    if (response.status === 200 || response.status === 201) {
      offset = blob.size;
      break;
    }
    const data = await response.json();
    check();
    // deferCommit update sessions accept all bytes before the owner-authenticated
    // complete endpoint performs the conditional commit. This is NOT durability.
    if (
      response.status === 202 &&
      end === blob.size &&
      Array.isArray(data.nextExpectedRanges) &&
      data.nextExpectedRanges.length === 0
    ) {
      offset = blob.size;
      break;
    }
    const next = Number(data.nextExpectedRanges?.[0]?.split("-")[0]);
    if (!Number.isSafeInteger(next) || next <= offset || next > blob.size)
      throw new Error(
        "OneDrive hat keinen gültigen Uploadfortschritt bestätigt.",
      );
    offset = next;
  }
  const item = await microsoftApi<OneDriveItem>("uploads/complete", { handle });
  check();
  if (!item.id || item.size !== blob.size)
    throw new Error("OneDrive konnte die vollständige Datei nicht bestätigen.");
  rememberRevision(home, item);
  return item;
}
export async function writeOneDriveText(
  home: MicrosoftHome,
  name: string,
  text: string,
  itemId?: string,
) {
  const { check } = microsoftOwner();
  let etag: string | undefined;
  if (!itemId) {
    if (!home.folderId) throw Error("OneDrive-Meetingordner fehlt.");
    const existing = (await listOneDriveItems(home, home.folderId)).find(
      (item) => item.name === name,
    );
    check();
    if (existing) {
      const blob = await downloadOneDrive(home, existing.id);
      check();
      const stored = await blob.text();
      check();
      if (stored === text) return existing;
      throw Error(
        "Eine gleichnamige OneDrive-Datei enthält andere Daten. Bitte das Meeting zuerst wiederherstellen; es wurde nichts überschrieben.",
      );
    }
  }
  if (itemId) {
    etag = await assertOneDriveRevision(
      home,
      itemId,
      name === "bericht_daten.json",
    );
    check();
    // Small archive text uses Graph's native atomic update on both account types.
    // Deferred sourceUrl commits are not supported by Business OneDrive.
    const size=new Blob([text]).size;
    if(size>250*1024*1024)throw Error('Die Textdatei ist für eine sichere OneDrive-Aktualisierung zu groß.');
    const item=await json<OneDriveItem>(`${itemPath(home,itemId)}/content`,{
      method:'PUT',headers:{'Content-Type':name.endsWith('.json')?'application/json':'text/markdown;charset=utf-8','If-Match':etag},body:text,
    },home.connectionId);
    check();
    if(item.id!==itemId||item.size!==size||!item.eTag)throw Error('OneDrive konnte die aktualisierte Datei nicht bestätigen.');
    rememberRevision(home,item);
    return item;
  }
  return uploadOneDrive(
    home,
    new Blob([text], {
      type: name.endsWith(".json")
        ? "application/json"
        : "text/markdown;charset=utf-8",
    }),
    name,
    { itemId, etag },
  );
}
export async function assertOneDriveRevision(
  home: MicrosoftHome,
  itemId: string,
  required = true,
) {
  const { check } = microsoftOwner();
  const expected = knownRevision(home, itemId);
  const etag = (await getOneDriveItem(home, itemId)).eTag;
  check();
  if (!etag || (expected && expected !== etag) || (required && !expected))
    throw new Error(
      "Die OneDrive-Dateiversion ist neu oder unbekannt. Bitte zuerst aus OneDrive wiederherstellen; die vorhandene Datei wurde nicht überschrieben.",
    );
  return etag;
}
