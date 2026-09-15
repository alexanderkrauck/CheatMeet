import { fromArchive } from "./archive";
import { ensureDriveToken, rememberToken } from "./session";
// A cached token alone does not prove the Drive scope was granted. Check it
// before capture without creating folders or reading filenames/media.
export async function verifyDriveAccess(token: string): Promise<void> {
  const response = await fetch(
    "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=kind",
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    rememberToken(undefined);
    throw new Error(
      "Google Drive ist nicht freigegeben oder die Freigabe ist abgelaufen. Bitte Google Drive erneut verbinden und den Zugriff erlauben.",
    );
  }
  throw new Error(
    "Google Drive ist gerade nicht erreichbar. Bitte die Verbindung prüfen und erneut versuchen.",
  );
}

/** Metadata calls are small and should fail fast; a media upload must not. */
const METADATA_TIMEOUT_MS = 120_000;
/**
 * The slowest link a recording is still expected to survive. A two-minute
 * deadline sized for a JSON call was aborting hour-long audio on any ordinary
 * connection, and the abort surfaced as an English DOMException.
 */
const MIN_UPLOAD_BYTES_PER_SEC = 40_000;
export const uploadTimeoutMs = (bytes: number) =>
  Math.max(METADATA_TIMEOUT_MS, Math.ceil(bytes / MIN_UPLOAD_BYTES_PER_SEC) * 1000);

async function request(
  url: string,
  token: string,
  init: RequestInit = {},
  timeoutMs = METADATA_TIMEOUT_MS,
  retry = true,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError")
      throw new Error(
        "Google Drive hat zu lange gebraucht. Bitte die Verbindung prüfen und erneut versuchen.",
      );
    throw new Error(
      "Google Drive ist nicht erreichbar. Bitte die Verbindung prüfen und erneut versuchen.",
    );
  }
  if (!response.ok) {
    if (response.status === 401) {
      rememberToken(undefined);
      // A background job can run for half an hour on a token minted at its
      // start. A 401 proves nothing was created, and every body here is
      // re-sendable, so one silent re-mint and retry is safe.
      if (retry) {
        const fresh = await ensureDriveToken(0);
        if (fresh && fresh !== token)
          return request(url, fresh, init, timeoutMs, false);
      }
      throw new Error(
        "Die Drive-Verbindung ist abgelaufen. Bitte Google Drive erneut verbinden.",
      );
    }
    throw new Error(
      `Google Drive: ${response.status === 403 ? "Zugriff verweigert. Bitte Drive freigeben." : `Anfrage fehlgeschlagen (${response.status}). Bitte erneut versuchen.`}`,
    );
  }
  return response;
}
/** The name the default folder actually carries in Drive. Every label that
 *  names it reads this, so the app cannot promise a folder that is not there. */
export const DEFAULT_FOLDER_NAME = "CheatMeet Recordings (App)";

export async function findOrCreateRootFolder(token: string): Promise<string> {
  const q = encodeURIComponent(
    `name = '${DEFAULT_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const data = await (
    await request(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive`,
      token,
    )
  ).json();
  return (
    data.files?.[0]?.id ||
    createSubFolder(DEFAULT_FOLDER_NAME, undefined, token)
  );
}
export async function createSubFolder(
  name: string,
  parentId: string | undefined,
  token: string,
): Promise<string> {
  const data = await (
    await request(
      "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true",
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: "application/vnd.google-apps.folder",
          ...(parentId ? { parents: [parentId] } : {}),
        }),
      },
    )
  ).json();
  return data.id;
}
export async function uploadFileToFolder(
  file: Blob,
  name: string,
  mimeType: string,
  parentId: string,
  token: string,
  existingId?: string,
): Promise<string> {
  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          name,
          mimeType,
          ...(!existingId ? { parents: [parentId] } : {}),
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.append("file", file);
  const data = await (
    await request(
      `https://www.googleapis.com/upload/drive/v3/files${existingId ? `/${encodeURIComponent(existingId)}` : ""}?uploadType=multipart&supportsAllDrives=true`,
      token,
      { method: existingId ? "PATCH" : "POST", body: form },
      // Scaled to the payload: an hour of audio cannot cross the wire in the
      // time a metadata call is given.
      uploadTimeoutMs(file.size),
    )
  ).json();
  return data.id;
}
export async function downloadDriveFile(id: string, token: string) {
  return (
    await request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      token,
    )
  ).blob();
}

export async function getDriveFolder(
  id: string,
  token: string,
): Promise<{ id: string; name: string }> {
  const data = await (
    await request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`,
      token,
    )
  ).json();
  if (data.trashed || data.mimeType !== "application/vnd.google-apps.folder")
    throw new Error(
      "Der gewählte Drive-Ordner existiert nicht mehr. Bitte einen anderen Speicherort wählen.",
    );
  if (data.capabilities?.canAddChildren === false)
    throw new Error(
      "In diesem Drive-Ordner darfst du keine Dateien speichern. Bitte einen anderen Ordner wählen.",
    );
  return { id: data.id, name: data.name };
}
/** One file by exact name inside a folder, or undefined. */
export async function findFileInFolder(
  name: string,
  parentId: string,
  token: string,
): Promise<string | undefined> {
  const escape = (value: string) =>
    value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const files = await listFiles(
    token,
    `'${escape(parentId)}' in parents and name = '${escape(name)}' and trashed = false`,
  );
  return files[0]?.id;
}

async function listFiles(
  token: string,
  query: string,
): Promise<{ id: string; name: string }[]> {
  const files: { id: string; name: string }[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: query,
      fields: "files(id,name),nextPageToken",
      pageSize: "100",
      spaces: "drive",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await (
      await request(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        token,
      )
    ).json();
    files.push(...(page.files || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return files;
}
export async function listDriveReports(
  token: string,
  rootId: string,
): Promise<{ reports: import("../types").ReportData[]; warnings: string[] }> {
  const escape = (value: string) =>
    value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const folders = await listFiles(
    token,
    `'${escape(rootId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const reports: import("../types").ReportData[] = [];
  const warnings: string[] = [];
  for (const folder of folders) {
    const files = await listFiles(
      token,
      `'${escape(folder.id)}' in parents and name = 'bericht_daten.json' and trashed = false`,
    );
    for (const file of files) {
      try {
        const parsed = JSON.parse(
          await (await downloadDriveFile(file.id, token)).text(),
        );
        // One boundary owns what a stored meeting may contain, so an
        // externally edited file cannot inject keys into the local store.
        reports.push(
          fromArchive(parsed, {
            driveFolderId: folder.id,
            driveReportId: file.id,
          }),
        );
      } catch (error) {
        if (!driveConnectionValid(error)) throw error;
        warnings.push(
          `„${folder.name}“ konnte nicht gelesen werden: ${error instanceof Error ? error.message : "Ungültiger Bericht"}`,
        );
      }
    }
  }
  return { reports, warnings };
}
function driveConnectionValid(error: unknown) {
  return !(error instanceof Error && error.message.includes("abgelaufen"));
}

/**
 * Moves a meeting's folder to the Drive trash. Trash, not a permanent delete:
 * the folder holds the only copy of the audio, and Drive's own bin is the
 * safety net a user already understands.
 *
 * A folder that is already gone is not an error — deleting twice must succeed.
 */
export async function trashDriveFile(id: string, token: string) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
      signal: AbortSignal.timeout(60000),
    },
  );
  if (response.ok || response.status === 404) return;
  if (response.status === 401) {
    rememberToken(undefined);
    throw new Error(
      "Die Drive-Verbindung ist abgelaufen. Bitte Google Drive erneut verbinden.",
    );
  }
  throw new Error(
    `Die Datei konnte nicht aus Drive gelöscht werden (${response.status}).`,
  );
}
