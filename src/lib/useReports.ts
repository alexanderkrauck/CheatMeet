import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { captureSnapshot, subscribeCapture } from "./capture";
import { listDrafts, watchDrafts } from "./local";
import { activeJobs, jobFor, subscribeJobs } from "./pipeline";
import { reportHref, uid, watchReports } from "./reports";
import { auth } from "./firebase";
import { errorMessage } from "./session";
import type { ReportSummary } from "./meetingMeta";
import type { Draft } from "../types";

export interface Workspace {
  reports: ReportSummary[];
  /** Namespace-qualified report hrefs saved locally but not acknowledged. */
  dirty: string[];
  drafts: Draft[];
  /** Separate from `error`: the meeting list can be fine while drafts are not. */
  draftsError: string;
  /** Namespace-qualified report hrefs with work running in this tab. */
  running: Set<string>;
  loading: boolean;
  error: string;
  reload: () => void;
}

/**
 * The meeting list, as summaries. One route element is mounted at a time, so
 * the overview and the calendar never hold two listeners at once — this is a
 * shared hook, not a shared subscription.
 *
 * Drafts are refreshed on capture and job transitions rather than on the raw
 * IndexedDB write channel: a running recording commits a chunk every ten
 * seconds, and each of those would otherwise cost a full object-store scan.
 */
export function useReports(): Workspace {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [dirty, setDirty] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draftsError, setDraftsError] = useState("");
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch((n) => n + 1), []);

  // activeJobs() is only rebuilt when a job actually changes, so its identity
  // is a valid snapshot; deriving a new array here would loop forever.
  const jobs = useSyncExternalStore(subscribeJobs, activeJobs, activeJobs);
  const captureState = useSyncExternalStore(
    subscribeCapture,
    () => captureSnapshot().state,
    () => "ready" as const,
  );

  useEffect(() => {
    setError("");
    setLoading(true);
    return watchReports(
      (data, unsynced) => {
        setReports(data);
        setDirty(unsynced);
        setLoading(false);
      },
      (cause) => {
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
  }, [epoch]);

  useEffect(() => {
    let active = true;
    let requested = 0;
    const owner = uid();
    const refresh = () => {
      const request = ++requested;
      void listDrafts(owner, { includeAudio: false })
      .then((found) => {
        if (!active || request !== requested) return;
        setDrafts(found);
        setDraftsError("");
      })
      .catch((cause) => {
        if (active && request === requested) setDraftsError(errorMessage(cause));
      });
    };
    const stop = watchDrafts(owner, refresh);
    refresh();
    return () => {
      active = false;
      stop();
    };
  }, [epoch, captureState, jobs.length]);

  const owner = auth.currentUser?.uid;
  const running = new Set(reports.filter(report => {
    const job = jobFor(report.id, report);
    return !!owner && job?.owner === owner && jobs.includes(job);
  }).map(reportHref));

  return {
    reports,
    dirty,
    drafts,
    draftsError,
    running,
    loading,
    error,
    reload,
  };
}
