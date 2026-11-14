import type { Todo } from "../shared/analysis";
import type { ConsentRecord } from "../shared/consent";
import type { MeetingTranscript } from "../shared/transcription";
import type { MicrosoftHome, ServiceProvider } from "../shared/storage";
export interface ReportData {
  /** Microsoft meetings never reuse the legacy Google file-ID fields. */
  home?: MicrosoftHome;
  calendarProvider?: ServiceProvider;
  calendarConnectionId?: string;
  id: string;
  date: string;
  updatedAt?: string;
  projectName?: string;
  title: string;
  /** The model's own title, kept when the user typed their own. */
  suggestedTitle?: string;
  summary: string;
  /** Corrections require an explicit text-only summary refresh, never automatic ASR. */
  summaryNeedsRefresh?: boolean;
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
  driveConsentId?: string;
  driveSyncedAt?: string;
  /** Last-known canonical baseline while local/index changes await archive save. */
  archiveBaseSyncedAt?: string;
  /**
   * What the participants were actually told, frozen at the moment they were
   * told it. The retention promised here is the retention the sweep enforces,
   * so the two can never drift apart.
   */
  consent?: ConsentRecord;
  /** Set only after Drive confirmed the audio was moved to the trash. */
  audioDeletedAt?: string;
  audioDeleteAttempts?: number;
  audioDeleteError?: string;
  /** >0 means a transcript exists, but not on this device. */
  transcriptChars?: number;
  /** Bounded content version used to detect stale same-device transcript caches. */
  transcriptRevision?: string;
  /** Device-local stale-content warning, not evidence of a newer transcript's text. */
  transcriptStale?: boolean;
  /** Resolved speaker display names, so the index can answer "who was there". */
  participants?: string[];
  speakerReviewPending?: boolean;
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
  /** Explicit opt-in, kept in the local draft until the batch result is saved. */
  retranscribe?: boolean;
  /** Explicit save choice; only these drafts may resume automatically. */
  processing?: { analyze: boolean; sourceReady?: boolean };
  /** Live identity evidence used to match names after a second transcription. */
  speakerReference?: MeetingTranscript;
  /** Opaque owner-bound resumable upload handle; never a capability URL. */
  microsoftUploadHandle?: string;
  audio?: Blob;
}
