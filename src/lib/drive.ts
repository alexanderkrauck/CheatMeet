import { rememberToken } from "./session";
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

async function request(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    if (response.status === 401) {
      rememberToken(undefined);
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
export async function findOrCreateRootFolder(token: string): Promise<string> {
  const q = encodeURIComponent(
    "name = 'CheatMeet Recordings (App)' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
  );
  const data = await (
    await request(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive`,
      token,
    )
  ).json();
  return (
    data.files?.[0]?.id ||
    createSubFolder("CheatMeet Recordings (App)", undefined, token)
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
      "In diesem Drive-Ordner dürfen Sie keine Dateien speichern. Bitte einen anderen Ordner wählen.",
    );
  return { id: data.id, name: data.name };
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
        const report = JSON.parse(
          await (await downloadDriveFile(file.id, token)).text(),
        );
        if (
          !report ||
          typeof report.id !== "string" ||
          typeof report.title !== "string" ||
          typeof report.date !== "string" ||
          !Number.isFinite(Date.parse(report.date)) ||
          !Array.isArray(report.rooms)
        )
          throw new Error("Ungültige Berichtsdaten");
        // Validate fields rendered by report views before admitting external JSON.
        if (
          !report.rooms.every(
            (room: any) =>
              typeof room.name === "string" &&
              typeof room.summary === "string" &&
              typeof room.transcription === "string" &&
              (!room.tags ||
                (Array.isArray(room.tags) &&
                  room.tags.every(
                    (tag: unknown) => typeof tag === "string",
                  ))) &&
              (!room.photoUrls ||
                (Array.isArray(room.photoUrls) &&
                  room.photoUrls.every(
                    (id: unknown) => typeof id === "string",
                  ))) &&
              (!room.photoIds ||
                (Array.isArray(room.photoIds) &&
                  room.photoIds.every(
                    (id: unknown) => typeof id === "string",
                  ))),
          )
        )
          throw new Error("Ungültige Raumdaten");
        for (const field of ["rawPhotoUrls"])
          if (
            report[field] !== undefined &&
            (!Array.isArray(report[field]) ||
              !report[field].every((id: unknown) => typeof id === "string"))
          )
            throw new Error("Ungültige Dateiverweise");
        if (
          report.rawAudioUrl !== undefined &&
          typeof report.rawAudioUrl !== "string"
        )
          throw new Error("Ungültige Audioreferenz");
        if (
          report.photos !== undefined &&
          (!Array.isArray(report.photos) ||
            !report.photos.every(
              (photo: any) =>
                photo &&
                typeof photo.id === "string" &&
                (photo.driveId === undefined ||
                  typeof photo.driveId === "string") &&
                (photo.relativeTimeMs === null ||
                  (typeof photo.relativeTimeMs === "number" &&
                    Number.isFinite(photo.relativeTimeMs) &&
                    photo.relativeTimeMs >= 0)),
            ))
        )
          throw new Error("Ungültige Fotodaten");
        if (
          report.updatedAt !== undefined &&
          (typeof report.updatedAt !== "string" ||
            !Number.isFinite(Date.parse(report.updatedAt)))
        )
          delete report.updatedAt;
        if (
          !["pending", "analyzing", "completed", "error"].includes(
            report.status,
          )
        )
          report.status = "pending";
        if (typeof report.error !== "string") delete report.error;
        report.summary =
          typeof report.summary === "string" ? report.summary : "";
        report.rooms = report.rooms.map((room: any) => ({
          ...room,
          photoIds: room.photoIds || [],
        }));
        reports.push({
          ...report,
          driveFolderId: folder.id,
          driveReportId: file.id,
        });
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
