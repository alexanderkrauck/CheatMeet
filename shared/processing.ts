import type { ReportData } from '../src/types';

/** Stable archive authority, not consumable audio or derived export progress. */
export const processingSourceKey = (report: Pick<ReportData, 'id' | 'home' | 'driveFolderId' | 'driveReportId'>) =>
  JSON.stringify(report.home
    ? [report.id, 'microsoft', report.home.connectionId, report.home.driveId, report.home.rootId, report.home.folderId, report.home.reportId]
    : [report.id, 'google', report.driveFolderId, report.driveReportId]);
export const processingStorage = (report: { home?: unknown }) => report.home ? 'microsoft' as const : 'google' as const;
export const jobStorage = (job: ProcessingJobView) => job.storage || 'google';

/** Deliberately small public surface: never expose grants, provider IDs or task internals. */
export interface ProcessingJobView {
  reportId: string;
  storage?: 'google' | 'microsoft';
  state: 'queued' | 'transcribing' | 'analyzing' | 'exporting' | 'review' | 'done' | 'blocked' | 'error';
  message: string;
  attempts: number;
  error?: string;
  warning?: string;
  updatedAt: string;
}
export const processingActive = (job: ProcessingJobView) =>
  ['queued','transcribing','analyzing','exporting'].includes(job.state);
