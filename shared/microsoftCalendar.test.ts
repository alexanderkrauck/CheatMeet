import { describe, expect, it } from "vitest";
import {
  graphEventToCalendarEvent,
  mergeMicrosoftBody,
} from "./microsoftCalendar";

describe("safe Outlook body merge", () => {
  it("does not swallow organizer notes after an orphan opener preceding a real closed block", () => {
    const orphan =
      "<p>--- CheatMeet ---</p><p>Legacy without closing marker</p><div>Organizer note</div>";
    const closed = mergeMicrosoftBody("", "Old", "html");
    const merged = mergeMicrosoftBody(
      orphan + closed + "<p>After</p>",
      "New",
      "html",
    );
    expect(merged).toContain(orphan);
    expect(merged).toContain("<p>After</p>");
    expect(merged).not.toContain("<p>Old</p>");
  });
  it("preserves Teams and organizer HTML byte-for-byte while replacing only our escaped block", () => {
    const agenda = "<html><body><p>Agenda &amp; Unterlagen</p>";
    const teams =
      '<div class="me-email-text"><a href="https://teams.microsoft.com/meet">Teams beitreten</a></div>';
    const existing = agenda + teams + "</body></html>";
    const once = mergeMicrosoftBody(
      existing,
      "<img src=x onerror=evil>\nA & B",
      "html",
    );
    expect(once).toContain(agenda + teams);
    expect(once).toContain("&lt;img src=x onerror=evil&gt;<br>A &amp; B");
    expect(once.endsWith("</body></html>")).toBe(true);
    const twice = mergeMicrosoftBody(once, "Neu", "html");
    expect(twice).toContain(agenda + teams);
    expect(twice.match(/--- CheatMeet ---/g)).toHaveLength(1);
    expect(twice).not.toContain("onerror");
    expect(mergeMicrosoftBody(twice, "Neu", "html")).toBe(twice);
  });
  it("preserves plain text before and after its bounded block", () => {
    const once = mergeMicrosoftBody("Agenda", "Alt", "text");
    expect(mergeMicrosoftBody(once + "\nNachtrag", "Neu", "text")).toBe(
      "Agenda\n\n--- CheatMeet ---\nNeu\n--- Ende CheatMeet ---\nNachtrag",
    );
  });
});

describe("Graph event normalization", () => {
  it("normalizes UTC occurrences with immutable identity and people", () => {
    expect(
      graphEventToCalendarEvent(
        {
          id: "immutable",
          type: "occurrence",
          subject: " Sync ",
          start: { dateTime: "2026-11-13T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-11-13T10:00:00", timeZone: "UTC" },
          attendees: [
            { emailAddress: { name: "Anna" } },
            { type: "resource", emailAddress: { name: "Room" } },
          ],
          body: { contentType: "html", content: "<p>Agenda</p>" },
          "@odata.etag": "rev",
        },
        "primary",
        "conn",
      ),
    ).toMatchObject({
      id: "immutable",
      provider: "microsoft",
      connectionId: "conn",
      title: "Sync",
      startMs: Date.parse("2026-11-13T09:00:00Z"),
      attendees: ["Anna"],
      bodyType: "html",
      etag: "rev",
      kind: "default",
    });
  });
});
