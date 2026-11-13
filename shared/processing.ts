/** Deliberately small public surface: never expose grants, provider IDs or task internals. */
export interface ProcessingJobView {
  reportId: string;
  state: 'queued' | 'transcribing' | 'analyzing' | 'exporting' | 'review' | 'done' | 'blocked' | 'error';
  message: string;
  attempts: number;
  error?: string;
  warning?: string;
  updatedAt: string;
}
export const processingActive = (job: ProcessingJobView) =>
  ['queued','transcribing','analyzing','exporting'].includes(job.state);
