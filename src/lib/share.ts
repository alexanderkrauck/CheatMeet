import { reportShareText } from "./markdown";
import type { ReportData } from "../types";

export type ShareOutcome = "shared" | "copied" | "mail" | "cancelled" | "failed";

/**
 * Hands the meeting to whatever the device has. Web Share on a phone, the
 * clipboard on a desktop, and a prefilled mail when neither is available —
 * the point is that the decisions leave the app, not which route they take.
 */
export async function shareReport(report: ReportData): Promise<ShareOutcome> {
  const text = reportShareText(report);
  const title = report.title || "Meeting";
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return "shared";
    } catch (error) {
      // A cancelled share is a choice, not a failure to fall back from.
      if ((error as Error)?.name === "AbortError") return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    // A popup blocker returns null; claiming the mail opened would be a lie.
    const opened = window.open(
      `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`,
    );
    return opened ? "mail" : "failed";
  }
}
