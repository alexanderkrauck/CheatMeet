import { trashDriveFile } from "./drive";
import { auth } from "./firebase";
import { deleteDraft, getLocal, listLocal, putLocal } from "./local";
import { activeJobs } from "./pipeline";
import { dueAudio } from "./retention";
import { ensureDriveToken } from "./session";
import { ownedOperation, syncReport } from "./workflow";

/**
 * Keeps the promise the participants were given.
 *
 * There is no server-side scheduler and the files live in the user's own
 * Drive, so deletion runs here, while the app is open. That is exactly why the
 * consent notice says "ich lösche" rather than "wird automatisch gelöscht".
 */

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const START_DELAY_MS = 20_000;
const LAST_RUN_KEY = "cheatmeet:retention-swept";

let timer: ReturnType<typeof setTimeout> | undefined;
let initial: ReturnType<typeof setTimeout> | undefined;

const lastRunKey = (owner: string) => `${LAST_RUN_KEY}:${owner}`;

const sweptRecently = (owner: string, now: number) => {
  try {
    const last = Number(localStorage.getItem(lastRunKey(owner)));
    return Number.isFinite(last) && now - last < INTERVAL_MS;
  } catch {
    return false;
  }
};

const rememberSweep = (owner: string, now: number) => {
  try {
    localStorage.setItem(lastRunKey(owner), String(now));
  } catch {
    // Blocked site data: the sweep simply runs again next start.
  }
};

/** A dead Drive grant is not a dead file, so it must not burn an attempt. */
const isExpiredGrant = (error: unknown) =>
  error instanceof Error && error.message.includes("abgelaufen");

export async function sweepRetention(
  now = Date.now(),
): Promise<{ deleted: number; failed: number }> {
  const result = { deleted: 0, failed: 0 };
  if (!navigator.onLine) return result;
  const { owner, run } = ownedOperation();
  const busy = new Set(activeJobs().map((job) => job.reportId));
  const due = dueAudio(
    (await listLocal(owner)).map((entry) => entry.report),
    now,
    busy,
  );
  if (!due.length) return result;
  // Only now is a token worth minting: an ordinary start costs one scan.
  const token = await ensureDriveToken();
  if (!token) return result;

  for (const stale of due) {
    // Another device may have deleted the meeting since the scan. Writing it
    // back here would resurrect it in IndexedDB and in the cloud index.
    const current = (await getLocal(owner, stale.id))?.report;
    if (!current?.rawAudioUrl || current.audioDeletedAt) continue;
    try {
      await run(() => trashDriveFile(current.rawAudioUrl!, token));
      // Through syncReport so the summary and the archived JSON stop pointing
      // at a file that is no longer there.
      await syncReport(
        {
          ...current,
          rawAudioUrl: undefined,
          audioDeletedAt: new Date(now).toISOString(),
          audioDeleteError: undefined,
        },
        token,
      );
      // Otherwise this browser keeps full-quality audio that can never be
      // released again: freeing it requires the Drive pointer just cleared.
      await deleteDraft(owner, current.id).catch(() => {});
      result.deleted += 1;
    } catch (error) {
      result.failed += 1;
      // A dead grant is not a dead file, and an account change is nobody's
      // failure — neither may burn an attempt, and neither may write
      // bookkeeping into an account that has just taken over.
      if (isExpiredGrant(error) || auth.currentUser?.uid !== owner) break;
      await putLocal(owner, {
        ...current,
        audioDeleteAttempts: (current.audioDeleteAttempts ?? 0) + 1,
        audioDeleteError:
          error instanceof Error ? error.message : "Unbekannter Fehler",
      }).catch(() => {});
    }
  }
  return result;
}

/** Runs shortly after sign-in and every six hours; never throws at its caller. */
export function startRetentionSweep() {
  if (timer !== undefined || initial !== undefined) return;
  const pass = () => {
    const now = Date.now();
    let owner = "";
    try {
      owner = ownedOperation().owner;
    } catch {
      return;
    }
    if (sweptRecently(owner, now)) return;
    rememberSweep(owner, now);
    void sweepRetention(now).catch(() => {});
  };
  initial = setTimeout(() => {
    initial = undefined;
    pass();
  }, START_DELAY_MS);
  timer = setInterval(pass, INTERVAL_MS);
}

export function stopRetentionSweep() {
  if (initial !== undefined) clearTimeout(initial);
  if (timer !== undefined) clearInterval(timer);
  initial = undefined;
  timer = undefined;
}
