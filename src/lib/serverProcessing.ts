import { auth } from "./firebase";
import { projectReport } from "./reportProjection";
import type { ReportData } from "../types";
import type { ProcessingJobView } from "../../shared/processing";

let configuration: Promise<boolean> | undefined;
export function resetProcessingConfig() { configuration = undefined; }

/** A network error is not proof that server processing is disabled. */
export function processingAvailable(): Promise<boolean> {
  return configuration ||= fetch("/api/processing/config", { signal: AbortSignal.timeout(15_000) })
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
    headers: { Authorization: `Bearer ${identity}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  check();
  const data = await response.json().catch(() => ({}));
  check();
  if (!response.ok) throw new Error(data.error || "Server-Verarbeitung ist gerade nicht erreichbar.");
  return data as T;
}

export type ProcessingOptions = { analyze: boolean; retranscribe?: boolean; calendarSync?: boolean; preferences?: string };
export type ProcessingResult = { job: ProcessingJobView; report?: ReportData };

export const submitServerProcessing = (report: ReportData, options: ProcessingOptions) =>
  request<ProcessingResult>(`/${encodeURIComponent(report.id)}`, { report: projectReport(report), ...options });
export const getServerProcessing = (id: string) => request<ProcessingResult>(`/${encodeURIComponent(id)}`);
export const listServerProcessing = () => request<{ jobs: ProcessingJobView[] }>("");
