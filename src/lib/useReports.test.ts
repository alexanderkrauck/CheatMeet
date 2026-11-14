import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";
import type { ReportSummary } from "./meetingMeta";
import type { JobState } from "./pipeline";

const h = vi.hoisted(() => ({
  cursor: 0, reports: [] as ReportSummary[],
  jobs: [] as JobState[], job: vi.fn(),
  auth: { currentUser: { uid: "B" } },
}));
vi.mock("react", () => ({
  useState: () => [[h.reports, [], [], false, "", "", 0][h.cursor++], vi.fn()],
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("./firebase", () => ({ auth: h.auth }));
vi.mock("./capture", () => ({ captureSnapshot: () => ({ state: "ready" }), subscribeCapture: () => () => {} }));
vi.mock("./pipeline", () => ({ activeJobs: () => h.jobs, subscribeJobs: () => () => {}, jobFor: h.job }));
vi.mock("./local", () => ({ listDrafts: vi.fn(), watchDrafts: () => () => {} }));
vi.mock("./reports", () => ({
  uid: () => h.auth.currentUser.uid, watchReports: () => () => {},
  reportHref: (r: { id: string; home?: unknown }) => `/report/${r.id}?index=${r.home ? "meetings" : "reports"}`,
}));
vi.mock("./session", () => ({ errorMessage: String }));
import { useReports } from "./useReports";
import { summarise } from "./meetingMeta";
import { processingSourceKey } from "../../shared/processing";

beforeEach(() => { vi.clearAllMocks(); h.cursor = 0; h.auth.currentUser.uid = "B"; });
it.each(["foreign owner", "sibling source", "matching source"] as const)(
  "derives running rows from source-bound work, not bare metadata: %s", scenario => {
    const source: ReportData = { id: "same", title: "Meeting", date: "2026-11-14", summary: "Notes", transcription: "Words", todos: [], takeaways: [], driveFolderId: "folder", driveReportId: "json" };
    const current = scenario === "sibling source" ? { ...source, driveFolderId: "other-folder" } : source;
    h.reports = [summarise(current)];
    h.jobs = [{ reportId: source.id, owner: scenario === "foreign owner" ? "A" : "B", storage: "google", stage: "uploading", message: "Saving" }];
    // The real jobFor contract is owner + stable source, not metadata ID alone.
    h.job.mockImplementation((id: string, expected: ReportData) => h.jobs.find(job =>
      job.owner === h.auth.currentUser.uid && job.reportId === id && processingSourceKey(expected) === processingSourceKey(source)));
    const workspace = useReports();
    expect([...workspace.running]).toEqual(scenario === "matching source" ? ["/report/same?index=reports"] : []);
  },
);
