import { afterEach, describe, expect, it, vi } from "vitest";
import { shareReport } from "./share";
import { reportShareText } from "./markdown";
import type { ReportData } from "../types";

const report = (over: Partial<ReportData> = {}): ReportData => ({
  id: "r1", date: "2026-09-14T08:00:00.000Z", title: "Weekly Sync",
  summary: "Roadmap besprochen.", transcription: "",
  todos: [{ text: "Angebot senden", owner: "Anna", due: "2026-09-30" }],
  takeaways: [], ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("reportShareText", () => {
  it("carries the title, the summary, the tasks and the Drive link", () => {
    const text = reportShareText(report({ driveFolderId: "f1" }));
    expect(text).toContain("Weekly Sync");
    expect(text).toContain("Roadmap besprochen.");
    expect(text).toContain("Angebot senden @Anna bis 2026-09-30");
    expect(text).toContain("drive.google.com/drive/folders/f1");
  });
  it("marks what is already done", () => {
    expect(reportShareText(report({ todos: [{ text: "X", done: true }] }))).toContain(
      "(erledigt)",
    );
  });
  it("degrades to just a title", () => {
    expect(reportShareText(report({ summary: "", todos: [], title: "" }))).toBe("Meeting");
  });
});

describe("shareReport", () => {
  it("uses the native share sheet where there is one", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });
    expect(await shareReport(report())).toBe("shared");
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Weekly Sync" }),
    );
  });
  it("treats a cancelled share as a choice, not a failure", async () => {
    const abort = Object.assign(new Error("no"), { name: "AbortError" });
    const writeText = vi.fn();
    vi.stubGlobal("navigator", {
      share: vi.fn().mockRejectedValue(abort),
      clipboard: { writeText },
    });
    expect(await shareReport(report())).toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });
  it("falls back to the clipboard when the share sheet fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      share: vi.fn().mockRejectedValue(new Error("nope")),
      clipboard: { writeText },
    });
    expect(await shareReport(report())).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Weekly Sync"));
  });
  it("copies when there is no share sheet at all", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await shareReport(report())).toBe("copied");
  });
  it("opens a prefilled mail when even the clipboard is blocked", async () => {
    const open = vi.fn().mockReturnValue({});
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    vi.stubGlobal("window", { open });
    expect(await shareReport(report())).toBe("mail");
    expect(open).toHaveBeenCalledWith(expect.stringContaining("mailto:?subject="));
  });
  it("reports failure rather than success when the popup is blocked", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    vi.stubGlobal("window", { open: vi.fn().mockReturnValue(null) });
    expect(await shareReport(report())).toBe("failed");
  });
});
