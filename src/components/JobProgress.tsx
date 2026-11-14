import { useEffect, useRef, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowRight, ChevronDown, Loader2 } from "lucide-react";
import { activeJobs, subscribeJobs } from "../lib/pipeline";
import { auth } from "../lib/firebase";

const snapshot = () => activeJobs();

/**
 * Keeps a running save/analysis visible from every screen, so the pipeline no
 * longer has to hold a page hostage while it works.
 */
export default function JobProgress() {
  const jobs = useSyncExternalStore(subscribeJobs, snapshot, snapshot);
  const location = useLocation();
  const owner = auth.currentUser?.uid;
  const ownedJobs = jobs.filter(job => job.owner === owner);
  const container = useRef<HTMLDivElement>(null);
  const visible = ownedJobs.length > 0 && !location.pathname.startsWith("/record");
  useEffect(() => {
    const element = container.current;
    if (!visible || !element || typeof ResizeObserver === "undefined") return;
    const style = document.documentElement.style;
    const measure = () => style.setProperty("--job-progress-height", `${Math.ceil(element.getBoundingClientRect().height)}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("toggle", measure, true);
    measure();
    return () => { observer.disconnect(); element.removeEventListener("toggle", measure, true); style.removeProperty("--job-progress-height"); };
  }, [visible]);

  useEffect(() => {
    if (!jobs.some((job) => job.owner === owner && !job.serverOwned)) return;
    // Only an unfinished browser upload/local job needs this guard. Server
    // acceptance explicitly promises that closing the tab is safe.
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [jobs, owner]);

  // The capture screen owns its bottom edge: the pill sat on top of pause
  // and stop. RecordingBar already stands aside here for the same reason.
  if (!visible) return null;
  const list = <div className="job-progress-list">
        {ownedJobs.map((job) => {
          const href = `/report/${encodeURIComponent(job.reportId)}?index=${job.storage === "microsoft" ? "meetings" : "reports"}`;
          return <Link key={href} to={href}>
            <Loader2 className="spin" size={16} aria-hidden="true" />
            <span>
              <strong className="job-progress-title">
                {job.title?.trim() || `Meeting ${job.reportId}`}
                {job.date && Number.isFinite(Date.parse(job.date)) && ` · ${new Date(job.date).toLocaleDateString("de-AT", { day: "2-digit", month: "2-digit" })}`}
              </strong>
              <span className="job-progress-message">{job.message}</span>
            </span>
            <ArrowRight size={16} aria-hidden="true" />
          </Link>;
        })}
      </div>;
  return (
    <div ref={container} className="job-progress no-print" role="status" aria-live="polite">
      {ownedJobs.length === 1 ? list : <details className="job-progress-group">
        <summary><Loader2 className="spin" size={16} aria-hidden="true" /><span>{ownedJobs.length} Vorgänge im Hintergrund</span><ChevronDown size={16} aria-hidden="true" /></summary>
        {list}
      </details>}
    </div>
  );
}
