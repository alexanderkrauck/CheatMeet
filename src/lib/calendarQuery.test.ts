import { beforeEach, describe, expect, it, vi } from "vitest";

let granted = true;
let requested: string[] = [];
vi.mock("./session", () => ({
  hasCalendarGrant: () => granted,
  ensureDriveToken: async () => "token",
}));

let pages: Record<string, unknown>[] = [];
const fetchMock = vi.fn(async (url: string) => {
  requested.push(String(url));
  const page = pages.shift() ?? {
    items: [
      {
        id: "e1",
        summary: "Standup",
        start: { dateTime: "2026-09-16T08:00:00.000Z" },
        end: { dateTime: "2026-09-16T08:15:00.000Z" },
      },
    ],
  };
  return { ok: true, status: 200, json: async () => page };
});
vi.stubGlobal("fetch", fetchMock);

const { eventsAround, eventsBetween } = await import("./calendar");
const params = () => new URL(requested[0]).searchParams;

beforeEach(() => {
  granted = true;
  requested = [];
  pages = [];
  fetchMock.mockClear();
});

describe("eventsBetween", () => {
  it("asks for the range it was given, in start order", async () => {
    const from = Date.parse("2026-09-15T00:00:00.000Z");
    const to = Date.parse("2026-09-22T00:00:00.000Z");
    const events = await eventsBetween(from, to);
    expect(params().get("timeMin")).toBe("2026-09-15T00:00:00.000Z");
    expect(params().get("timeMax")).toBe("2026-09-22T00:00:00.000Z");
    expect(params().get("orderBy")).toBe("startTime");
    expect(events[0]).toMatchObject({ id: "e1", title: "Standup" });
  });

  it("expands recurring series, or a weekly standup would appear once", async () => {
    await eventsBetween(0, 1);
    expect(params().get("singleEvents")).toBe("true");
  });

  it("asks for nothing at all without the grant", async () => {
    granted = false;
    expect(await eventsBetween(0, 1)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("eventsBetween pagination", () => {
  const event = (id: string) => ({
    id,
    summary: id,
    start: { dateTime: "2026-09-16T08:00:00.000Z" },
    end: { dateTime: "2026-09-16T08:15:00.000Z" },
  });

  it("follows nextPageToken so the tail of the range is not dropped", async () => {
    pages = [
      { items: [event("a")], nextPageToken: "p2" },
      { items: [event("b")], nextPageToken: "p3" },
      { items: [event("c")] },
    ];
    const events = await eventsBetween(0, 1);
    expect(events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(requested).toHaveLength(3);
    expect(new URL(requested[1]).searchParams.get("pageToken")).toBe("p2");
  });

  it("stops at the budget rather than paging a calendar forever", async () => {
    pages = Array.from({ length: 10 }, (_, i) => ({
      items: [event(`e${i}`)],
      nextPageToken: "next",
    }));
    const events = await eventsBetween(0, 1, 3);
    expect(events).toHaveLength(3);
    expect(requested).toHaveLength(3);
  });
});

describe("eventsAround", () => {
  it("is a window centred on the given moment", async () => {
    const at = Date.parse("2026-09-15T10:00:00.000Z");
    await eventsAround(at);
    expect(params().get("timeMin")).toBe("2026-09-15T07:00:00.000Z");
    expect(params().get("timeMax")).toBe("2026-09-15T13:00:00.000Z");
  });
});
