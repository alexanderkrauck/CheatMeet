import { auth } from "./firebase";
import { projectReport } from "./reportProjection";
import type { ReportData } from "../types";
import { jobStorage, processingStorage, processingSourceKey, type ProcessingJobView } from "../../shared/processing";

let configuration: Promise<boolean> | undefined;
export function resetProcessingConfig() { configuration = undefined; }

/** A network error is not proof that server processing is disabled. */
export function processingAvailable(): Promise<boolean> {
  return configuration ||= fetch("/api/processing/config", { headers:{"X-CheatMeet-Storage":"microsoft"},signal: AbortSignal.timeout(15_000) })
    .then(async (response) => {
      if (!response.ok) throw new Error("Server-Verarbeitung ist gerade nicht erreichbar.");
      return (await response.json()).enabled === true;
    }).catch((error) => { configuration = undefined; throw error; });
}

async function request<T>(path: string, body?: object): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("Bitte zuerst anmelden.");
  const owner = user.uid;
  const check = () => {
    if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  const identity = await user.getIdToken();
  check();
  const response = await fetch(`/api/processing${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${identity}`, "X-CheatMeet-Storage": "microsoft", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  check();
  const data = await response.json().catch(() => ({}));
  check();
  if (!response.ok) throw Object.assign(new Error(data.error || "Server-Verarbeitung ist gerade nicht erreichbar."), { status: response.status });
  return data as T;
}

export type ProcessingOptions = { analyze: boolean; regenerate?: boolean; retranscribe?: boolean; calendarSync?: boolean; preferences?: string };
export type ProcessingResult = { job: ProcessingJobView; report?: ReportData };

function checkedResult(result: ProcessingResult, id: string, storage: 'google' | 'microsoft', report?: ReportData) {
  if (result.job.reportId !== id || jobStorage(result.job) !== storage || result.report &&
      (result.report.id !== id || processingStorage(result.report) !== storage || report && processingSourceKey(report) !== processingSourceKey(result.report)))
    throw Object.assign(new Error("Der Auftrag gehört zu einem anderen Meeting-Speicherort."), { status: 409 });
  return result;
}
export const submitServerProcessing = async (report: ReportData, options: ProcessingOptions) =>
  checkedResult(await request<ProcessingResult>(`/${encodeURIComponent(report.id)}`, { report: projectReport(report), ...options }), report.id, processingStorage(report), report);
export const getServerProcessing = async (id: string, report?: ReportData) => {
  if (report && report.id !== id) throw new Error("Meeting-ID stimmt nicht mit dem Bericht überein.");
  return checkedResult(await request<ProcessingResult>(`/${encodeURIComponent(id)}${report ? `?source=${encodeURIComponent(processingSourceKey(report))}` : ''}`), id, report ? processingStorage(report) : 'google', report);
};
/** Discovery selects a namespace, but is not evidence of a known report's source. */
export const discoverServerProcessing = async (job: ProcessingJobView) =>
  checkedResult(await request<ProcessingResult>(`/${encodeURIComponent(job.reportId)}?storage=${jobStorage(job)}`), job.reportId, jobStorage(job));
export const listServerProcessing = () => request<{ jobs: ProcessingJobView[] }>("");
/** No files or paid transcription reservations are removed. A rejected/uncertain
 * forget must stop deletion: retaining the entry is safer than resurrection. */
export async function forgetServerProcessing(owner: string, id: string, report?: ReportData) {
  if (auth.currentUser?.uid !== owner) throw new Error("Das angemeldete Konto hat sich geändert.");
  if (report && report.id !== id) throw new Error("Meeting-ID stimmt nicht mit dem Bericht überein.");
  return request<{ forgotten: true }>(`/${encodeURIComponent(id)}/forget`, report ? { source: processingSourceKey(report) } : {});
}
