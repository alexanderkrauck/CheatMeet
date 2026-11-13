import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  owner: "owner-a",
  effects: [] as (() => void | (() => void))[],
  writes: [] as unknown[],
  events: vi.fn(),
  people: vi.fn(),
  grant: true,
  key: "owner-a:microsoft:work:true",
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    state.effects.push(effect);
  },
  useState: (initial: unknown) => [
    initial,
    (value: unknown) => {
      state.writes.push(value);
    },
  ],
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
vi.mock("./calendar", () => ({
  eventsBetween: state.events,
  hasAnyCalendarGrant: () => state.grant,
  calendarSelectionSnapshot: () => state.key,
  subscribeCalendar: () => () => {},
}));
vi.mock("./session", () => ({
  hasCalendarGrant: () => false,
  subscribeDriveSession: () => () => {},
}));
vi.mock("./reports", () => ({ uid: () => state.owner }));
vi.mock("./people", () => ({ rememberPeople: state.people }));
import { useCalendarEvents } from "./useCalendarEvents";
beforeEach(() => {
  state.effects = [];
  state.writes = [];
  state.owner = "owner-a";
  state.events.mockReset();
  state.people.mockReset().mockResolvedValue(undefined);
});
it("loads Outlook using the calendar grant rather than requiring a Google session", async () => {
  state.events.mockResolvedValue([{ id: "e", attendees: ["Anna"] }]);
  useCalendarEvents({ fromMs: 1, toMs: 2 });
  state.effects[0]();
  await vi.waitFor(() =>
    expect(state.people).toHaveBeenCalledWith("owner-a", ["Anna"]),
  );
  expect(state.events).toHaveBeenCalledWith(1, 2, undefined);
});
it("never imports old attendees into a newly signed-in account", async () => {
  let finish: (events: unknown[]) => void;
  state.events.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useCalendarEvents({ fromMs: 1, toMs: 2 });
  state.effects[0]();
  state.owner = "owner-b";
  finish!([{ id: "e", attendees: ["Private attendee"] }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(state.people).not.toHaveBeenCalled();
  expect(state.writes).not.toContainEqual([
    { id: "e", attendees: ["Private attendee"] },
  ]);
});
