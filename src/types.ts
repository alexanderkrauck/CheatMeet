export interface RoomReport {
  name: string;
  transcription: string;
  summary: string;
  photoIds: string[];
  tags?: string[];
  startTimeMs?: number;
  endTimeMs?: number;
  photoUrls?: string[]; // Legacy Drive IDs
}
export interface ReportData {
  id: string;
  date: string;
  updatedAt?: string;
  projectName?: string;
  title: string;
  summary: string;
  transcription: string;
  todos: string[];
  takeaways: string[];
  status?: "pending" | "analyzing" | "completed" | "error";
  error?: string;
  durationMs?: number;
  captureState?: "recording" | "paused" | "stopped";
  rawAudioUrl?: string; // Legacy name: a private Drive file ID, not a URL
  rawPhotoUrls?: string[];
  photos?: { id: string; relativeTimeMs: number | null; driveId?: string }[];
  driveFolderId?: string;
  driveReportId?: string;
  driveMarkdownId?: string;
  driveTranscriptId?: string;
  driveSyncedAt?: string;
}
export interface CapturedPhoto {
  id: string;
  blob: Blob;
  relativeTimeMs: number | null;
}
export interface Draft {
  report: ReportData;
  audio?: Blob;
  photos: CapturedPhoto[];
}
