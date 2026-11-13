# Interrupted upload resume — handoff

## Delivered
- Explicit save choice persists in `Draft.processing` before token/network work. `analyze:false` remains false; undecided drafts never auto-run. No added retranscription opt-in.
- RecordPage uses the capture setter before its first token await; trailing transcript writes preserve the choice.
- Existing successful server poll then considers pending local intents. It reloads audio/checkpoints under a per-owner/report Web Lock and re-observes authoritative jobs before uploading. Accepted jobs never cause another source upload/provider submission.
- Completed source references plus `processing.sourceReady:true` are checkpointed before uncertain POST. Retry reuses that source, never browser AI or another export.
- Automatic failures back off 30s exponentially up to 5 minutes. Active capture / recording-screen busy work pauses automatic resume. Account checks guard asynchronous boundaries.

## Files owned/changed
`src/types.ts`, `src/lib/pipeline.ts`, `src/lib/pipeline.test.ts`, `src/lib/capture.ts`, `src/lib/capture.test.ts`, `src/pages/RecordPage.tsx`, this handoff. No parent-owned files changed. No browser, cloud, records, commit, push, deployment, skills or memory writes.

## Exported API
- NEW `setCaptureProcessing(analyze: boolean): Promise<void>` from capture.ts.
- Existing `startProcessing({ owner, draft, token?, analyze, resume? }): Promise<void>`; token now optional, `resume` is the observer-only path that reloads the checkpoint under the lock.
- Existing `pollServerProcessing(owner: string)` now also resumes explicit local upload intentions after successful server observation.
- Existing `observeServerProcessing(owner: string): () => void` supplies startup / periodic reconnection recovery; no new observer required.
- Other existing pipeline exports unchanged (`subscribeJobs`, `jobFor`, `activeJobs`, `clearJob`, `handoffServerProcessing`).

## RED / GREEN evidence
- RED intent test: `npx vitest run src/lib/pipeline.test.ts -t 'persists explicit intent'`: 1 failed (putDraft had not preceded network save).
- GREEN same test: 1 passed.
- RED capture/resume/source-checkpoint slice: 3 failed (missing capture setter, no automatic upload, missing sourceReady checkpoint).
- RED race/checkpoint preservation slice: 3 failed (account switched during config, recording-screen busy race, lost sourceReady marker).
- Final `npx vitest run src/lib/pipeline.test.ts src/lib/capture.test.ts`: 2 files, 61 tests passed.
- Final `npm run lint`: tsc --noEmit exit 0.
- Final `npm test`: 66 files, 999 tests passed.
- `git diff --check --` all six owned source/test paths: exit 0.

## Caveats
- Automatic resumption deliberately fails closed without navigator.locks or without configured server processing. Manual local fallback remains available in unconfigured development.
- Retry delay is per-tab memory, not durable: reload may immediately attempt once again. Intent and source checkpoint are durable.
- Google reauthorization remains explicit; no popup is triggered by retry. Missing token pauses/fails the attempt with its intent retained.
- Pending browser upload occupies that observer tick until it finishes. Browser must remain open until durable source upload + server acceptance, as before.
- `sourceReady` is an optional second flag inside the small processing object, specifically to distinguish uncertain POST from incomplete source upload.
- Actual 471MB recovery / deployment verification remains with the parent; no real recording was accessed here.
