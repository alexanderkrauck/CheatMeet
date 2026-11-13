/** Provider binding is application-owned, never inferred from a file ID. */
export type ServiceProvider = 'google' | 'microsoft';
export interface MicrosoftHome {
  provider: 'microsoft';
  connectionId: string;
  driveId: string;
  rootId: string;
  rootName: string;
  folderId?: string;
  reportId?: string;
  audioId?: string;
  markdownId?: string;
  transcriptId?: string;
  consentId?: string;
  webUrl?: string;
  syncedAt?: string;
}
const ids = ['connectionId','driveId','rootId','folderId','reportId','audioId','markdownId','transcriptId','consentId'] as const;
const allowed = new Set<string>(['provider','rootName','webUrl','syncedAt', ...ids]);
export function microsoftHome(value: unknown): MicrosoftHome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Ungültiger OneDrive-Speicherort.');
  const v = value as Record<string, unknown>;
  if (v.provider !== 'microsoft' || Object.keys(v).some(k => !allowed.has(k))) throw Error('Ungültiger OneDrive-Speicherort.');
  for (const k of ids) {
    if (v[k] === undefined && !['connectionId','driveId','rootId'].includes(k)) continue;
    if (typeof v[k] !== 'string' || !v[k] || v[k].length > 512 || /[\s/\\?#:\x00-\x1f]/.test(v[k] as string)) throw Error('Ungültige OneDrive-Dateireferenz.');
  }
  if (typeof v.rootName !== 'string' || !v.rootName.trim() || v.rootName.length > 500) throw Error('OneDrive-Ordnername fehlt.');
  if (v.webUrl !== undefined && (typeof v.webUrl !== 'string' || !safeMicrosoftLink(v.webUrl))) throw Error('Ungültiger OneDrive-Link.');
  if (v.syncedAt !== undefined && (typeof v.syncedAt !== 'string' || !Number.isFinite(Date.parse(v.syncedAt)))) throw Error('Ungültiger Sicherungszeitpunkt.');
  return {...v} as unknown as MicrosoftHome;
}
export function safeMicrosoftLink(value: string): boolean {
  try {
    const u = new URL(value);
    const navigationOnly = [...u.searchParams.keys()].every(k => ['id','cid','resid','parId','qt','o','ithint'].includes(k));
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && navigationOnly &&
      (u.hostname === 'onedrive.live.com' || u.hostname.endsWith('.sharepoint.com'));
  } catch { return false; }
}
export const reportIndexCollection = (r: {home?: unknown}) => r.home ? 'meetings' : 'reports';
export function archiveFolderLink(r: {home?: MicrosoftHome;driveFolderId?: string}): string | undefined {
  if (r.home) return r.home.webUrl && safeMicrosoftLink(r.home.webUrl) ? r.home.webUrl : undefined;
  return r.driveFolderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(r.driveFolderId)}` : undefined;
}
export const archiveAudioId = (r: {home?: MicrosoftHome;rawAudioUrl?: string}) => r.home ? r.home.audioId : r.rawAudioUrl;
export const archiveReportId = (r: {home?: MicrosoftHome;driveReportId?: string}) => r.home ? r.home.reportId : r.driveReportId;
export const archiveSyncedAt = (r: {home?: MicrosoftHome;driveSyncedAt?: string}) => r.home ? r.home.syncedAt : r.driveSyncedAt;
