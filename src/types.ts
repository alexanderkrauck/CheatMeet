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
  driveFolderId?: string;
  driveReportId?: string;
  driveMarkdownId?: string;
  driveTranscriptId?: string;
  driveSyncedAt?: string;
}

export interface Draft {
  report: ReportData;
  audio?: Blob;
}
