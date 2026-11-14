import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  owner: "owner-a",
  effects: [] as (() => void | (() => void))[],
  writes: [] as unknown[],
  slots: [] as unknown[],
  cursor: 0,
  events: vi.fn(),
  people: vi.fn(),
  grant: true,
  key: "owner-a:microsoft:work:true",
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    state.effects.push(effect);
  },
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots))
      state.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      state.slots[index],
      (value: unknown) => {
        state.slots[index] =
          typeof value === "function" ? value(state.slots[index]) : value;
        state.writes.push(state.slots[index]);
      },
    ];
  },
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
  state.slots = [];
  state.cursor = 0;
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
it("hides the previous range immediately and rejects its late response", async () => {
  const render = (fromMs: number) => {
    state.cursor = 0;
    state.effects = [];
    return useCalendarEvents({ fromMs, toMs: fromMs + 1 });
  };
  state.events.mockResolvedValueOnce([{ id: "old-month", attendees: [] }]);
  render(1);
  const cleanup = state.effects[0]();
  await vi.waitFor(() => expect(state.people).toHaveBeenCalledOnce());
  expect(render(1).events.map((e) => e.id)).toEqual(["old-month"]);
  if (typeof cleanup === "function") cleanup();
  let finish!: (events: unknown[]) => void;
  state.events.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const next = render(3);
  expect(next.events).toEqual([]);
  expect(next.loading).toBe(true);
  const stop = state.effects[0]();
  if (typeof stop === "function") stop();
  finish([{ id: "late-range", attendees: [] }]);
  await Promise.resolve();
  expect(render(5).events).toEqual([]);
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
