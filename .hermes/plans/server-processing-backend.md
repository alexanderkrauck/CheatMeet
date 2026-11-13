# Backend handoff — complete locally

## Integration
- Mount `createProcessingRouter()` from `server/processing/index.ts` under `/api`; `processingConfigured()` is re-exported there for health/config. Exact brief endpoints and `shared/processing.ts` public view implemented.
- Runtime uses named Firestore `processingJobs`, deterministic Cloud Tasks REST tasks (`240s` dispatch deadline), Google OIDC expected service-account email/audience, server-held Drive grants and existing ASR final-pass reservations. No dependencies or lock changes.
- One Gemini generation per dispatch (SDK retries explicitly disabled; <=120s, capped by remaining budget). All work-step REST calls share an awaited 200s abort budget. Existing 300s server/Cloud Run timeout is sufficient. Follow-up enqueue and state writes are awaited.

## Behavior verified
Owner-only acceptance/list/hydration; browser-token rejection at worker; CAS lease/duplicate/run isolation; bounded transient retries; persist-before-enqueue failure recovery; Drive checkpoints skip completed steps; uncertain committed Drive export reconciles without duplicate files; missing/revoked grants block without deleting grants; source/index revision and folder/account checks refuse newer edits; final/review GET returns full report; omitted preferences come from server Firestore.

Text recovery uses archived transcription or renders archived speech, never audio by default (including existing imported text and retained-audio deletion). Only explicit retranscribe or an empty import uses the shared ASR service. Uncertain ASR submission remains reserved across worker/HTTP retries; speaker ambiguities pause in review; reviewed final imports preserve edits. Save-only never starts ASR and can later explicitly upgrade to analysis. Existing nonempty summaries are preserved. Calendar only updates linked opted-in events, preserves organiser text, handles deletion/unlink semantics, and checkpoints warnings without failing the report. Firestore final report is `projectReport` without speech/transcript.

## Actual verification
- `npm test`: **65 files, 972 tests passed** (includes parent's parallel frontend additions).
- `npm run lint`: clean.
- `git diff --check`: clean.
- Added backend tests: `tests/processing.test.ts` (14), `tests/processing-runtime.test.ts` (11). Existing analysis/transcription regression suites green.

## Files / residual verification
Created `server/processing/{index,runtime,drive,budget}.ts`, `shared/processing.ts`, two test files. Modified only owned `server/analysis.ts` and `server/transcription.ts` to extract shared owners, plus this handoff. No browser, user-record, cloud, paid API, commit, push, deployment, secret or skills/memory actions.

Parent must still verify deployed queue/IAM/OIDC routing and Drive ETag headers on real source files (export deliberately refuses an unguarded overwrite if ETag is absent), then run production/historical recovery. Tests use fake providers only. Like any provider without an idempotency key, a Gemini response lost before its Drive checkpoint can require another generation; ASR is stricter and remains closed on uncertain acceptance.
