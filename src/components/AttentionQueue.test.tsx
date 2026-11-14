import React from "react";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
vi.mock("../lib/capture", () => ({ captureSnapshot: () => ({ state: "ready" }), subscribeCapture: () => () => {} }));
vi.mock("../lib/firebase", () => ({ auth: { currentUser: { uid: "owner" } } }));
const progressJobs = vi.hoisted(() => ({ jobs: [] as any[] }));
vi.mock("../lib/pipeline", () => ({ jobFor: (id: string) => progressJobs.jobs.find(job => job.reportId === id) || ({ stage: "error", error: "Drive-Revisionsprüfung fehlgeschlagen" }), activeJobs: () => progressJobs.jobs, subscribeJobs: () => () => {} }));
vi.mock("../lib/local", () => ({ getLocal: vi.fn() }));
vi.mock("../lib/reports", () => ({ saveReport: vi.fn(), reportHref: (r: { id: string; home?: unknown }) => `/report/${r.id}?index=${r.home ? "meetings" : "reports"}` }));
vi.mock("../lib/session", () => ({ errorMessage: String }));
import AttentionQueue from "./AttentionQueue";
import Dashboard from "../pages/Dashboard";
import JobProgress from "./JobProgress";
const dashboard = vi.hoisted(() => ({ workspace: {} as any }));
vi.mock("../lib/useReports", () => ({ useReports: () => dashboard.workspace }));
vi.mock("./DeleteMeeting", () => ({ default: () => null }));
vi.mock("./NextMeeting", () => ({ default: () => null }));
vi.mock("./MeetingRow", async importOriginal => ({ ...await importOriginal<typeof import("./MeetingRow")>(), default: ({ report }: any) => <a href={`/report/${report.id}`}>{report.title}</a> }));
vi.mock("./UI", () => ({ Notice: ({children}: any) => <p role="alert">{children}</p>, Busy: ({text}: any) => <p>{text}</p>, dateLabel: (date: string) => date, dateTimeLabel: (date: string) => date, Status: () => <span>Entwurf</span>, CalendarStatus: () => null }));
vi.mock("../lib/calendar", () => ({ hasAnyCalendarGrant: () => false, subscribeCalendar: () => () => {} }));

it.each([false,true])("labels saved-only meetings as archived regardless of optional speaker naming (%s)", async (needsReview) => {
  const { default: ActualMeetingRow } = await vi.importActual<typeof import("./MeetingRow")>("./MeetingRow");
  const report = { id: "saved-only", title: "Nur sichern", date: "2026-11-13", status: "pending", summary: "", speakers: [], needsReview, driveSyncedAt: "2026-11-13" } as any;
  progressJobs.jobs = [{ reportId: report.id, stage: "done", message: "Fertig" }];
  let html = renderToStaticMarkup(<MemoryRouter><ActualMeetingRow report={report} /></MemoryRouter>);
  expect(html).toContain("Archiviert · ohne Bericht");
  expect(html).not.toContain("Entwurf");
  progressJobs.jobs = [{ reportId: report.id, stage: "uploading", message: "Aufnahme wird gesichert" }];
  html = renderToStaticMarkup(<MemoryRouter><ActualMeetingRow report={report} running /></MemoryRouter>);
  expect(html).toContain("Aufnahme wird gesichert");
  expect(html).not.toContain("Analyse läuft");
});

it("does not turn optional unnamed speakers into an open task",()=>{
  progressJobs.jobs=[{reportId:'optional-names',stage:'done'}];
  const workspace={reports:[{id:'optional-names',title:'Abgeschlossen',status:'completed',needsReview:true}],dirty:[],drafts:[],error:'',draftsError:'',running:new Set(),reload:vi.fn()} as any;
  try {
    expect(renderToStaticMarkup(<MemoryRouter><AttentionQueue workspace={workspace}/></MemoryRouter>)).toBe('');
  } finally { progressJobs.jobs=[]; }
});

it("identifies same-stage background links by meeting without a second report subscription", () => {
  progressJobs.jobs = [{ reportId: "a", owner: "owner", title: "Planung", date: "2026-11-13", message: "Wird gesichert" }, { reportId: "b", owner: "owner", title: "Rückblick", date: "2026-11-14", message: "Wird gesichert" }, { reportId: "foreign", owner: "other", title: "Anderes Konto", message: "Server" }];
  const html = renderToStaticMarkup(<MemoryRouter><JobProgress /></MemoryRouter>);
  expect(html).not.toContain("Anderes Konto");
  expect(html).toContain("Planung");
  expect(html).toContain("Rückblick");
  expect(html).toContain('class="job-progress-list"');
});

it("keeps every draft-only recovery and the cloud-save action reachable beyond the preview", () => {
  const drafts = Array.from({ length: 6 }, (_, i) => ({ report: { id: `draft-${i}`, title: `Aufnahme ${i}` } }));
  const workspace = { reports: [{ id: "local", title: "Lokal", status: "completed" }], dirty: ["/report/local?index=reports"], drafts, error: "offline", draftsError: "", running: new Set(), reload: vi.fn() } as any;
  const html = renderToStaticMarkup(<MemoryRouter><AttentionQueue workspace={workspace} /></MemoryRouter>);
  expect(html).toContain('href="/record?draft=draft-5"');
  expect(html).toContain("In der Cloud speichern");
  expect(html).toContain("<summary");
});

it("keeps cached meetings visible when only cloud discovery fails and carries detail-delete warnings", () => {
  dashboard.workspace = { reports: [{ id: "cached", title: "Lokaler Bericht", date: "2026-11-13", status: "completed", summary: "Text", speakers: [], transcriptLocal: true }], dirty: [], drafts: [], error: "Cloud offline", draftsError: "", loading: false, running: new Set(), reload: vi.fn() };
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={[{ pathname: "/dashboard", state: { deleteOutcome: { removed: true, warnings: ["Cloud-Eintrag bleibt erhalten"] } } }]}><Dashboard /></MemoryRouter>);
  expect(html).toContain('class="meeting-list"');
  expect(html).toContain('href="/report/cached"');
  expect(html).toContain("Cloud offline");
  expect(html).toContain("Cloud-Eintrag bleibt erhalten");
});

it("shows a blocked server backup even when its report index still says pending", () => {
  const workspace = { reports: [{ id: "backup", title: "Backup", status: "pending" }], dirty: [], drafts: [], error: "", draftsError: "", running: new Set(), reload: vi.fn() } as any;
  const html = renderToStaticMarkup(<MemoryRouter><AttentionQueue workspace={workspace} /></MemoryRouter>);
  expect(html).toContain("Drive-Revisionsprüfung fehlgeschlagen");
});
