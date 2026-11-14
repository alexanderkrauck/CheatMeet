import { auth } from "./firebase";
import type { Scope } from "../../shared/mcp";

export type ConnectReason = "expired" | "no_storage" | "signed_out" | "failed";
export class ConnectError extends Error {
  constructor(
    readonly reason: ConnectReason,
    message: string,
  ) {
    super(message);
  }
}
export interface ConsentRequest {
  clientName: string;
  redirectHost: string;
  scopes: Scope[];
}
export interface ConnectedAssistant {
  id: string;
  clientName: string;
  redirectHost: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
}

/** The signed request the authorization endpoint put into the address. */
export function requestParam(search: string): string {
  const value = new URLSearchParams(search).get("request") ?? "";
  return value.length <= 8192 ? value : "";
}

async function identity() {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new ConnectError("signed_out", "Bitte zuerst anmelden.");
  return { Authorization: `Bearer ${token}` };
}
const failed = () =>
  new ConnectError(
    "failed",
    "Das hat nicht geklappt. Bitte später erneut versuchen.",
  );

export async function loadRequest(request: string): Promise<ConsentRequest> {
  const response = await fetch(
    `/api/oauth/request-info?request=${encodeURIComponent(request)}`,
  ).catch(() => null);
  if (!response) throw failed();
  if (response.status === 400)
    throw new ConnectError(
      "expired",
      "Diese Anfrage ist abgelaufen. Bitte im Assistenten erneut verbinden.",
    );
  if (!response.ok) throw failed();
  return (await response.json()) as ConsentRequest;
}

/** Sends the user's answer and returns the address to send the browser back to. */
export async function decide(
  request: string,
  approve: boolean,
  scopes: Scope[],
): Promise<string> {
  const headers = { ...(await identity()), "Content-Type": "application/json" };
  const response = await fetch("/api/oauth/decision", {
    method: "POST",
    headers,
    body: JSON.stringify({ request, approve, scopes }),
  }).catch(() => null);
  if (!response) throw failed();
  const body = (await response.json().catch(() => ({}))) as {
    redirectTo?: string;
    error?: string;
  };
  if (
    response.status === 409 &&
    (body.error === "no_drive_grant" || body.error === "no_storage_grant")
  )
    throw new ConnectError(
      "no_storage",
      "Verbinde zuerst Google Drive oder OneDrive mit diesem Arbeitsbereich. Kehre danach hierher zurück und erlaube den Zugriff ausdrücklich.",
    );
  if (response.status === 400)
    throw new ConnectError(
      "expired",
      "Diese Anfrage ist abgelaufen. Bitte im Assistenten erneut verbinden.",
    );
  if (!response.ok || !body.redirectTo) throw failed();
  // The server built this address, but nothing that is not a web page is ever followed.
  if (!/^https?:\/\//i.test(body.redirectTo)) throw failed();
  return body.redirectTo;
}

export async function listGrants(): Promise<ConnectedAssistant[]> {
  const response = await fetch("/api/mcp/grants", {
    headers: await identity(),
  }).catch(() => null);
  if (!response?.ok) throw failed();
  return ((await response.json()) as { grants: ConnectedAssistant[] }).grants;
}
export async function revokeGrant(id: string): Promise<void> {
  const response = await fetch(`/api/mcp/grants/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await identity(),
  }).catch(() => null);
  if (!response?.ok) throw failed();
}

export function describeScope(scope: Scope): string {
  return scope === "meetings:read"
    ? "Vergangene Meetings lesen: Zusammenfassungen, Aufgaben und Transkripte, auch per Suche."
    : "Laufende Meetings mitlesen: das Transkript während einer Aufnahme, sobald es entsteht.";
}
export function grantsSummary(scopes: readonly Scope[]): string {
  const read = scopes.includes("meetings:read");
  const live = scopes.includes("meetings:live");
  if (read && live) return "Vergangene und laufende Meetings lesen";
  return live ? "Laufende Meetings mitlesen" : "Vergangene Meetings lesen";
}
