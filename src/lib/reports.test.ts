import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportData } from "../types";

const written: { path: string; data: Record<string, unknown> }[] = [];
const local: ReportData[] = [];

vi.mock("./firebase", () => ({ auth: { currentUser: { uid: "u1" } }, db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  collection: (_db: unknown, ...path: string[]) => path.join("/"),
  onSnapshot: () => () => {},
  setDoc: async (path: string, data: Record<string, unknown>) => {
    written.push({ path, data });
  },
}));
vi.mock("./local", () => ({
  putLocal: async (_u: string, report: ReportData) => void local.push(report),
  listLocal: async () => [],
  getLocal: async () => undefined,
  acceptRemoteReport: async () => {},
  watchLocalReports: () => () => {},
}));
vi.mock("./people", () => ({ rememberPeople: async () => {} }));

const { saveReport } = await import("./reports");

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1",
  date: "2026-09-15T12:00:00.000Z",
  title: "Weekly Sync",
  summary: "Roadmap besprochen.",
  transcription: "Jedes gesprochene Wort dieses Meetings.",
  speech: {
    provider: "assemblyai",
    phase: "final",
    languages: ["de"],
    speakerNames: {},
    turns: [
      {
        id: "mic:0:0",
        speaker: "mic:0:A",
        text: "Hallo",
        startMs: 0,
        endMs: 1000,
        final: true,
      },
    ],
  },
  todos: [],
  takeaways: [],
  driveReportId: "json-id",
  driveSyncedAt: "2026-09-15T12:00:00.000Z",
  ...over,
});

beforeEach(() => {
  written.length = 0;
  local.length = 0;
});

describe("saveReport", () => {
  it("sends the cloud an index, never the transcript", async () => {
    await saveReport(report());

    expect(written).toHaveLength(1);
    const data = written[0].data;
    // The two unbounded fields are what would eventually break syncing.
    expect(data.transcription).toBe("");
    expect(data).not.toHaveProperty("speech");
    // Everything a second device needs to find the real copy survives.
    expect(data.driveReportId).toBe("json-id");
    expect(data.transcriptChars).toBe(
      "Jedes gesprochene Wort dieses Meetings.".length,
    );
    expect(written[0].path).toBe("users/u1/reports/r1");
  });

  it("keeps the whole meeting on the device that recorded it", async () => {
    await saveReport(report());

    expect(local).toHaveLength(1);
    expect(local[0].transcription).toBe(
      "Jedes gesprochene Wort dieses Meetings.",
    );
    expect(local[0].speech?.turns).toHaveLength(1);
  });

  it("carries the consent record to the other device", async () => {
    await saveReport(
      report({
        consent: {
          version: 1,
          templateVersion: "1",
          facts: {
            language: "de",
            address: "du",
            sources: ["mic"],
            processors: [],
            storage: { service: "Google Drive", folder: "Ordner" },
            recipients: [],
            retention: { audioDays: 30, textDays: null },
          },
          parts: null,
          text: "Hinweis",
          obtainedAt: "2026-09-15T11:59:00.000Z",
          method: "spoken",
          allInformed: true,
        },
      }),
    );

    // The deletion deadline travels with it, so any device can enforce it.
    expect(written[0].data.consent).toMatchObject({
      obtainedAt: "2026-09-15T11:59:00.000Z",
    });
  });
});
