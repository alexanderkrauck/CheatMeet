import React from "react";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
vi.mock("../lib/firebase", () => ({ auth: { currentUser: { uid: "qa-owner" } } }));
const h = vi.hoisted(() => ({ jobs: Array.from({ length: 6 }, (_, index) => ({ owner: "qa-owner", reportId: `qa-${index}`, title: `QA Meeting ${index}`, message: "Wird verarbeitet", serverOwned: true, storage: "google" as "google" | "microsoft" })) }));
vi.mock("../lib/pipeline", () => ({ activeJobs: () => h.jobs, subscribeJobs: () => () => {} }));
import JobProgress from "./JobProgress";
it("groups multiple background jobs behind one initially collapsed disclosure", () => {
  const html = renderToStaticMarkup(<MemoryRouter><JobProgress /></MemoryRouter>);
  expect(html.match(/<details\b[^>]*>/)?.[0]).toBe('<details class="job-progress-group">');
  expect(html).toContain("6 Vorgänge im Hintergrund");
  expect(html).toContain("QA Meeting 5");
});
it("links same-ID background jobs to their own provider namespace", () => {
  h.jobs = h.jobs.slice(0, 2).map((job, i) => ({ ...job, reportId: "same", storage: i ? "microsoft" : "google" }));
  const html = renderToStaticMarkup(<MemoryRouter><JobProgress /></MemoryRouter>);
  expect(html).toContain('href="/report/same?index=reports"');
  expect(html).toContain('href="/report/same?index=meetings"');
});
