# Durable server processing

## User-visible boundary

Recording and the first durable Drive upload require the browser to remain open.
After `POST /api/processing/:id` acknowledges acceptance, processing/retries belong
to the server. Closing the tab does not cancel them. App polling only displays
progress; reopening or another signed-in device can hydrate the finished report.

The default uses saved live text. The explicit final-transcription option and
imports use the existing one-final-pass AssemblyAI reservation. An uncertain ASR
submission is never automatically sent again. Speaker ambiguity pauses for review.
Google permission loss blocks the job without signing the person out of Firebase.

## Runtime bindings

The GitHub deployment reads these repository variables into Cloud Run:

- `PROCESSING_QUEUE`: `projects/gen-lang-client-0187125016/locations/europe-west2/queues/cheatmeet-processing`
- `PROCESSING_WORKER_URL`: `https://cheatmeet.ai.studio/api/processing/worker`
- `PROCESSING_SERVICE_ACCOUNT`: `cheatmeet-processing@gen-lang-client-0187125016.iam.gserviceaccount.com`

Existing Google OAuth, Gemini and AssemblyAI credentials remain server-held.
Runtime service account may enqueue on this queue and act as the task identity;
the Cloud Tasks service agent may mint its OIDC tokens. The public worker route
requires that exact verified identity and audience, not a browser Firebase token.
The queue is bounded to two concurrent dispatches. No always-on worker is needed.

`processingJobs` uses the configured **named** Firestore database, compare-and-set
leases and `expireAt` metadata. No transcript/audio is duplicated in this collection.
Job stage outputs are private JSON checkpoints within the original Drive meeting
folder. `bericht_daten.json` remains the interchange source of truth; the final
Firestore report remains transcript-free. Keep original and checkpoint files while
recovering a job. Do not delete transcription reservations to retry a paid submission.

## Retry / conflict semantics

Each successful step is checkpointed before moving on. Temporary failures retry
with bounded delays; permanent validation/provider rejection, missing permission,
newer user edits and uncertain ASR submissions stop or block explicitly. The worker
spends at most 200 seconds in an awaited step (one <=120 second Gemini attempt),
within the current 300 second Cloud Run request limit. Never start an unawaited
background promise after returning a successful HTTP response.

Drive v3 can omit response ETags. The source loader verifies v2's explicit version
against v3's before-media version, then conditionally PUTs through v2 with If-Match.
A real disposable-file check verified successful conditional PUT and stale-token
HTTP412 rejection without changing the content. Firestore publishing also carries
an update-time precondition. A newer index/archive edit blocks the old job.

Gemini has no transactional idempotency key: a generated response lost before its
Drive checkpoint may require another billable generation. The app does not promise
exactly-once AI billing. ASR uncertainty is stricter and keeps its reservation closed.

## API / recovery

Firebase-authenticated owner endpoints: GET `/api/processing`, GET/POST
`/api/processing/:id`. POST receives durable report references and the analysis /
retranscription / Calendar options; it reads content from Drive, not an untrusted
transcript payload. GET never starts AI. POST is idempotent for an active job.
Finished/review GET responses include the full report for this device's local store.
`GET /api/processing/config` and `/api/health` expose configuration readiness only.

Recover a failed report from its saved Drive JSON through the same POST, with
`analyze:true` and no retranscription. If only audio exists, explicitly reconstruct
the missing archive reference and request one batch pass; do not silently replace a
saved transcript. Follow job state, then read back the authoritative Drive files,
Firestore projection and fresh browser view. A successful enqueue alone is not
proof of recovery.

## Verification

Run `npm run lint`, `npm test`, `npm run test:pwa` and the Python deploy tests.
The deploy smoke checks configuration plus unauthenticated worker rejection.
Production acceptance must additionally prove task OIDC dispatch, actual provider
processing, completion with the initiating tab closed and saved-output read-back.
