# AssemblyAI: live by default, explicit full-audio pass

Recorded meetings use their initial/live transcript directly by default. One
additional full-audio batch pass can be explicitly selected before analysis or
started from the finished report. It is never automatic. The durable reservation
and uncertain-submission guards apply to both entry points.

## Recording and completion

- Before recording, independent per-meeting checkboxes can confirm one person
  on the microphone and/or system audio. Both default off. Confirmed sources use
  a stable source-specific speaker identity across turns, pauses and reconnects;
  provider labels (including unknown) cannot split that person. The other source
  retains automatic diarization. The confirmed microphone speaker defaults to
  the signed-in account’s display name, falling back to “Ich”. Explicit inline
  names still take precedence. Choices are stored
  with the draft/report and cleared when importing replacement audio.
- Each microphone/system source has its own AssemblyAI stream. Audio packets are
  sent once; reconnects send future audio only. German/English remain the default.
- Stopping drains the current stream's last Turn events, with the existing bounded
  shutdown timeout. This completes the same streaming session, not another ASR job.
- Global end-of-session SpeakerRevision events are ignored so the names the user
  maintained do not get reassigned. Regular live Turn updates remain supported.
- Visible unfinished turns are retained on stream closure, not silently deleted.
  Missing confirmation, dropped frames and connection failures produce a warning
  that remains visible on the saved report. Only an explicitly selected full-audio
  pass can attempt to repair those gaps; reconnecting never replays dropped audio.
- `prepareTranscript` checkpoints the live document locally and renders it with
  the existing names, source identities and timestamps. Its `phase: final` means
  the document is ready to save/summarize; it does not mean batch ASR ran, and
  individual unconfirmed turns retain `final: false`.
- The raw audio is backed up to Drive as before. Summarization sends only the
  saved transcript to Gemini. A missing live transcript fails explicitly instead
  of silently uploading the recording for another transcription.
- The saved report uses speaker-led transcript rows with passage-local playback,
  source/person filters and inline names. Corrections remain optional and summaries can be
  regenerated from edited text without retranscribing audio.

## Full-audio retranscription after completion

- The finished transcript exposes **Gesamte Aufnahme neu transkribieren**. The
  confirmation first reads `POST /api/processing/:id/retranscription-status`:
  archive/index and native reservation metadata only, without polling AssemblyAI,
  enqueueing a task or changing the report. Used, uncertain, busy, unavailable and
  missing-audio states do not enable a paid start.
- Explicit confirmation calls the existing server processing handoff with
  `analyze: true`, `retranscribe: true`, `regenerate: true`. It replaces the
  transcript and then regenerates summary, tasks and takeaways; the dialog names
  that manual edits to these derived fields will be replaced. The confirmation
  pins its reviewed local revision and archive source, and later human edits
  still block export through the existing native conditional writes.
- The existing `transcriptionJobs` reservation remains keyed by owner and
  `<meetingId>:final`. A new explicit worker pass binds its run/source metadata
  inside that reservation so it cannot mistake an older job's output for a new
  transcription. No uncertain reservation is deleted, and repeated accepted
  requests retain the existing run rather than creating another paid submission.
- The previous report is not cleared before replacement succeeds. Earmarked
  live speaker names are reconciled with the full pass. Ambiguous names remain
  optional transcript corrections and never pause processing; any retained summary is marked stale until text-only regeneration
  succeeds. Ordinary summary regeneration and save-only never start paid ASR.
- Browser playback stays lazy, uses the pinned provider/draft audio and revokes
  its local object URL on source change/unmount. Exact saved millisecond offsets
  drive passage playback and highlighting; no waveform or progress is invented.

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

Run the repository's tests, typecheck, production build and emitted PWA checks.
Focused full-pass coverage lives in `tests/processing-retranscription.test.ts`,
`tests/processing-runtime.test.ts`, `src/lib/serverProcessing.test.ts` and the
report/player/dialog tests. Browser acceptance uses synthetic audio and mocked
provider/paid boundaries, not real customer recordings or proof of provider billing.

Deployment follows the current GitHub Actions / Cloud Run flow in `CLAUDE.md`;
reopen the app after deployment so the client uses the current controls.

Earlier evaluation/design history is retained in STREAMING_RESULTS.md,
STREAMING_PROPOSAL.md and TRANSCRIPTION_INCIDENT_2026-09-14.md.
