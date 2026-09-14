# Recording failure and speaker UX — 2026-09-14

## Evidence

The active service is `cheatmeet` in `europe-west2`, project
`gen-lang-client-0187125016`, rather than the older `drive-sync-notes` service.
Revision `cheatmeet-00010-lx8` serves the new AssemblyAI frontend. Both keys are
configured and two live-token requests succeeded at 16:02 Vienna time.

At 16:05 the final-transcription POST returned 502, followed by repeated GET 409s.
Firestore contained the reserved job with no provider ID. The provider job list
contained no new batch submission at that time. An audio-free validation request
reproduced the configuration error: `language_detection` is incompatible with
`language_codes`. Removing the latter reaches the expected missing-audio
validation instead. Synthetic upload-only checks succeeded with both streamed
and buffered bodies; no transcription was requested by those diagnostics.

The saved report retained separate microphone and system speaker IDs. The UI
parsed generic display names back into rows, losing source layout and showing
identical “unknown” labels for known, distinct sources. The live insights effect
also invalidated its own pending response when `thinking` changed. This could
leave it loading indefinitely. The older assistant helper discarded system
speech, although system audio can contain Teams participants.

Some old Gemini segment calls continued after deployment. The fetched current
frontend contains AssemblyAI streaming and no old segment endpoint; this is
consistent with an older tab still running, not evidence that the new capture
loop itself calls both providers.

## Fixes

- Pro batch uses native language detection for multilingual audio. The editable
  German/English list still guides streaming; batch does not claim a hard language
  restriction. See [provider code-switching documentation](https://www.assemblyai.com/docs/pre-recorded-audio/code-switching).
- Upload failures and explicit submission rejections are retryable. Retry claims
  use a Firestore update-time precondition (local files use a lock). Timeouts,
  ambiguous 5xx responses and failed ID checkpointing stay blocked from replay.
- Errors log only stage and status, never credentials, media URLs or provider bodies.
- Structured speaker/source evidence drives live and saved displays. Microphone
  and system badges, opposite chat alignment, source/speaker filters and live
  naming remain available while speaker identities settle.
- Live hint refresh survives transcript updates, serializes requests, retries
  failures and displays the latest suggestion beside the transcript. Both sources
  remain in context; capture device is not treated as proof of background noise.
- Finalization pauses for speaker review or explicit skip before summarization.
  Names are suggested only from repeated distinctive text at matching times;
  independent provider IDs are never assumed to match. Users confirm suggestions.
- Review supports playback, renaming, merging, assigning a contribution to a new
  person and splitting at a text cursor. Splits retain the original time interval
  rather than inventing a precise acoustic boundary. The UI explains that two
  people can be merged into one label and one person can be split across labels.

## Recovery and rollout

With explicit user approval, only the diagnosed reservation was marked retryable
using its exact Firestore update-time precondition. Its original record is backed
up locally under ignored `output/`. No audio was submitted, and no provider result
or Drive artifact was modified. The old deployment will still show the unconfirmed
message until the new code is deployed. After deployment, reopening the report
and choosing analysis can use the unspent final pass and open speaker review.

The user handles AI Studio deployment. Automatic GitHub deployment remains off.
Close older recording tabs after safely finishing them, and reopen the app after
deployment so the browser runs the current client.

## Verification and remaining limits

229 tests in 25 files, typecheck, production build and five PWA checks pass.
Browser checks with synthetic media/mocked providers confirm automatic hints,
source filtering, live names retained on stop, speaker reassignment/splitting,
review/skip controls, audio seeking, and no horizontal overflow at desktop/mobile
widths. This does not establish ASR accuracy or validate every native capture setup.

The durable recording is still mixed audio. Reliable mic/system source evidence
exists in the live data; the final batch result cannot recover an exact source
channel from a mixed recording. Preserving separate durable channels remains an
explicit follow-up. Speaker review makes this limitation visible; it does not
promise correct automatic diarization.


## Follow-up: completed recording and misleading live warning

The 14:39 UTC recording `b075cb3b` (Drive folder
`1xQw5G1KzrlEvTOTo3RGmQQ9wJ7j6STrn`) finished successfully: saved status
`completed`, final transcript, summary, 26 utterances. Cloud Run shows the final
submission accepted (202) and subsequent polling successful (200). This proves
final-job completion, not perfect transcription or absence of live gaps.

The client converted every streaming warning into `failedSegments = 1`, then
presented it as one failed audio section. Worse, the first audio frame flagged a
failure when the *meeting clock* exceeded 500 ms, including normal startup and
resumption. Startup latency now has a separate informational flag measured from
the individual connection request; dropped frames and connection failures retain
an explicit possible-live-gap warning without a fabricated count. The saved
report does not retain enough live diagnostics to identify which warning fired
in this particular session.

The user also called out unresolved voices in their recorded feedback around
0:48. Unknown attribution now states “Stimme nicht zugeordnet”, without promising
ongoing analysis. Missing final-word labels use the documented turn-level fallback;
explicit UNKNOWN/PENDING remains unattributed. Reference:
https://www.assemblyai.com/docs/streaming/label-speakers-and-separate-channels

Live naming now happens on the transcript's speaker name. Source/person filters
remain outside the scrolling transcript, the pane uses more screen space, and
speaker revisions preserve later utterance keys to protect editing focus.

Follow-up verification: 233 tests in 25 files, typecheck, build and five PWA checks
pass. Mocked-provider browser checks at 1440×900, 390×844 and 390×667 cover pinned
filters, source filtering, inline rename/cancel, focus retention during earlier
speaker revisions, neutral unknown labels, and name persistence after stop.
No paid transcription was submitted for this follow-up.
