import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/useReports", () => ({ useReports: () => ({
  reports: [{ id: "qa-meeting", date: "2026-11-14T09:00:00Z", durationMs: 60_000, summary: "QA" }],
  loading: false, error: "", dirty: [], reload: vi.fn(),
}) }));
import UsagePage from "./UsagePage";

afterEach(() => vi.useRealTimers());
it("puts days with activity first instead of burying them behind a month of zero rows", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
  const html = renderToStaticMarkup(<UsagePage />);
  const rows = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1].match(/<tr\b/g);
  expect(rows).toHaveLength(1);
  expect(html).toContain("Tage ohne Meetings anzeigen");
});
