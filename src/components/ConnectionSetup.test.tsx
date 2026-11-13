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
  googleCalendar: false,
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
  },
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => h.navigate }));
vi.mock("../lib/firebase", () => ({
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
  driveToken:()=>null,
  errorMessage: (e: unknown) => (e as Error).message,
}));
vi.mock("../lib/microsoft", () => ({
  connectMicrosoft: h.connectMicrosoft,
  cachedMicrosoftConnections: () => [],
  loadMicrosoftConnections: async () => [],
}));
vi.mock("./DriveSettings", () => ({ default: () => null }));
vi.mock("./MicrosoftSettings", () => ({ default: () => null }));
import ConnectionSetup from "./ConnectionSetup";
import DriveSettings from "./DriveSettings";
import MicrosoftSettings from "./MicrosoftSettings";

type Element = React.ReactElement<{
  children?: React.ReactNode;
  onClick?: () => unknown;
  disabled?: boolean;
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
  vi.clearAllMocks();
});
it('does not present Google as a chosen service before anything was connected',async()=>{
  await click('Weiter zum Speicher');expect(text(view())).toContain('Noch kein Speicher verbunden');
  await click('Weiter zum Kalender');expect(text(view())).toContain('Noch kein Kalender verbunden');
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
  expect(h.saveCalendar).toHaveBeenCalledWith("google");
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
