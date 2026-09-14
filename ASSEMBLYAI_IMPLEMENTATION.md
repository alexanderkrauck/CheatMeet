# AssemblyAI: keep the live transcript

The user's current decision (2026-09-14) supersedes the earlier two-pass design:
recorded meetings use their initial/live transcript directly. There is no final
batch transcription, no live-to-batch identity matching, and no mandatory speaker
review on completion. This change awaits the user's next AI Studio deployment.

## Recording and completion

- Each microphone/system source has its own AssemblyAI stream. Audio packets are
  sent once; reconnects send future audio only. German/English remain the default.
- Stopping drains the current stream's last Turn events, with the existing bounded
  shutdown timeout. This completes the same streaming session, not another ASR job.
- Global end-of-session SpeakerRevision events are ignored so the names the user
  maintained do not get reassigned. Regular live Turn updates remain supported.
- Visible unfinished turns are retained on stream closure, not silently deleted.
  Missing confirmation, dropped frames and connection failures produce a warning
  that remains visible on the saved report. No later pass repairs these gaps.
- `prepareTranscript` checkpoints the live document locally and renders it with
  the existing names, source identities and timestamps. Its `phase: final` means
  the document is ready to save/summarize; it does not mean batch ASR ran, and
  individual unconfirmed turns retain `final: false`.
- The raw audio is backed up to Drive as before. Summarization sends only the
  saved transcript to Gemini. A missing live transcript fails explicitly instead
  of silently uploading the recording for another transcription.
- The saved report uses the same source-aware conversation layout, source/person
  filters and inline names. Corrections remain optional and summaries can be
  regenerated from edited text without retranscribing audio.

## Imported audio and compatibility

Imported audio has no live transcript, so it receives one initial batch
transcription through `/api/transcription/import/:id`. The existing durable
reservation, polling, confirmed-rejection retry and uncertain-submission guard
remain in place. Reopening or summarizing the import does not submit it again.
Imports proceed directly to summary; names can be edited afterward.

New reports identify their origin as `live` or `import`. Older captured drafts
are recognized using capture metadata, live turn IDs or saved transcript text.
A legacy draft's saved `speakerReference` can recover its initial live document.
Importing replacement audio creates a new ID and clears capture/reference fields.

The retired POST `/api/transcription/final/:id` returns 410 without provider calls,
preventing older open clients from starting a second pass after deployment. Its
GET remains readable for historical jobs. Already completed historical reports
retain their saved text; a batch-only report cannot reconstruct an absent live
transcript. Legacy speaker-review/matching utilities remain for old report data.

## Verification

251 tests in 25 files, typecheck, production build and five PWA checks. Coverage
includes no ASR call for recorded meetings, source/name preservation, empty/live
failure handling, concurrent preparation, import replacement, retired endpoint
rejection and one-time import submission. Browser checks use synthetic streams
and mocked providers; no audio was resubmitted to AssemblyAI for this change.

Deployment remains user-managed through AI Studio. GitHub automatic deployment
is disabled. Reopen the app after deployment so the client uses the new flow.

Earlier evaluation/design history is retained in STREAMING_RESULTS.md,
STREAMING_PROPOSAL.md and TRANSCRIPTION_INCIDENT_2026-09-14.md.
