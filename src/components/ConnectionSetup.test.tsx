import React from "react";
import { beforeEach, expect, it, vi } from "vitest";

// Exercise the real component's event handlers without a DOM dependency.
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  navigate: vi.fn(),
  saveHome: vi.fn(),
  saveCalendar: vi.fn(),
  connectGoogle: vi.fn(),
  connectMicrosoft: vi.fn(),
  effect: undefined as undefined | (() => void),
  effects: [] as (() => void)[],
  getPrompt: vi.fn(),
  savePrompt: vi.fn(),
  grants: vi.fn(),
  revoke: vi.fn(),
  googleCalendar: false,
  driveListener: undefined as undefined | (() => void),
  providerListener: undefined as undefined | (() => void),
  connections: [] as {
    connectionId: string;
    accountName: string;
    calendar: boolean;
  }[],
  home: null as null | {
    provider: "microsoft";
    rootName: string;
    connectionId: string;
    driveId: string;
    rootId: string;
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots))
      h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[index],
      (next: unknown) => {
        h.slots[index] =
          typeof next === "function" ? next(h.slots[index]) : next;
      },
    ];
  },
  useEffect: (effect: () => void) => {
    h.effect = effect;
    h.effects.push(effect);
  },
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = { current: initial };
    return h.slots[index];
  },
}));
vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => args,
  getDoc: h.getPrompt,
  setDoc: h.savePrompt,
}));
vi.mock("../lib/reports", () => ({ uid: () => "existing-owner" }));
vi.mock("../lib/mcpClients", () => ({
  listGrants: h.grants,
  revokeGrant: h.revoke,
  grantsSummary: () => "Meetings lesen",
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => h.navigate }));
vi.mock("../lib/firebase", () => ({
  db: {},
  auth: {
    currentUser: {
      uid: "existing-owner",
      email: "owner@example.test",
      displayName: "Existing owner",
    },
  },
}));
vi.mock("../lib/providerSettings", () => ({
  savedMeetingHome: () => h.home,
  savedCalendarProvider: () => "google",
  savedCalendarConnectionId: () => undefined,
  savedCalendarId: () => "primary",
  saveMeetingHome: h.saveHome,
  saveCalendarProvider: h.saveCalendar,
  loadProviderSettings: async () => ({
    meetingHome: h.home,
    calendarProvider: "google",
  }),
}));
vi.mock("../lib/session", () => ({
  connectGoogle: h.connectGoogle,
  hasCalendarGrant: () => h.googleCalendar,
  driveToken: () => null,
  subscribeDriveSession: (listener: () => void) => {
    h.driveListener = listener;
    return () => {};
  },
  errorMessage: (e: unknown) => (e as Error).message,
}));
vi.mock("../lib/microsoft", () => ({
  connectMicrosoft: h.connectMicrosoft,
  cachedMicrosoftConnections: () => h.connections,
  loadMicrosoftConnections: async () => h.connections,
}));
vi.mock("../lib/calendar", () => ({
  availableCalendars: async () => [{ id: "primary", name: "Hauptkalender" }],
}));
vi.mock("./DriveSettings", () => ({ default: () => null }));
vi.mock("./MicrosoftSettings", () => ({ default: () => null }));
import ConnectionSetup from "./ConnectionSetup";
import DriveSettings from "./DriveSettings";
import MicrosoftSettings from "./MicrosoftSettings";
import Preferences from "./Preferences";
import McpClients from "./McpClients";

type Element = React.ReactElement<{
  children?: React.ReactNode;
  onClick?: () => unknown;
  disabled?: boolean;
  value?: string;
  onChange?: (event: { target: { value: string } }) => void;
}>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children)];
}
function text(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return React.isValidElement(node)
    ? text((node as Element).props.children)
    : "";
}
function view(onComplete?: () => void) {
  h.cursor = 0;
  return ConnectionSetup({ onComplete });
}
async function click(label: string, onComplete?: () => void) {
  const button = elements(view(onComplete)).find(
    (el) => el.type === "button" && text(el.props.children) === label,
  );
  expect(button, label).toBeDefined();
  expect(button!.props.disabled).not.toBe(true);
  await button!.props.onClick!();
}
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.home = null;
  h.googleCalendar = false;
  h.effect = undefined;
  h.effects = [];
  h.connections = [];
  h.driveListener = undefined;
  h.providerListener = undefined;
  vi.stubGlobal("window", {
    addEventListener: (event: string, listener: () => void) => {
      if (event === "cheatmeet:provider-settings")
        h.providerListener = listener;
    },
    removeEventListener: vi.fn(),
  });
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  h.getPrompt.mockResolvedValue({
    data: () => ({ summaryPrompt: "Original" }),
  });
});
it("keeps a newer prompt draft unsaved after an earlier save resolves and restores it on navigation", async () => {
  const render = () => {
    h.cursor = 0;
    return Preferences();
  };
  render();
  h.effects.forEach((effect) => effect());
  await Promise.resolve();
  const change = (value: string) =>
    elements(render()).find((el) => el.type === "textarea")!.props.onChange!({
      target: { value },
    });
  change("A");
  let resolve!: () => void;
  h.savePrompt.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const saving = elements(render()).find(
    (el) => el.type === "button" && text(el.props.children) === "Speichern",
  )!.props.onClick!();
  change("B");
  resolve();
  await saving;
  expect(
    elements(render()).find((el) => el.type === "textarea")!.props.value,
  ).toBe("B");
  expect(text(render())).toContain("noch nicht gespeichert");
  h.slots = [];
  h.effects = [];
  render();
  h.effects.forEach((effect) => effect());
  await Promise.resolve();
  expect(
    elements(render()).find((el) => el.type === "textarea")!.props.value,
  ).toBe("B");
});
it("keeps last-known assistant rows and offers retry when refreshing fails", async () => {
  Object.assign(window, { location: { origin: "https://app.test" } });
  const render = () => {
    h.cursor = 0;
    return McpClients();
  };
  h.grants.mockResolvedValueOnce([
    {
      id: "g",
      clientName: "Known assistant",
      redirectHost: "client.test",
      scopes: ["meetings:read"],
      createdAt: 1,
      lastUsedAt: null,
    },
  ]);
  render();
  h.effect!();
  await Promise.resolve();
  expect(text(render())).toContain("Known assistant");
  h.grants.mockRejectedValueOnce(new Error("Offline"));
  h.effect!();
  await Promise.resolve();
  expect(text(render())).toContain("Known assistant");
  expect(text(render())).not.toContain("Noch kein Assistent verbunden");
  expect(
    elements(render()).some(
      (el) =>
        el.type === "button" && text(el.props.children) === "Erneut laden",
    ),
  ).toBe(true);
});
it("observes grants changed by storage children without reopening setup", async () => {
  view();
  h.effect!();
  await Promise.resolve();
  await click("Weiter zum Speicher");
  h.googleCalendar = true;
  h.driveListener?.();
  await click("Weiter zum Kalender");
  const button = elements(view()).find(
    (el) =>
      el.type === "button" &&
      text(el.props.children) === "Google Kalender verwenden",
  );
  expect(button?.props.disabled).toBe(false);
  h.googleCalendar = false;
  h.driveListener?.();
  expect(
    elements(view()).find(
      (el) =>
        el.type === "button" &&
        text(el.props.children) === "Google Kalender verwenden",
    )?.props.disabled,
  ).toBe(true);
});
it("does not present Google as a chosen service before anything was connected", async () => {
  await click("Weiter zum Speicher");
  expect(text(view())).toContain("Noch kein Speicher verbunden");
  await click("Weiter zum Kalender");
  expect(text(view())).toContain("Noch kein Kalender verbunden");
});
it("identifies the existing account without connecting or rewriting defaults", () => {
  expect(text(view())).toContain("owner@example.test");
  expect(h.connectGoogle).not.toHaveBeenCalled();
  expect(h.connectMicrosoft).not.toHaveBeenCalled();
  expect(h.saveHome).not.toHaveBeenCalled();
  expect(h.saveCalendar).not.toHaveBeenCalled();
});
it("offers both storage providers equally and preserves an existing OneDrive home", async () => {
  h.home = {
    provider: "microsoft",
    rootName: "Existing archive",
    connectionId: "c",
    driveId: "d",
    rootId: "r",
  };
  await click("Weiter zum Speicher");
  const nodes = elements(view());
  expect(nodes.some((el) => el.type === DriveSettings)).toBe(true);
  expect(nodes.some((el) => el.type === MicrosoftSettings)).toBe(true);
  expect(text(view())).toContain("Existing archive");
  expect(h.saveHome).not.toHaveBeenCalled();
});
it("lets calendar setup be skipped without changing the saved choice and finishes through the parent seam", async () => {
  const done = vi.fn();
  await click("Weiter zum Speicher", done);
  await click("Weiter zum Kalender", done);
  await click("Kalender überspringen", done);
  await click("Einrichtung abschließen", done);
  expect(h.saveCalendar).not.toHaveBeenCalled();
  expect(done).toHaveBeenCalledOnce();
  expect(h.navigate).not.toHaveBeenCalled();
});
it("returns reopened setup to the app without requiring a parent callback", async () => {
  await click("Weiter zum Speicher");
  await click("Weiter zum Kalender");
  await click("Kalender überspringen");
  await click("Einrichtung abschließen");
  expect(h.navigate).toHaveBeenCalledWith("/");
});
it("does not change storage when connecting and selecting a different calendar provider", async () => {
  h.home = {
    provider: "microsoft",
    rootName: "Keep this archive",
    connectionId: "c",
    driveId: "d",
    rootId: "r",
  };
  view();
  h.effect!();
  await Promise.resolve();
  await click("Weiter zum Speicher");
  await click("Weiter zum Kalender");
  h.connectGoogle.mockImplementationOnce(async () => {
    h.googleCalendar = true;
  });
  await click("Google Kalender verbinden");
  await click("Google Kalender verwenden");
  expect(h.saveCalendar).toHaveBeenCalledWith("google", undefined, "primary");
  expect(h.saveHome).not.toHaveBeenCalled();
});
it("shows a connection failure without saving a provider or reporting it as connected", async () => {
  await click("Weiter zum Speicher");
  await click("Weiter zum Kalender");
  h.connectMicrosoft.mockRejectedValueOnce(new Error("Verbindung abgebrochen"));
  await click("Outlook / Microsoft 365 verbinden");
  expect(text(view())).toContain("Verbindung abgebrochen");
  expect(h.saveCalendar).not.toHaveBeenCalled();
  expect(h.saveHome).not.toHaveBeenCalled();
});
