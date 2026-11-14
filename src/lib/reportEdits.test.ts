import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";
import { forgetReportEdit, recoverReportEdit, rememberReportEdit } from "./reportEdits";

const storage = new Map<string, string>();
const report = (microsoft = false): ReportData => ({
  id: "same", title: microsoft ? "Microsoft" : "Google", date: "2026-11-14",
  summary: "Saved", transcription: "Text", todos: [], takeaways: [], updatedAt: "v1",
  ...(microsoft ? { home: { provider: "microsoft", connectionId: "c", driveId: "d", rootId: "root", rootName: "Meetings" } } : {}),
});
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

it("recovers and forgets only the selected same-ID provider edit", () => {
  for (const microsoft of [false, true]) {
    const saved = report(microsoft);
    expect(rememberReportEdit("owner", { report: { ...saved, summary: `${saved.title} correction` }, baseUpdatedAt: "v1", todosText: "", editFields: true })).toBe(true);
  }
  expect(recoverReportEdit("owner", report())?.report.summary).toBe("Google correction");
  expect(recoverReportEdit("owner", report(true))?.report.summary).toBe("Microsoft correction");
  forgetReportEdit("owner", "same", { index: "reports" });
  expect(recoverReportEdit("owner", report())).toBeUndefined();
  expect(recoverReportEdit("owner", report(true))?.report.home).toEqual(report(true).home);
  expect(recoverReportEdit("other-owner", report(true))).toBeUndefined();
});
