import { beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
const account = vi.hoisted(() => ({
  currentUser: { uid: "owner-a" } as { uid: string } | null,
}));
vi.mock("./firebase", () => ({ auth: account }));
vi.mock("./microsoft", () => ({ microsoftRequest: request }));
const {
  microsoftEventsBetween,
  getMicrosoftEvent,
  updateMicrosoftEventDescription,
  createMicrosoftEvent,
} = await import("./microsoftCalendar");
const raw = (id: string) => ({
  id,
  type: "occurrence",
  subject: "Weekly",
  start: { dateTime: "2026-11-13T09:00:00", timeZone: "UTC" },
});
beforeEach(() => {
  request.mockReset();
  account.currentUser = { uid: "owner-a" };
});
it("keeps a non-primary Outlook calendar bound and discloses a budget-limited page", async () => {
  request.mockResolvedValue(
    Response.json({
      value: [raw("a"), raw("b")],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=more",
    }),
  );
  const events = await microsoftEventsBetween(0, 1000, 1, "work", "team");
  expect(events).toHaveLength(1);
  expect(events.truncated).toBe(true);
  expect(request.mock.calls[0][0]).toContain(
    "/me/calendars/team/calendarView?",
  );
  expect(events[0]).toMatchObject({ calendarId: "team", connectionId: "work" });
  expect(request).toHaveBeenCalledOnce();
});
describe("Outlook event writeback", () => {
  it("conditionally patches only the HTML body using the exact linked connection", async () => {
    request.mockResolvedValue(Response.json({}));
    await updateMicrosoftEventDescription(
      {
        id: "event",
        calendarId: "primary",
        connectionId: "personal",
        description: "<p>Organizer</p><div>Teams</div>",
        bodyType: "html",
        etag: 'W/"rev"',
      },
      "<bad>",
    );
    const [path, init, connection] = request.mock.calls[0];
    expect(path).toBe("/me/events/event");
    expect(connection).toBe("personal");
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("If-Match")).toBe('W/"rev"');
    expect(JSON.parse(init.body)).toEqual({
      body: {
        contentType: "HTML",
        content:
          "<p>Organizer</p><div>Teams</div><p>--- CheatMeet ---</p><p>&lt;bad&gt;</p><p>--- Ende CheatMeet ---</p>",
      },
    });
  });
  it("refuses unsafe patches without a revision", async () => {
    await expect(
      updateMicrosoftEventDescription(
        {
          id: "e",
          calendarId: "primary",
          connectionId: "personal",
          description: "",
        },
        "text",
      ),
    ).rejects.toThrow("Version");
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves conflict status instead of treating it as a deleted event", async () => {
    request.mockRejectedValue(
      Object.assign(new Error("conflict"), { status: 412 }),
    );
    await expect(
      updateMicrosoftEventDescription(
        {
          id: "e",
          calendarId: "primary",
          connectionId: "personal",
          description: "",
          etag: "rev",
        },
        "text",
      ),
    ).rejects.toMatchObject({ status: 412 });
  });
  it("creates only via an explicit call and returns calendar metadata", async () => {
    request.mockResolvedValue(
      Response.json({
        id: "created",
        webLink: "https://outlook.live.com/event",
      }),
    );
    const created = await createMicrosoftEvent({
      title: "Meeting",
      startMs: 0,
      endMs: 0,
      block: "Summary",
      connectionId: "personal",
    });
    expect(created).toMatchObject({
      id: "created",
      calendarId: "primary",
      calendarProvider: "microsoft",
      calendarConnectionId: "personal",
    });
    expect(request.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
      start: { dateTime: "1970-01-01T00:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "1970-01-01T00:01:00.000Z", timeZone: "UTC" },
    });
    request.mockResolvedValue(Response.json({ id: "team-event" }));
    const team = await createMicrosoftEvent({
      title: "Team",
      startMs: 0,
      endMs: 0,
      block: "Summary",
      connectionId: "work",
      calendarId: "team",
    });
    expect(request.mock.calls[1][0]).toBe("/me/calendars/team/events");
    expect(team).toMatchObject({
      calendarId: "team",
      calendarConnectionId: "work",
    });
  });
  it("reads revisions and immutable IDs from a non-default calendar", async () => {
    request.mockResolvedValue(
      Response.json({
        ...raw("e"),
        "@odata.etag": "rev",
        body: { contentType: "HTML", content: "<div>Teams</div>" },
      }),
    );
    const result = await getMicrosoftEvent("calendar/1", "e", "work");
    expect(request.mock.calls[0][0]).toBe(
      "/me/calendars/calendar%2F1/events/e",
    );
    expect(result).toMatchObject({
      etag: "rev",
      bodyType: "html",
      connectionId: "work",
    });
  });
});

describe("Outlook calendarView", () => {
  it("deduplicates IDs and enforces the event budget even on an oversized page", async () => {
    request.mockResolvedValue(
      Response.json({
        value: [raw("a"), raw("a"), raw("b"), raw("c")],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=next",
      }),
    );
    expect(
      (await microsoftEventsBetween(0, 1000, 2, "personal")).map(
        (event) => event.id,
      ),
    ).toEqual(["a", "b"]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects a pagination cycle rather than looping or reporting incomplete success", async () => {
    request.mockImplementation(async () =>
      Response.json({
        value: [],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=loop",
      }),
    );
    await expect(microsoftEventsBetween(0, 1000, 10, "work")).rejects.toThrow(
      "wiederholte",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("aborts pagination when the Firebase owner changes during body parsing", async () => {
    request.mockResolvedValueOnce({
      json: async () => {
        account.currentUser = { uid: "owner-b" };
        return {
          value: [raw("private")],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=2",
        };
      },
    });
    await expect(microsoftEventsBetween(0, 1000, 10, "work")).rejects.toThrow(
      "Konto",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("preserves an all-day calendar date east of UTC rather than moving it to the previous day", async () => {
    request
      .mockResolvedValueOnce(
        Response.json({
          value: [
            {
              ...raw("day"),
              isAllDay: true,
              originalStartTimeZone: "W. Europe Standard Time",
              start: { dateTime: "2026-11-12T23:00:00", timeZone: "UTC" },
              end: { dateTime: "2026-11-13T23:00:00", timeZone: "UTC" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...raw("day"),
          isAllDay: true,
          start: {
            dateTime: "2026-11-13T00:00:00",
            timeZone: "W. Europe Standard Time",
          },
          end: {
            dateTime: "2026-11-14T00:00:00",
            timeZone: "W. Europe Standard Time",
          },
        }),
      );
    const events = await microsoftEventsBetween(0, 1000, 10, "work");
    expect(events[0]).toMatchObject({
      allDay: true,
      startMs: new Date(2026, 10, 13).getTime(),
      endMs: new Date(2026, 10, 14).getTime(),
    });
    expect(
      new Headers(request.mock.calls[1][1].headers).get("Prefer"),
    ).toContain('outlook.timezone="W. Europe Standard Time"');
  });
  it("expands occurrences, follows pages, pins connection, and requests immutable UTC IDs", async () => {
    request
      .mockResolvedValueOnce(
        Response.json({
          value: [raw("a")],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=next",
        }),
      )
      .mockResolvedValueOnce(Response.json({ value: [raw("b")] }));
    const events = await microsoftEventsBetween(0, 1000, 250, "work");
    expect(events.map((e) => e.id)).toEqual(["a", "b"]);
    const [path, init, connection] = request.mock.calls[0];
    expect(path).toContain("/me/calendarView?");
    expect(
      new URL(path, "https://graph.microsoft.com").searchParams.get(
        "startDateTime",
      ),
    ).toBe("1970-01-01T00:00:00.000Z");
    expect(new Headers(init.headers).get("Prefer")).toContain(
      'IdType="ImmutableId"',
    );
    expect(new Headers(init.headers).get("Prefer")).toContain(
      'outlook.timezone="UTC"',
    );
    expect(connection).toBe("work");
    expect(request.mock.calls[1][0]).toContain("$skiptoken=next");
    expect(events[0].connectionId).toBe("work");
  });
});
