import { auth } from "./firebase";
export interface MicrosoftConnection {
  connectionId: string;
  accountName: string;
  calendar: boolean;
}
const metadataKey = (owner: string) =>
  `cheatmeet:microsoft-connections:${owner}`;
export function cachedMicrosoftConnections(): MicrosoftConnection[] {
  const owner = auth.currentUser?.uid;
  if (!owner) return [];
  try {
    const items = JSON.parse(localStorage.getItem(metadataKey(owner)) || "[]");
    return Array.isArray(items)
      ? items.filter(
          (c) =>
            typeof c.connectionId === "string" &&
            typeof c.accountName === "string" &&
            typeof c.calendar === "boolean",
        )
      : [];
  } catch {
    return [];
  }
}
function notify() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("cheatmeet:provider-settings"));
}
export function microsoftRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (!raw) return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}
export function microsoftOwner() {
  const user = auth.currentUser;
  if (!user) throw new Error("Bitte zuerst anmelden.");

  // Capture uid, not the mutable User reference.
  const owner = user.uid;
  return {
    user,
    owner,
    check: () => {
      if (auth.currentUser?.uid !== owner)
        throw new Error("Das angemeldete Konto hat sich geändert.");
    },
  };
}
export async function microsoftApi<T>(path: string, body?: object): Promise<T> {
  const { user, check } = microsoftOwner();
  const identity = await user.getIdToken();
  check();
  const response = await fetch(`/api/microsoft/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${identity}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  check();
  const data = await response.json().catch(() => ({}));
  check();
  if (!response.ok)
    throw Object.assign(
      new Error(
        data.error ||
          "Microsoft ist gerade nicht erreichbar. Bitte die Verbindung prüfen.",
      ),
      { status: response.status, retryAfterMs: microsoftRetryAfter(response) },
    );
  return data as T;
}
export async function loadMicrosoftConnections(): Promise<
  MicrosoftConnection[]
> {
  const { owner, check } = microsoftOwner();
  const data = await microsoftApi<{ connections: MicrosoftConnection[] }>(
    "connections",
  );
  check();
  const connections = data.connections.map(
    ({ connectionId, accountName, calendar }) => ({
      connectionId,
      accountName,
      calendar: calendar === true,
    }),
  );
  try {
    localStorage.setItem(metadataKey(owner), JSON.stringify(connections));
  } catch {
    /* unavailable local cache */
  }
  notify();
  return connections;
}
export async function ensureMicrosoftToken(
  connectionId?: string,
): Promise<{ accessToken: string; connectionId: string }> {
  const { check } = microsoftOwner();
  const data = await microsoftApi<{
    accessToken: string;
    connectionId: string;
  }>("token", { ...(connectionId ? { connectionId } : {}) });
  check();
  if (
    !data.accessToken ||
    !data.connectionId ||
    (connectionId && data.connectionId !== connectionId)
  )
    throw new Error(
      "Microsoft-Verbindung nicht verfügbar. Bitte erneut verbinden.",
    );
  // Access tokens deliberately live only in this request, not IndexedDB or archives.
  return { accessToken: data.accessToken, connectionId: data.connectionId };
}
export async function microsoftRequest(
  path: string,
  init: RequestInit = {},
  connectionId?: string,
): Promise<Response> {
  const { check } = microsoftOwner();
  const url = new URL(
    path.startsWith("/") ? `https://graph.microsoft.com/v1.0${path}` : path,
    "https://graph.microsoft.com/v1.0/",
  );
  if (
    url.origin !== "https://graph.microsoft.com" ||
    !url.pathname.startsWith("/v1.0/") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Ungültige Microsoft-Graph-Adresse.");
  const { accessToken } = await ensureMicrosoftToken(connectionId);
  check();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(url.href, {
    ...init,
    headers,
    redirect: "error",
    signal: init.signal || AbortSignal.timeout(60_000),
  });
  check();
  if (!response.ok)
    throw Object.assign(
      new Error(
        response.status === 403
          ? "Microsoft verweigert den Zugriff. Bitte die Berechtigungen der Verbindung prüfen."
          : `Microsoft-Anfrage fehlgeschlagen (${response.status}).`,
      ),
      { status: response.status, retryAfterMs: microsoftRetryAfter(response) },
    );
  return response;
}
export async function disconnectMicrosoft(connectionId: string) {
  const { check } = microsoftOwner();
  await microsoftApi("disconnect", { connectionId });
  check();
  await loadMicrosoftConnections();
}
export function connectMicrosoft(calendar = false): Promise<void> {
  const { check } = microsoftOwner();
  const popup = window.open(
    "about:blank",
    "cheatmeet-microsoft-oauth",
    "width=540,height=700",
  );
  if (!popup)
    return Promise.reject(
      new Error("Das Anmeldefenster wurde blockiert. Bitte Pop-ups erlauben."),
    );
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let accepted = false;
    const done = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearInterval(watch);
      clearTimeout(timeout);
      window.removeEventListener("message", message);
      popup.close();
      error ? reject(error) : resolve();
    };
    const message = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== popup ||
        event.data?.source !== "cheatmeet-microsoft-oauth"
      )
        return;
      try {
        check();
        if (!event.data.connected)
          throw new Error(
            event.data.error || "Microsoft-Verbindung abgebrochen.",
          );
        if (accepted) return;
        accepted = true;
        void loadMicrosoftConnections()
          .then(() => {
            check();
            done();
          })
          .catch(done);
      } catch (error) {
        done(error);
      }
    };
    window.addEventListener("message", message);
    const watch = window.setInterval(() => {
      try {
        check();
        if (!accepted && popup.closed)
          done(new Error("Das Anmeldefenster wurde geschlossen."));
      } catch (error) {
        done(error);
      }
    }, 400);
    const timeout = window.setTimeout(
      () =>
        done(
          new Error(
            "Microsoft-Anmeldung hat zu lange gedauert. Bitte erneut versuchen.",
          ),
        ),
      180_000,
    );
    void microsoftApi<{ url: string }>("connect", { calendar })
      .then(({ url }) => {
        check();
        const target = new URL(url);
        if (target.protocol !== "https:")
          throw new Error("Ungültige Microsoft-Anmeldeadresse.");
        if (!finished) popup.location.href = target.href;
      })
      .catch(done);
  });
}
