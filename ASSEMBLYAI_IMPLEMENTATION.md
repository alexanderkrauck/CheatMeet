# AssemblyAI as the default

The user approved AssemblyAI as the default, with no opt-in switch. This change
was deployed by the user through AI Studio. Automatic live-to-final identity
matching and the streamlined review below await the next user deployment. New recordings use Pro
streaming plus one independent Pro batch pass; imports use the batch pass only.
Existing reports retain
their saved transcript; this does not bulk-retranscribe historical audio.

## Recording and finalization

- A continuous live connection for each actual microphone/system source sends
  16 kHz mono PCM in 100 ms frames. Native resampling is requested; the worklet
  handles fallback sample rates. Raw recording stays independent.
- German + English are the per-meeting defaults. Languages are editable before
  recording and before final submission. Guidance is not a hard language filter.
- Turn IDs replace earlier partials. Word-level speaker revisions change labels,
  never text. Anonymous names remain stable within live display; identities from
  separate sources/sessions are kept distinct.
- Pause closes connections; resume starts fresh sessions. Disconnects permit
  three bounded reconnect attempts with future audio only. Stale frames and
  excess socket backlog are dropped visibly, never replayed in a burst.
- Connections roll over before the three-hour provider limit. A slow initial
  connection, pause/resume or rollover can leave a live gap. No recording-length
  cap was introduced; existing upload limits still apply.
- Finishing waits for final live events and speaker revisions, up to ten seconds.
  The report then backs up the mixed audio to Drive and requests the final batch
  pass. Final wording replaces provisional wording. Names and source metadata
  are reconciled against the user-maintained live reference. Fully matched
  results proceed directly to summary; only unresolved groups pause for a short
  review (or explicit skip). Summaries receive only the final text.
- The final pass reads the private Drive file through the server and streams
  bytes to AssemblyAI. The small browser request avoids Cloud Run's HTTP/1
  upload-size limit. Drive credentials are used only with Google, never included
  in the AssemblyAI request. Small local-only API submissions have a 30 MiB cap.
- Final text and speaker data are checkpointed locally before summarization.
  A successful empty transcript means silence; it never triggers Gemini audio
  transcription. Failure keeps the original audio and prevents a provisional
  transcript from silently becoming the report's summary source.
- Live speakers can be named and filtered by source or identity. Source badges
  remain visible even for pending identities. Final speakers can be renamed/merged
  and individual turns reassigned, split at a text cursor, or edited. Matching
  passages automatically retain live names; only unresolved groups need review.
  The original audio can be played at each contribution during review.
  Corrections mark the summary for regeneration; regenerating uses text only.
  Provider IDs from live and batch are never assumed to be the same identity.

## Submission accounting and recovery

Each captured sample is sent at most once through the live transport, with one
final batch submission per meeting ID. Reconnects do not resend previous audio.
The final-job reservation is atomic and durable before calling AssemblyAI.
Concurrent requests, page retries and server restarts reuse its saved provider ID.
An upload failure or an explicit provider rejection is persisted as retryable,
with atomic reclamation so concurrent retries still create only one accepted job.
A provider submission with an uncertain outcome is blocked from automatic replay.
The raw audio is retained; this conservative case needs manual reconciliation,
not deletion of the reservation or another transcription under a new ID.

Production reservations live in the server-only `transcriptionJobs` Firestore
collection, accessed by the runtime service account. Existing client rules deny
access to that collection. Local development uses private, gitignored files in
`.transcription-jobs/`. Neither store contains API keys, Drive tokens or audio.

Provider batch results remain readable for restart/cross-device recovery; their
retention follows the AssemblyAI account policy. The application does not claim
that these results are deleted after export. Confirm that policy before rollout.

## Deployment requirements

- Add `ASSEMBLYAI_API_KEY` as a server-only secret alongside `GEMINI_API_KEY`.
  Do not prefix it with `VITE_`. No key was copied into this repository.
- The Cloud Run service account must be able to read/create/update the private
  Firestore job collection. This uses its existing runtime identity, not a
  browser Firestore grant or a new Admin SDK dependency.
- The deployment smoke test now refuses traffic promotion if AssemblyAI or Gemini
  configuration is missing. A configured flag checks presence, not credential
  validity or billing status; perform a scoped live smoke test before rollout.
- No package or lockfile changes were needed. Existing Gemini endpoints remain
  for compatibility; the new recording path does not select them as an automatic
  fallback and never adds a third transcription after a failed final pass.

## Verification and practical limits

Local checks after the incident fixes on 2026-09-14: **229 tests across 25 files**, TypeScript check,
production build, five PWA integration tests, nine deployment-config tests and
`git diff --check` passed. The deployment smoke script passed against the local
production bundle with placeholder keys (no provider calls). Playwright verified
nonzero PCM from both synthetic sources, native-request ordering, final/live
state separation, local audio checkpointing, and speaker rename/merge controls
at desktop and 390 px mobile widths without horizontal overflow.

Automated coverage includes streaming replacement/revisions, PCM frame rate,
source/session isolation, stale-frame dropping, pause/resume, reconnect without
replay, final-only summaries, silence, owner changes, idempotent final submission
across simultaneous requests/restarts, private Drive streaming and temp cleanup.
Browser checks use actual AudioWorklets with synthetic media and mocked ASR,
plus desktop/mobile speaker editing. They make no new paid transcription calls.

The preceding paid evaluation spent approximately USD 0.135 of the approved USD 5.
See STREAMING_RESULTS.md for recognition errors and limitations. No model can
promise no incorrect words; the short synthetic tests are stress cases, not a
real-meeting accuracy benchmark. This local implementation does not establish
speaker accuracy for overlap, cross-source echo or all native Teams capture
setups. Real OS picker, long-duration and production-provider checks remain
rollout acceptance work. Default behavior does not mean those limits disappear.

Incident diagnosis and recovery: see [TRANSCRIPTION_INCIDENT_2026-09-14.md](TRANSCRIPTION_INCIDENT_2026-09-14.md).


## Live-to-final identity matching

`reconcileSpeakers` uses normalized unique-word overlap inside a ±2-second
utterance window, combining shorter live utterances from the same identity.
A candidate needs at least 70% final-word coverage, with no substantial competing
identity. Twelve matching unique words are sufficient in a single utterance;
shorter contributions can inherit an identity established across the same batch
speaker. Coverage is an overlap score, not a calibrated confidence probability.
Long independently matching contributions can separate a batch label that merged
people; a mixed/echoed utterance with competing evidence stays unresolved.
Several batch labels may reuse the same maintained live identity. Short generic
acknowledgments alone cannot establish a match. Named live partials may provide
identity evidence when confirmed by the final wording, but their text is never
copied into the final result or summary.

The local draft freezes `speakerReference` before termination revisions so late
provider relabeling does not reinterpret the user's names. Final records retain
`liveSpeakers` (including unused names), `speakerIssues`, original
`providerSpeaker` and `sourceEvidence`. Matched sources are inferred from live
text/time correspondence (`live-match`), not recovered physical channels.
Separate durable audio channels are still needed for exact source attribution.

The final view shares TranscriptChat with live recording, including source badges,
source/person filtering and inline naming. Search/highlighting and copying remain
available. A matched report has `speakerReview: matched`; an unresolved report
shows only the affected groups, with listen/select/keep controls. Full speaker
editing remains under an optional details section. Legacy stored name suggestions
are displayed when no later user name overrides them.

Verification: 244 unit/integration tests in 25 files; typecheck, production build,
five PWA checks. Browser checks with synthetic provider data cover automatic
review bypass, a single unresolved group's resolution, preserved names/sources,
inline final renaming, filtering/search and mobile/desktop layout. No audio was
submitted to AssemblyAI for this change.
