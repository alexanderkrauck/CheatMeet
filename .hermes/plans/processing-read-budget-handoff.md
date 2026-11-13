# Processing observer read-budget handoff

Scope: router-only nonauthoritative owner list cache and browser observer cadence; Firestore remains durable source. No cloud actions, deploy, commit or reservation/state changes.

## TDD results
- Added exactly four regressions (two real localhost-router tests, two fake-clock observer tests).
- Router RED: concurrent owner lists performed 2 owner queries instead of 1; repeated terminal list performed 6 total queries instead of 5. GREEN: all 18 router tests pass, including auth per request, Microsoft/legacy filtering, owner isolation, concurrent coalescing, active/idle expiry, 128-owner eviction, acceptance invalidation, worker transitions and terminal invalidation.
- Observer RED: idle performed 60 list requests before five minutes instead of 1; initially hidden performed 61 instead of 0. GREEN: fake-clock tests verify five-minute idle, immediate accepted-job wake (even against a stale empty router list), five-second active, terminal return to idle, background pause, focus/visibility resume, 30s then 60s failure backoff, explicit draft retry only after successful observation, and cleanup without recursive polls.
- Final requested command: `npx vitest run tests/processing.test.ts src/lib/pipeline.test.ts src/lib/serverProcessing.test.ts` → 3 files / 53 tests passed.
- `npm run lint` and `git diff --check` passed.
- Additional `npm test` → 88 files / 1146 tests passed (baseline 1142 + four regressions).

## Changed files
- `server/processing/index.ts`: bounded owner list snapshot cache; invalidation in send helper and successful worker claim. Cached payload contains public job metadata plus provider flag, not full private job records or hydrated reports.
- `tests/processing.test.ts`: two router regressions.
- `src/lib/pipeline.ts`: observer cadence, visibility/focus lifecycle, subscription wake and bounded failure backoff; polling exposes authoritative active-work presence without changing retry/upload paths.
- `src/lib/pipeline.test.ts`: two observer regressions.
- This handoff. `src/lib/serverProcessing.ts` and its test were read and verified but needed no edits.

## Exact read-cost effect and refresh limits
- Before: every list GET performed a full owner-history query before slicing to 50. After: one query per owner/cache miss; concurrent requests share that query; cache hits perform zero owner-list queries. Query miss billing and full-history scan itself remain unchanged.
- A continuously visible idle observer changes from 720 list requests/hour to 12/hour in steady state, a 98.333% reduction; a full owner scan with D charged document reads changes correspondingly from approximately 720D to 12D/hour for one observer, excluding initial/focus refreshes and invalidations.
- Same-instance hot idle callers share a 60-second TTL (approximately 60 owner-list queries/hour absent writes/eviction); active TTL is 5 seconds. Up to 128 owners retained; eviction and router restarts simply cause fresh reads.
- Hidden/unfocused observer schedules no further polls; an already-started request is not aborted. Focus/visibility resumes immediately. Successful local acceptance wakes idle observation immediately; acknowledged active local work retains five-second polling even if another instance still serves an empty idle snapshot.
- Active polling: 5 seconds after completion of the prior observation. Idle polling: 5 minutes. Errors: 30, 60, 120, 240, then 300 seconds (capped), reset after success. Focus/visibility can explicitly bypass the timer.
- Cache invalidation is per router instance, not distributed. Other instances may retain an idle snapshot up to 60 seconds or active snapshot up to 5 seconds. Cross-device idle discovery can therefore take roughly five minutes plus idle cache TTL; active refresh includes polling interval plus cache TTL. Terminal/detail reads, authentication and grants are never cached here.
- Firestore remains the durable job store. Worker states, reservation identities, upload recovery and authoritative-before-retry ordering are unchanged. This does not recover an already exhausted daily quota; parent owns immediate cloud recovery.

## Scope and issues
No cloud operations, browser use, secrets/private records, commits, pushes, deployments, dependencies or other repo changes. No outstanding test/typecheck failures. One initial test fixture used epoch-zero time and caused expiring-memory-store behavior; corrected to an injected current-time baseline before establishing the meaningful RED failures above.
