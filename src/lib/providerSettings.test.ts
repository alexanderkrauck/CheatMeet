import { beforeEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  user: { uid: "a" },
  getDoc: vi.fn(),
  setDoc: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("./firebase", () => ({ auth: { currentUser: s.user }, db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: (...x: unknown[]) => x,
  getDoc: s.getDoc,
  setDoc: s.setDoc,
}));
vi.mock("./microsoft", () => ({ cachedMicrosoftConnections: () => [] }));
import {
  savedMeetingHome,
  saveMeetingHome,
  savedCalendarProvider,
  saveCalendarProvider,
  loadMeetingHome,
  loadProviderSettings,
  savedCalendarConnectionId,
  savedCalendarId,
} from "./providerSettings";
const home = {
  provider: "microsoft" as const,
  connectionId: "c",
  driveId: "d",
  rootId: "r",
  rootName: "Meetings",
};
beforeEach(() => {
  s.user.uid = "a";
  const map = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) || null,
    setItem: (k: string, v: string) => map.set(k, v),
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  s.getDoc.mockResolvedValue({ data: () => ({}) });
  s.setDoc.mockClear();
});
it("persists an owner-scoped home and calendar preference without moving existing meetings", async () => {
  await saveMeetingHome(home);
  s.getDoc.mockResolvedValue({ data: () => ({ meetingHome: home }) });
  await saveCalendarProvider("microsoft");
  expect(savedMeetingHome()).toEqual(home);
  expect(savedCalendarProvider()).toBe("microsoft");
  expect(s.setDoc.mock.calls[0][0]).toEqual([
    {},
    "users",
    "a",
    "settings",
    "providers",
  ]);
  s.user.uid = "b";
  expect(savedMeetingHome()).toBeNull();
  expect(savedCalendarProvider()).toBe("google");
});
it("keeps an explicit calendar destination and never replaces a failed cold lookup with Google", async () => {
  s.getDoc.mockRejectedValue(new Error("offline"));
  await expect(loadProviderSettings()).rejects.toThrow("offline");
  s.getDoc.mockResolvedValue({
    data: () => ({ calendarProvider: "unknown-provider" }),
  });
  await expect(loadProviderSettings()).rejects.toThrow("Kalenderauswahl");
  s.getDoc.mockResolvedValue({ data: () => undefined });
  await loadProviderSettings();
  expect(savedCalendarProvider()).toBe("google");
  await saveCalendarProvider("microsoft", "work", "team-calendar");
  expect(savedCalendarConnectionId()).toBe("work");
  expect(savedCalendarId()).toBe("team-calendar");
  expect(s.setDoc.mock.calls.at(-1)?.[1]).toMatchObject({
    calendarProvider: "microsoft",
    calendarConnectionId: "work",
    calendarId: "team-calendar",
  });
  s.getDoc.mockRejectedValue(new Error("offline"));
  expect(await loadProviderSettings()).toMatchObject({
    calendarProvider: "microsoft",
    calendarConnectionId: "work",
    calendarId: "team-calendar",
  });
});
it("does not cache remote settings after an account switch", async () => {
  s.getDoc.mockImplementation(async () => {
    s.user.uid = "b";
    return { data: () => ({ meetingHome: home }) };
  });
  await expect(loadMeetingHome()).rejects.toThrow("Konto");
  expect(savedMeetingHome()).toBeNull();
});
