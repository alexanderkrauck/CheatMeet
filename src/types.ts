import type { MeetingTranscript } from "../shared/transcription";
export interface ReportData {
  id: string;
  date: string;
  updatedAt?: string;
  projectName?: string;
  title: string;
  /** The model's own title, kept when the user typed their own. */
  suggestedTitle?: string;
  summary: string;
  transcription: string;
  speech?: MeetingTranscript;
  todos: string[];
  takeaways: string[];
  status?: "pending" | "analyzing" | "completed" | "error";
  error?: string;
  durationMs?: number;
  captureState?: "recording" | "paused" | "stopped";
  transcriptionOrigin?: "live" | "import";
  captureSources?: ("mic" | "system")[];
  /** User confirms one person for the entire recording on each selected source. */
  singleSpeakerSources?: Partial<Record<"mic" | "system", boolean>>;
  rawAudioUrl?: string; // Legacy name: a private Drive file ID, not a URL
  driveFolderId?: string;
  driveReportId?: string;
  driveMarkdownId?: string;
  driveTranscriptId?: string;
  driveSyncedAt?: string;
}

export interface Draft {
  report: ReportData;
  /** Legacy live snapshot from versions that performed a second transcription. */
  speakerReference?: MeetingTranscript;
  audio?: Blob;
}
