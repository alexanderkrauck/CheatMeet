## Single-person audio sources (2026-09-14)

- [x] Independent per-meeting microphone/system single-person checkboxes; default off.
- [x] Stable, separate source identities across pauses and reconnects; inline names retained.
- [x] Preserve automatic speaker separation on sources without the setting.

# CheatMeet backlog

Maintained from real recordings. Each item says what was observed and where, so
it can be picked up without re-deriving the context.

## Current decision — live transcript only (2026-09-14)

This supersedes all earlier final-batch and automatic matching plans below.

- [x] Use recorded meetings' live transcript directly for saving and summaries.
- [x] Preserve maintained names and mic/system identities; ignore the provider's
      global closing relabeling and retain visible unconfirmed trailing text.
- [x] Remove mandatory completion review and promises of a later transcription.
- [x] Never retranscribe a recording automatically, including empty/failed live
      capture. Keep its original audio and show the limitation explicitly.
- [x] Retain one initial batch transcription for imported files only; reject the
      retired second-pass POST endpoint so old clients cannot start another job.
- [ ] User deploys in AI Studio, reloads, and checks a fresh recording.

## Historical decisions and completed work

The following items describe earlier iterations. Their final-batch/reconciliation
plans are no longer the current product behavior.

## Final speaker continuity — 2026-09-14 late afternoon

- [x] Automatically carry maintained live names and source metadata into final
      utterances using text overlap and matching times. Accept a single long
      match, reconcile batch splits, and separate merged labels where each
      final utterance has clear independent evidence.
- [x] Preserve the user-maintained reference locally before provider termination
      revisions; retain the complete live name/source roster in the final report.
- [x] Pause only for unresolved groups. Offer one person selector, listen/keep,
      skip, and collapsed advanced corrections; fully matched results proceed
      straight to the final-text summary.
- [x] Use the live conversation layout, source/person filters, search and inline
      names in the final view. Legacy stored name suggestions remain readable.
- [ ] User deploys through AI Studio and validates a fresh named recording.
- [ ] Historical report `ad21260a` retains only the `Fireship` name suggestion in
      the synced final JSON. Its complete live names/source mapping could not be
      recovered: the Drive connector cannot read that JSON revision. No original
      recording was resubmitted or historical Drive file modified.

## Live transcript usability — 2026-09-14 follow-up

Recording `b075cb3b` in Drive folder `1xQw5G1KzrlEvTOTo3RGmQQ9wJ7j6STrn`
completed with final transcript and summary. The user's recorded feedback near
0:48 also calls out unresolved speaker labels; treat it as product feedback.

- [x] Remove the invented failed-section count: AssemblyAI exposes a warning
      flag, not a count of failed sections. Distinguish slow startup from dropped
      live frames; a quick resume must not count total meeting time as latency.
- [x] Rename known speakers directly at their live transcript name. Keep focus
      stable during new turns/revisions, support Enter/blur to save and Escape
      to cancel, and retain names when stopping.
- [x] Enlarge the live transcript, keep source/person filters outside its scroll
      area, and use a compact person selector that does not grow with speakers.
- [x] Replace indefinite “Stimme wird zugeordnet” with “Stimme nicht zugeordnet”.
      Use the provider's documented turn-level label when a final word omits its
      label; preserve explicit UNKNOWN/PENDING without inventing identities.
- [ ] Deploy these follow-up fixes through AI Studio and check a fresh recording.
- [ ] Preserve durable mic/system channels (see below). The new final recording
      still combines German microphone speech and English playback in some
      speaker groups; changing display names cannot restore source separation.

## Production feedback — 2026-09-14 afternoon

- [x] Inspect Cloud Run logs and the saved report; reproduce the batch parameter rejection without audio submission.
- [x] Fix mutually exclusive batch language parameters and distinguish confirmed rejection from an uncertain accepted submission.
- [x] Reconcile only the diagnosed stuck reservation as retryable with user approval; no audio submitted.
- [x] Preserve visible microphone/system source labels, including unknown live identities; add source/speaker filters and live naming.
- [x] Fix live hint requests being invalidated by React updates; keep remote meeting speech in assistant context and display the newest hint prominently.
- [x] Pause for final speaker review before summary, with an explicit skip. Support naming, merging, reassignment, splitting, and playback.
- [x] Suggest live-entered names using repeated matching passages; require confirmation and decline ambiguous/merged/split matches.
- [x] User deployed the incident fixes; the previously stuck report is now completed in Drive.
- [ ] Preserve separate durable audio channels for reliable source attribution in the final batch pass. Existing mixed recordings cannot regain an exact channel split.

See [incident details](TRANSCRIPTION_INCIDENT_2026-09-14.md).

## Current follow-up — 2026-09-14 transcription feedback

The current implementation and rollout checkpoint are in
[ASSEMBLYAI_IMPLEMENTATION.md](ASSEMBLYAI_IMPLEMENTATION.md). AssemblyAI is the
approved default, with live streaming and one final batch pass. The
[paid evaluation](STREAMING_RESULTS.md) informed this choice; production rollout
is still pending. [STREAMING_PROPOSAL.md](STREAMING_PROPOSAL.md) preserves the
earlier research and tradeoffs.

- [x] Run the approved StackFuel/synthetic streaming evaluation: approximately
      USD 0.078 estimated total; raw events preserved locally. No long unrelated
      passages in the selected real intervals; no output for synthetic non-speech.
- [x] Decide expected-language defaults: German + English, editable per meeting.
- [x] Implement the approved per-meeting language selector.
- [x] Evaluate guidance on unused real audio and synthetic bilingual speech.
      Cumulative estimated spend USD 0.117. Pro preserved content/speakers better
      than the cheaper streaming model, but added words in the controlled sample.
- [x] Evaluate streaming + one independent final batch pass on fresh synthetic
      audio. Final batch removed added phrases but introduced one name error;
      live merged two speakers and batch split one speaker. Cumulative estimated
      spend USD 0.135 of USD 5. Exact evidence in STREAMING_RESULTS.md.
- [x] Review whether more generic synthetic testing is useful: stop here.
      It does not train the provider; the short-turn fixture is a stress case.
      Further tests must resolve a concrete implementation/configuration decision.
- [x] User decision: AssemblyAI should be the default, with no opt-in switch.
- [x] Implement separate live streams, one final batch pass, final-text-only
      summaries, per-meeting languages and editable/mergeable final speakers.
      See ASSEMBLYAI_IMPLEMENTATION.md for behavior and verification: 216 tests,
      typecheck, build, PWA/deploy checks and synthetic browser checks pass.
- [x] Persist final-job reservations across concurrent requests and restarts;
      reconnect live sessions using future audio only, without replay.
- [x] Avoid Cloud Run's browser upload limit by streaming the saved Drive audio
      through the server to AssemblyAI for final transcription.
- [ ] Configure the server secret, verify runtime job-store permissions and
      provider retention, and run a scoped native/real-provider smoke test.
      Initial AI Studio deployment is complete; follow-up fixes await the user’s next deployment.
- [ ] Validate three or more recurring speakers, overlap and cross-source echo.
      Do not replay the existing synthetic sample; its two submissions are spent.

See [TRANSCRIPTION_QUALITY.md](TRANSCRIPTION_QUALITY.md) for evidence, open
questions, and acceptance criteria from the StackFuel recording and the other
ChatGPT conversation. Capture UX was completed first, followed by the default
AssemblyAI implementation. Older diarization proposals below are historical;
the implementation document describes the current behavior.

- [x] Verify the asynchronous gate ordering test fails with concurrent checks,
      even when `finish()` waits for both checks. Restored the ordered chain.
- [x] Add regression coverage: a rejected silence check sends that segment and
      does not prevent later segments from being transcribed, including across
      pause/resume. Full suite: 186 tests; typecheck, build, 5 PWA tests and
      9 deployment-config tests passed locally on 2026-09-14.
- [ ] Trace the unrelated StackFuel passages back to the corresponding audio
      intervals and identify the deployed build used for that recording.
- [ ] Check silence gating against brief, quiet speech within long segments;
      whole-segment RMS can dilute speech below the current threshold.
- [ ] Preserve source/build/model metadata and diagnostic evidence sufficient
      to distinguish captured audio from transcription and stitching errors.
- [ ] Compare the existing raw AssemblyAI result with CheatMeet and manually
      checked audio intervals; decide on a broader benchmark before integration.
- [x] Finish the audio-source selector and pre-sharing explanation. Unit coverage
      includes cancelled sharing and unsupported/missing audio; browser checks
      use synthetic streams and verify choice persistence, request order, the
      mic-only alternative, keyboard behavior and desktop/mobile layout.
- [ ] Smoke-test native sharing with real devices on target browsers; automated
      UI checks substitute media devices and do not validate the OS picker.
- [ ] Decide whether durable recordings should preserve separate sources or
      remain a mix for later diarization; see the tradeoffs in the linked plan.


## Verified in production

From the 2026-09-11 runs (`be064b14`, 5:25, and `c02db430`, 2:54):

- **Microphone and system audio stay separate.** 6 `(Du)` and 7 `(Andere)`
  segments, German speech and an English video cleanly split.
- **The WebM duration patch works on a real upload:** `duration=325.245600`
  where every earlier recording reported `N/A`. Stored files are seekable.
- **The capture store survives the full flow** — a 5:25 meeting recorded,
  transcribed, analysed and exported.
- **Finishing mid-segment still transcribes to the end.** Recording ended at
  5:25, the last transcribed segment is `[5:10]` for both sources.
- **Bilingual German/English transcription works** without switching hints.
- ~~A source that was silent for a whole segment is correctly dropped rather
  than emitting an empty turn.~~ **Disproven by `3b7c8f25` — see §10.** It held
  for that one recording; it is not a property of the system.

Earlier, from `0daa78f1`: segment boundaries land at exactly 0/60/110/160 s, the
recording clock is accurate to ~50 ms, and `Error parsing Opus packet header` is
benign — it is the final packet of a stream stopped mid-flight, remuxing does
not remove it, and the decoded PCM is checksum-identical.

---

## Must have

### 1. Drive authorization must never expire

Today the user is re-prompted to reconnect Drive during normal use. This is not
a bug in our code: **Firebase's Google sign-in hands the client an access token
(~1 h) and never a refresh token**, so there is nothing to renew with and the
only recovery is a popup. The product requires Drive, so signed in must imply
Drive-authorized, and losing Drive must mean being signed out.

Chosen approach — server-held refresh token, client keeps uploading directly:

- [x] Add a server-side authorization-code flow (`access_type=offline`,
      `prompt=consent`, scope `drive.file openid email profile`) with a
      `/api/auth/google/callback` endpoint. Needs the OAuth **client secret**
      deployed as a Cloud Run secret; only `oAuthClientId` exists today.
- [x] Exchange the code server-side, store the refresh token per user, and
      return the Google `id_token` so the client can call
      `signInWithCredential` — one consent screen, not two.
- [x] Add `POST /api/drive-token`: given a valid Firebase ID token, mint a fresh
      access token from the stored refresh token. The client caches it in memory
      until shortly before expiry. `sessionStorage` and the popup path go away.
- [x] Added `ensureDriveToken()` alongside the synchronous `driveToken()`
      rather than making it async: render paths read the cache directly, and
      only the callers that need a guaranteed-fresh token await.
- [x] On `invalid_grant` (consent revoked, long inactivity) return a distinct
      401 and sign the user out with an explicit message.
- [x] Keep audio uploading straight from the browser to Drive. Do **not** proxy
      media through Cloud Run.

Consequences to accept before starting:

- **The backend stops being stateless.** It currently verifies ID tokens with
  `jose` against Google's JWKS and stores nothing, deliberately avoiding the
  Admin SDK. Refresh tokens need a per-user store, realistically Firestore via
  the Cloud Run service account.
- **The security posture changes.** Today a compromised server cannot reach any
  user's Drive; the token lives only in the user's tab for under an hour.
  Afterwards the server holds long-lived credentials for every user. The
  `drive.file` scope limits the blast radius to files this app created — keep it
  that way, never widen it, never log tokens.
- Requiring authorization *before* recording starts is correct, but a network
  drop mid-meeting must not abort a recording. Local journalling and later
  upload is resilience, not a "works without Drive" mode — keep it.

### 2. Report and transcript design pass — correctness

- [x] The finished transcript renders through the shared `TranscriptChat`
      component instead of one raw `<p>`.
- [x] Summary, to-dos and takeaways restyled; body copy moved off brand blue.
- [x] Fixed in review: a legacy `.transcript p` rule overriding every bubble
      property, a primary CTA at 3.68:1, a footer at 3.83:1, mic bubbles
      printing white-on-white, hover-gated timestamps, a mobile width cap lost
      to source order, and 43px tap targets.
- [x] Back navigation moved to a breadcrumb; "In Drive speichern" hidden once
      the report is actually in Drive.

### 2b. Report screen: second design pass — done

Composition, not correctness. Delivered to the principle below, and the app
header stopped being a logo shelf: it now carries global search across meetings
and transcripts, the one action that starts a meeting, and an account menu.

Design against this principle: **compact report header → concise intelligence
overview → transcript as the dominant workspace.**

- [x] Shrink the header. A multi-line 44px title eats the first screen to tell
      the user what they just opened. Content should start much higher.
- [x] Stop giving every section the same full-width card. Summary, tasks,
      insights and transcript share one treatment, which flattens hierarchy.
      The transcript is the primary artifact; the rest is secondary.
- [x] Put `Aufgaben` and `Wichtigste Erkenntnisse` side by side, or into one
      compact intelligence region. Today they are two tall cards holding two
      lines each, so the page is long without being informative.
- [x] Reconsider the chat metaphor **for the finished report**. Large left/right
      bubbles waste horizontal space and make scanning harder when reading
      rather than following live; a timeline/speaker layout is likely stronger.
      Keep the chat view on the live recording screen — it was asked for there
      and it works, because following along is a different task from scanning.
- [x] Unify the action row. `Bearbeiten / PDF / .md` on the left and Drive on
      the far right read as two unrelated islands. One clear primary action plus
      a compact export/share group.
- [x] Demote status. "Bericht erstellt" and "In Drive gespeichert" are two green
      success states occupying prime space for low-priority information.
- [x] Use the gradient more selectively. It gives the app personality but makes
      a report feel less serious, and slightly like an AI landing page.
- [x] Differentiate the cards semantically. A summary, a checklist, an insight
      list and a transcript should not behave identically.
- [x] Decide the focal workflow. Read the summary, edit, work the tasks, or go
      through the transcript? One should be obviously primary.
- [x] Design the transcript region for the interactions it should support even
      before they exist: scanning, speaker identity, timestamps, search,
      jump-to-audio, copy, highlight.

---

## From the 2026-09-11 source-selection recording (`3b7c8f25`)

The microphone half of that transcript is accurate; the user confirmed it. The
system half is entirely invented, which is what §10 is about.

### 10. Silence is transcribed as invented speech — data-integrity bug

**This is the most serious bug in the backlog.** In `3b7c8f25` the shared tab
carried an audio track that was playing nothing. Every system-audio segment was
therefore digital silence, and the model returned fluent, confident German
prose for it: a lecturer explaining why the slides are in German, a report on
the 2013 Bundestag election with six party percentages to one decimal, and VfL
Osnabrück's mid-season league position. None of it happened. The user says so on
the recording — *"es nützt wirklich kein Audio von anderen. Ich höre überhaupt
nichts, da ist nichts"* — and the audio agrees: between 0:30 and 0:46 the mixed
file sits at −50 to −54 dBFS, the noise floor, while the system track claims
continuous speech across that whole stretch.

It did not stop at the transcript. The summary states as fact that the tool
recorded a lecture and football statistics, and a fabricated to-do
(*"Fehleranalyse durchführen, um zu klären, warum aktuell ungewollt Systemaudio
aufgezeichnet wird"*) was written into `zusammenfassung.md` and exported to
Drive. An invented transcript becomes an invented record of a meeting. Three
unrelated encyclopedic topics arriving inside two minutes is the classic
signature of an ASR model fed near-silence.

- [x] **Gate segments on measured audio energy before uploading.**
      `src/lib/audioEnergy.ts`: `segmentHasSignal()` decodes each segment's own
      recorded audio (not a live analyser sampled on a timer — a backgrounded
      tab throttles `setInterval` to once a minute, exactly what
      `segmentCapture.ts` already works around for segment boundaries) and
      checks its real PCM. `liveTranscription.ts` chains the check ahead of
      `assembler.push()` per source, so a segment that never rises above the
      noise floor is never sent at all.
- [x] Threshold: `SILENCE_DBFS = -48`, stated and justified in code against
      `3b7c8f25`'s measured levels (real silence -50 to -61 dBFS, real speech
      never below -44). Derived from one recording/device/browser; documented
      as failing open if a different setup's noise floor sits above it, rather
      than risk cutting real speech.
- [x] Added to the `/transcribe-segment` prompt as a second line of defence —
      return nothing when there is no intelligible speech.
- [x] Unit-tested against real PCM cut from `3b7c8f25` with ffmpeg
      (`tests/fixtures/real-silence.f32le`, `real-speech.f32le`), not only
      synthesised buffers — the browser's `decodeAudioData` container/codec
      layer itself is still outside what a Node test process can exercise;
      only the classification decision made from decoded samples is verified
      against real bytes.
- [x] Single-source fallback verified by a real test
      (`liveTranscription.test.ts`): a source gated out for the whole session
      never contributes an entry, so `toTimestamped()` already drops its label
      rather than asserting a split that never existed.
- [x] A first version of this fix used a live per-source analyser correlated
      to each segment via a wall-clock FIFO queue. Two review rounds found it
      unsound: the correlation silently desynced across pause/resume (an
      ordinary user action), and the analyser's own `setInterval` sampling hit
      the identical backgrounding throttle the fix exists to route around —
      both defeated the gate with no error or log to reveal it. Replaced with
      the per-segment decode above, which needs neither a timer nor a
      correlation step.

### 11. Choose the audio sources before recording starts

Previously `startCapture` always requested screen sharing when available.
Microphone-only now skips that request, and the last choice is remembered locally.

- [x] Offer the choice up front: microphone only, or microphone plus system
      audio. Remember the last choice.
- [x] Microphone-only must skip `getDisplayMedia` entirely rather than calling
      it and discarding the result.

### 12. Explain the screen-share prompt before it appears

Previously the explanation appeared as a busy message during the native dialog.
A dismissible sheet now explains sharing before capture starts, with a direct
microphone-only alternative.

- [x] Show the explainer *before* calling `getDisplayMedia`: what the browser is
      about to ask, that the tab or screen must be picked, and above all that
      **"Audio teilen" must be enabled when offered** to include system audio.
- [x] Keep the existing post-hoc warning for a share that arrives without an
      audio track, but make it say what to do differently next time.

---

## From the 2026-09-11 feedback recording (`c02db430`)

### 3. A single-channel recording must not be labelled "Du"

On the phone there is no system audio, so everything is one channel. Labelling
every turn `(Du)` is wrong and implies a speaker separation that does not exist.

- [x] When only the microphone is captured, drop the speaker label (or use a
      neutral one) rather than asserting `(Du)`.
- [x] `parseTranscript` keeps rendering older two-source transcripts.

### 4. The pause button sits off-centre

Confirmed: `.walk-capture-controls` is a flex row that used to hold two buttons.
Since the photo button was removed the single 78 px `.walk-pause` sits hard
left.

- [x] Centred and sized to match the finish action.

### 5. The PWA icon is still BauDoku

Confirmed: `public/icons/icon-192.png`, `icon-512.png` and
`apple-touch-icon.png` are the old dark-green house. `icon.svg` was updated to
the CheatMeet waveform, but the manifest references only the PNGs.

- [x] Replaced by the CheatMeet logo at 192, 512, apple-touch and favicon
      sizes. The waveform `icon.svg` is gone; the favicon is a PNG now.
- [ ] Verify on a device: the service worker precaches these paths, so the PWA
      has to be reinstalled before the new icon shows.

### 6. Absolute timestamps alongside relative ones

- [x] Each turn shows the wall clock beside its offset ("1:40 · 12:02"),
      derived from `report.date` rather than stored, so no schema change.

---

## Research and ideas

### 7. Proactive assistant (explicitly a nice-to-have) — done

- [x] `/api/insights` returns up to three `prompts`: concrete things to raise or
      clarify next. Shown first on the live surface and echoed in the recording
      bar. It rides along with the existing insights call rather than adding a
      second one, since this was a nice-to-have.

### 8. Speaker diarization — researched, recommend adopting for the mic source

`gemini-3.5-transcribe` is a dedicated speech-to-text model with **speaker
diarization built in**: up to 8 speakers (3+ flagged experimental), word-level
timestamps, 85+ languages including `de-DE`.

What this means for us:

- **It fits our design.** Diarization is unsupported on the *live streaming*
  endpoint but works on the unary one, and our 60 s segments are already unary
  calls. The 30-minute cap with diarization enabled is far above a segment.
- **It solves the case the feedback recording raised.** The two-source split
  already separates you from everything through the speakers. Diarization adds
  what that cannot: several people in one room on a phone, and several remote
  participants inside one system-audio stream.
- **The hard part is identity across segments, not diarization itself.**
  Nothing guarantees that "Speaker 1" in one segment is "Speaker 1" in the next.
  Our segments overlap by 10 s, so the glue step is the natural place to carry
  labels forward — but that has to be built, and it is where this would fail.
- Diarization is incompatible with custom vocabulary, which we do not use.

- [x] Decided: adopt it, but **not per segment**. Doing it per segment is what
      creates the cross-segment identity problem in the first place. §9 runs it
      once over the finished recording instead, where the problem does not
      exist. Streaming was ruled out at the same time: `gemini-3.5-transcribe-live`
      supports no diarization at all, so on Gemini it is streaming *or*
      speakers, never both.
- [x] Cost measured: ~$0.005/min blended, one call per meeting. See §9.

---

## 9. Diarization: one labelled pass over the finished recording

**Status: plan awaiting review. Nothing here is implemented.**

### The decision

Keep the 60 s segmented pipeline exactly as it is — it is verified in
production and it is what makes the live transcript live. Add *one*
`gemini-3.5-transcribe` call over the finished recording, with diarization on,
and let its output become the transcript the report shows. There is no
cross-segment identity problem because there are no segments: one call sees the
whole meeting and labels it coherently.

Rejected alternatives, with the reason:

- **`gemini-3.5-transcribe-live`** — no diarization on the Live API at all, 10
  min session cap, ~1.8x the price. It would lose the feature we want it for.
- **AssemblyAI streaming** (`speaker_labels: true`, German supported, ~307 ms,
  $0.15 + $0.12/hr) — genuinely does live diarization, but their docs say a
  streaming label is final once assigned, and it means a second vendor, a second
  key, and our audio going somewhere other than Google. Revisit only if live
  speaker labels become a requirement.

### The constraint that shapes this

**`aufnahme.webm` is the *mixed* stream.** `mergeAudioStreams()` feeds the main
recorder mic + system audio combined, while live transcription runs a separate
segmented recorder per source. So a diarized pass over the stored file would
throw away the mic/system split — which is a *hard* split from two separate
device streams and far more trustworthy than any model's guess.

But `mergeAudioStreams()` returns the microphone stream unchanged when there is
no system audio. So on a phone — exactly the case the feedback recording raised
— the stored file **is** pure microphone, and diarizing it is exactly right with
no reconciliation needed.

Hence the gate: **diarize only when the recording had a single source.**
§11 makes that case explicit and common rather than incidental, so it should
land first — it also supplies the `sources` field §9 needs in step 3.

### Scope

In: single-source recordings, up to the 30 min diarization cap.
Out, deliberately:

- **The system-audio side.** Several remote participants inside one system
  stream is a real case, but reaching it needs a second full-length recorder
  running for the whole meeting (double memory, double journalling, double
  upload). That is a separate decision, not a detail of this one.
- **Recordings over 30 min.** The cap is Google's, and it applies whenever
  diarization or timestamps are on. Past it, keep the assembled transcript and
  say so rather than labelling half a meeting.
- **Renaming speakers.** Output is `Sprecher 1..N`; nothing tells the model
  which one is the user. The report's edit mode already allows a manual rename.
- **Live speaker labels.** Not reachable on Gemini at all (see above).

### Step 0 — spike first, build nothing until it passes

- [ ] Call `ai.interactions.create` against the real 178 s `aufnahme.webm` and
      **write the raw response to a fixture file.** This is a different API
      surface from everything we use today (`interactions`, not
      `models.generateContent`), and the response shape must be observed, not
      assumed. `@google/genai` 2.21.0 already types it:
      `generation_config.transcription_config.mode = { type: "verbatim",
      diarization_mode: "speaker", timestamp_granularities: ["word"] }`,
      returning `word_info` annotations (`text`, `speaker: "spk_1"`,
      `start_offset: "0.100s"`). `output_text` carries the plain text; the
      annotations hang off a `TextContent.annotations` array whose exact path
      through `steps` needs confirming against a real response.
- [ ] Measure on that call: wall-clock latency, billed tokens, German quality.
      **Extrapolate the latency to 30 min and compare against the Cloud Run
      request timeout** (default 300 s). If 30 min of audio cannot finish inside
      it, this design needs a polling endpoint instead of one request, which is
      a much larger change — find that out now, not after building.
- [ ] Compare the result against the existing assembled transcript for the same
      recording. Word-level timestamps are documented to *degrade* transcription
      accuracy, and timestamps only support `"word"` granularity, so there is no
      cheaper setting to fall back to. If the diarized text is materially worse
      than what we already produce, the whole idea is off — labels are not worth
      a worse transcript.

### Step 1 — `shared/diarization.ts` (pure, isomorphic, tested directly)

- [ ] `parseOffset("1.234s") -> ms`.
- [ ] `groupWords(words) -> TranscriptEntry[]`: start a new turn on a speaker
      change or a silence gap over ~2 s, so a monologue still breaks into
      readable turns; map `spk_1` -> `Sprecher 1`.
- [ ] Render through the existing `toTimestamped()` so the storage format stays
      one format, not two.
- [ ] Unit-test against the Step 0 fixture — the real recorded response, not a
      hand-written echo of the function's own logic.

### Step 2 — `POST /api/diarize`

- [ ] Reuse the existing machinery wholesale: `receive()`, `requireAudio()`,
      `uploadMedia()`, `withRetry()`, and the `finally` that deletes both the
      remote Gemini file and the multer temp file on every path.
- [ ] Take the per-user concurrency slot, like `/analyze` — this is an expensive
      call and one per user at a time is the right limit.
- [ ] `GEMINI_TRANSCRIBE_MODEL`, defaulting to `gemini-3.5-transcribe`. Its own
      longer client timeout; the 180 s default is for segments.
- [ ] Return `{ transcript, speakers }` already in our storage format, so the
      client never sees `spk_1`.
- [ ] Tests with a fake client replaying the Step 0 fixture.

### Step 3 — pipeline

- [ ] Record the capture sources on the report (`sources?: TranscriptSource[]`,
      written in `capture.ts`). The Firestore report rules use `get()` with
      defaults and do not restrict keys, so this needs **no rules change** —
      unlike the settings documents.
- [ ] New `"diarizing"` stage in `pipeline.ts`, between `uploading` and
      `analyzing`: the audio is already safe in Drive, and `/analyze` should
      summarise the better transcript rather than pay to summarise twice.
- [ ] Eligible = exactly one source, audio present, `durationMs` inside the cap.
- [ ] **Failure must never fail the job.** Log it, keep the assembled
      transcript, carry on to analysis. This is an enhancement, not a
      dependency.

### Step 4 — display

- [ ] `parseTranscript` keeps `source` for mic/system styling but also returns
      the raw `label`, which it currently discards for anything that is not
      `Du`/`Andere` — today a `(Sprecher 2)` line would silently lose its chip.
- [ ] `TranscriptTimeline` renders a chip for any label, coloured from a small
      palette by stable index. Contrast-checked, and checked in print.
- [ ] `speechOnly()` must keep dropping only `Andere` — a diarized transcript is
      single-source, so every one of its turns is speech and none may be
      filtered out of the assistant's context.

### Step 5 — validate

- [ ] Unit tests green; visual validation of a 3-speaker timeline by subagent.
- [ ] One real two-person in-room recording on the phone, end to end, compared
      against what the assembled transcript produced for the same audio.

### What this costs

~$0.005/min blended, once per meeting: about **$0.15 for a 30 min meeting**.
That roughly doubles the transcription spend of a meeting, since the segment
calls still run. There is no on/off switch in the plan — adding one would mean a
`settings/preferences` key and therefore a Firestore rules change and deploy.

---

## Carried over

All of this section's original items are done. What remains needs a live
account, a device, or a decision — not code.

- [x] `speechOnly()` drops system-audio turns before either assistant call,
      keeping timestamps and leaving single-source recordings untouched.
- [x] The newest proactive suggestion now shows in the recording bar.
- [x] The review player states the real length when the container reports
      `Infinity`, rather than showing a broken control.
- [ ] Re-measure transcript characters per minute on a speech-only recording to
      get a coverage baseline.
- [x] A continuation longer than its source segment is logged — the signature
      of a looping model rather than repetition in the audio.
- [ ] `/api/ask` and `/api/insights` have still never run against live Gemini.
- [ ] Re-enable the Cloud Run deploy job in `.github/workflows/ci.yml` once the
      above has been exercised against the live project.
