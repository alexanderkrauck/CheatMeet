import { useEffect, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowRight, Loader2 } from "lucide-react";
import { activeJobs, subscribeJobs } from "../lib/pipeline";

const snapshot = () => activeJobs();

/**
 * Keeps a running save/analysis visible from every screen, so the pipeline no
 * longer has to hold a page hostage while it works.
 */
export default function JobProgress() {
  const jobs = useSyncExternalStore(subscribeJobs, snapshot);
  const location = useLocation();

  useEffect(() => {
    if (!jobs.length) return;
    // The pipeline lives in this tab: closing it would abandon the upload.
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [jobs.length]);

  // The capture screen owns its bottom edge: the pill sat on top of pause
  // and stop. RecordingBar already stands aside here for the same reason.
  if (!jobs.length || location.pathname.startsWith("/record")) return null;
  return (
    <div className="job-progress no-print" role="status" aria-live="polite">
      {jobs.map((job) => (
        <Link key={job.reportId} to={`/report/${job.reportId}`}>
          <Loader2 className="spin" size={16} />
          <span>{job.message}</span>
          <ArrowRight size={16} />
        </Link>
      ))}
    </div>
  );
}
