# Durable meeting processing — approved implementation

User: “then do it fully yourself and deploy end to end so it works.”
Baseline: bab6031. Existing tests 939 pass. Parent owns integration, frontend, cloud setup, release and live recovery. Backend child owns server/processing/**, new tests/processing*.test.ts, new shared/processing.ts, server/analysis.ts and server/transcription.ts as needed to extract reusable owner services. No commits/push/cloud writes by child.

## Outcome
After recording/audio and transcript are durably uploaded to Drive and a server job is accepted, processing continues without the browser. Temporary failures retry with bounds, completed steps are not rerun, ambiguous paid transcription submissions never create another accepted pass. Google reauthorization and speaker review pause for a person. Existing summaries/edits are not blindly overwritten. Keep code compact; no elaborate scheduler/broker framework.

## API contract (parent frontend will call these)
Router mounted under `/api` by parent:
- GET `/processing/config` => `{enabled:boolean}`. Enabled only when Cloud Tasks runtime configured; local fallback remains available when disabled.
- POST `/processing/:id` Firebase Bearer, JSON `{report: ReportData, analyze:boolean, retranscribe?:boolean, calendarSync?:boolean, preferences?:string}` => HTTP202 `{job:ProcessingJobView}`. Browser calls after backupDraft + local-only transcript finalization + syncReport, so report has Drive IDs and durable transcript JSON. Server reads authoritative source from Drive, not transcript body; job doc must not duplicate transcript/audio. Source report payload provides reference IDs if cloud index save was transiently delayed; verify matching id, account, Drive folder/file parent membership. Accepted job must be persisted and queued before acknowledgment. Existing same report job is idempotent; blocked/error can be resumed; done not blindly rerun. Explicit new source revision allowed, respecting active job and user edits.
- GET `/processing` Firebase Bearer => `{jobs:ProcessingJobView[]}` owner-only, bounded list for resuming display after reload.
- GET `/processing/:id` Firebase Bearer => `{job:ProcessingJobView,report?:ReportData}` returns final/review report for local hydration when available. Read-only: do not start AI on GET.
- POST `/processing/worker` Cloud Tasks OIDC only, audience = configured PROCESSING_WORKER_URL (https public app /api/processing/worker), expected worker service-account identity. Process one bounded step, enqueue/persist follow-up as required. Never accept browser bearer as worker authorization.

shared/processing.ts exports `ProcessingJobView` with `{reportId:string,state:'queued'|'transcribing'|'analyzing'|'exporting'|'review'|'done'|'blocked'|'error',message:string,attempts:number,error?:string,warning?:string,updatedAt:string}` and any small pure predicates needed. No credentials/Google sub/provider details in public view.

## Environment
PROCESSING_QUEUE = `projects/gen-lang-client-0187125016/locations/europe-west2/queues/cheatmeet-processing`
PROCESSING_WORKER_URL = `https://cheatmeet.ai.studio/api/processing/worker`
PROCESSING_SERVICE_ACCOUNT = to be created `cheatmeet-processing@gen-lang-client-0187125016.iam.gserviceaccount.com`
Existing runtime SA = 107228250814-compute@developer.gserviceaccount.com. Existing Google grants server/tokenStore.ts, OAuth credentials env. Use Firestore named database from firebase-applet-config.json, not default. Existing server/mcp/docStore.ts gives REST CAS store; reuse it. No dependencies requiring lockfile changes unless truly necessary; Google auth via existing jose/JWKS and metadata token/REST.

## Worker requirements
- Source Drive JSON is durable, archive.ts fromArchive/toArchive, markdown.ts export helpers are pure; check imports before server use. Firestore report index is projection only (`src/lib/reportProjection.ts`).
- Reuse existing protected batch owner in server/transcription.ts (extract reusable service, do not duplicate submission business rules). Same owner/id reservation persists and uncertain submission stays closed. Imported audio needs batch; live only if retranscribe explicitly true. Reuse speakerMatches.ts for names and existing review semantics.
- Reuse analysis owner in server/analysis.ts by extracting `analyzeTranscript` service, retaining schema, prompts, model env, provider retry behavior. Worker call per-step has timeout comfortably below Cloud Tasks/Cloud Run dispatch; provider wait/poll across new tasks not open-ended sleeps. No Gemini audio fallback for existing transcript recovery.
- Step outputs/checkpoints live in Drive before advancing. Drive writes upsert known IDs/look up exact name in same meeting folder after uncertain upload; avoid duplicates. Index projectReport strips transcript. Never claim local write is cloud success.
- Calendar opt-in behavior must remain: update only already-linked event with the same existing text semantics; warn (not fatal) on Calendar failure.
- Worker uses server-held refresh grant; missing/invalid grant => blocked, not sign-out or deletion. Re-check credentials on each attempt. No refresh/id token stored in job/task payload.
- Retry network/429/5xx with bounded attempts/delays, distinguish permanent validation/not-found; job replay idempotent via atomic claim/lease and immutable run identity. No automatic repeat completed paid stages. Cloud Tasks duplicate deliveries are expected. Check source revision/user edit conflicts before exporting so old jobs do not overwrite later edits.

## Acceptance
Tests RED/GREEN through real Express endpoints and fake providers/Firestore or injectable queue/store. Cover account isolation, worker token rejection, duplicate dispatch, transient recovery, permanent/blocked behavior, successful text-only flow, optional batch/speaker review, no new batch on uncertain submission, checkpoint resume. Run targeted tests as slices, keep npm run lint clean. Parent verifies full suite/build/CI and real deployed recovery with browser closed.

## Historical recovery (parent only)
Scratch cheatmeet-failed-records.json and cheatmeet-archive-diagnostic.json contain verified nine failed IDs. Eight have readable archived final speech/transcript but no summary. Recover from existing text without ASR. Trescon 511ca294-f052-43d5-a91d-e8ab0ee073df has audio reference but no JSON/transcript reference; investigate source device/Drive before any fresh paid transcription. Runtime browser CFT CDP 9223 authenticated as alexander.krauck@gmail.com. Do not touch user records from child.
