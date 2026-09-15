import type { Todo } from "../shared/analysis";
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
  /** Legacy documents hold plain strings; `asTodos` normalises on read. */
  todos: Todo[];
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
  /** The calendar event this meeting belongs to, once matched or created. */
  calendarEventId?: string;
  calendarId?: string;
  calendarLink?: string;
  calendarSyncedAt?: string;
  /** Why the last calendar attempt did not do what was asked. */
  calendarError?: string;
}

export interface Draft {
  report: ReportData;
  /** Legacy live snapshot from versions that performed a second transcription. */
  speakerReference?: MeetingTranscript;
  audio?: Blob;
}
