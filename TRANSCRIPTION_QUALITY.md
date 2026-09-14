# Transcription quality follow-up — 2026-09-14

This incorporates the user's pasted feedback from another ChatGPT conversation.
It began as an investigation plan. The user subsequently approved the scoped
AssemblyAI evaluations documented in STREAMING_RESULTS.md, within USD 5. The user subsequently approved AssemblyAI as the default implementation,
without authorizing deployment. A fresh two-pass test
improved text but did not satisfy consistent automatic speaker identity.

## Evidence and corrections

- Local recordings are under
  `/Users/alexanderkrauck/Library/CloudStorage/GoogleDrive-alexander.krauck@gmail.com/My Drive/CheatMeet Recordings (App)`.
  Each meeting folder carries `aufnahme.webm`, `transkript.md`,
  `zusammenfassung.md` and `bericht_daten.json`. Use these originals read-only
  for diagnosis; keep derived comparisons outside synced originals.
- StackFuel recording: `Meeting 2026-09-14 – e9799bd8-6d7c-4a68-ba99-5df0c8cfaf56`.
  Local ffprobe inspection: Opus, 48 kHz, stereo, duration 1663.498199 seconds.
- Its CheatMeet transcript contains unrelated literature at `[10:11] (Du)` and
  concert discussion at `[12:41] (Du)`. Whether these passages exist in the
  audio has not been independently verified in this review.
- Existing comparison artifacts are in
  `/Users/alexanderkrauck/Coding/Business/transcripts/`:
  `2026-09-14-call-stackfuel-sergio-guerra-abril-retranscribed.assemblyai.json`
  and `2026-09-14-call-stackfuel-sergio-guerra-abril-retranscribed-transcript.md`.
  The raw JSON reports completed transcription, speaker diarization enabled,
  duration 1664 seconds and confidence 0.9654987. The Markdown is manually
  reviewed; comparing it with unedited CheatMeet output would confound provider
  performance with human corrections. Confidence is not measured word accuracy.
- `capture.ts` passes separate mic/system streams to `startLiveTranscription`.
  `audioMerge.ts` mixes them for the durable recording. Therefore duplicate
  stereo channels in the saved file do not establish a live-routing bug.
  Channel correlation and clipping reported in the other chat remain reported
  observations, not measurements repeated here.
- The current checkout contains a silence gate, but the recording's deployed
  application version has not been established. Do not assume it ran this code.

The user's selected immediate priority is finishing audio-source selection and
the sharing explanation. The investigation priorities below follow that work.

## P0 — explain and reproduce the unrelated text

- [ ] Listen to the source intervals around 10:11 and 12:41, including overlap
  margins. Mark what is audible and compare raw AssemblyAI words/utterances and
  CheatMeet text against that same audio. Do not infer silence solely from a
  different recognizer omitting the passage.
- [ ] Establish the deployed build and model settings for the recording.
- [ ] Reproduce with controlled mic-only, silent mic plus remote speech, silent
  shared tab, both sources speaking, pause/resume and backgrounded-tab cases.
- [ ] Add an opt-in diagnostic capture of source identity, segment time bounds,
  gate decision, model/configuration and raw versus stitched text. Avoid storing
  tokens or logging private transcripts by default. Separate retained source
  audio is needed to conclusively localize failures in a future recording.
- [ ] Test quiet, brief speech surrounded by long silence. Current `hasSignal`
  computes RMS over the whole channel, despite comments describing signal at
  any point. Assess a short-window detector without introducing timer sampling.

Acceptance: a reproducible cause and regression coverage that fails before the
fix, plus a real recording with verified speech retained and no invented turns.

## P1 — evaluate provider choice using evidence

- [ ] Start with the existing raw AssemblyAI output; align selected intervals
  against manual reference text before making new API calls.
- [ ] If authorized, benchmark 20–30 selected German, English and mixed-language
  meetings across devices and capture modes. Confirm upload scope and budget.
- [ ] Track word errors, invented/deleted speech, speaker assignment, names and
  technical terms, timestamp accuracy, correction effort, latency and cost.
- [ ] Evaluate the same audio and raw outputs, then separately evaluate each
  complete production pipeline. Keep human edits separate from model output.
- [ ] Choose an optional or primary backend only after setting acceptance
  thresholds; retain a tested fallback with visible failure state.
- [ ] Evaluate AssemblyAI streaming as requested: partial versus final results,
  German/English support, source/session handling, reconnects, background tabs,
  latency, cost and whether a final diarization pass is still needed. Verify
  current official capabilities before choosing an architecture. Keep any
  long-lived provider credential server-side.

No AssemblyAI integration or new vendor dependency is implied by this plan.
Check current official API documentation, retention options and pricing at
implementation time. The existing later Gemini diarization plan is a candidate,
not a committed provider choice.

## P1 — capture and durable audio

- [x] Validate the source selector with synthetic browser streams and unit tests:
  mic-only must never open screen
  sharing; the explainer must precede sharing; cancellation and lack of audio
  must produce accurate messages. Missing audio does not prove an unchecked box;
  platform support can also be responsible.
- [ ] Run a real-device smoke test of the native picker on target browsers.
- [ ] Compare storing independent source audio with keeping a single mix and
  using diarization for final retranscription. Include upload/storage costs,
  pause alignment, resumable writes and account-change safety.
- [ ] If channel-based transcription is introduced, validate actual channel
  separation first. Channel count alone cannot establish separate speakers.
- [ ] Measure channel correlation, sample peaks and true peaks before deciding
  on mono output, gain changes or limiting. A -1 dBTP ceiling was suggested in
  the other chat; it is not an established fix for the transcription problem.

## P2 — make transcript quality visible

- [ ] Preserve precise timing where the provider supplies it and allow seeking
  from transcript turns to the corresponding audio. Do not invent word timings
  from today's segment-start timestamps.
- [ ] Show missing/failed segments and review-needed spans before a polished
  summary obscures transcript problems. Keep provider confidence distinct from
  a validated quality score.
- [ ] Evaluate a user-supplied glossary for names and technical terms; corrections
  should preserve raw evidence and not silently rewrite uncertain facts.
- [ ] Flag suspicious simultaneous passages for review using audio evidence;
  semantic differences alone are not proof of an error.
- [ ] Link consequential claims such as rates, deadlines and commitments to
  source intervals so users can verify them directly.

## User decisions

- Confirmed: finish capture UX first.
- Confirmed transcription requirements: useful live text and a high-quality final
  transcript; a slight delay is acceptable. Invented passages are the primary
  failure to prevent. Uncertainty must remain visible rather than be filled in.
- At most two transcription passes over any audio portion. Account for overlap
  and retries when evaluating streaming plus a final pass; the current overlapping
  segment approach plus a full final pass may exceed this limit at boundaries.
  This is a design constraint, not a guarantee that an ASR provider never errs.
- Required capture scenarios: one person on microphone only; one microphone
  speaker plus multiple Teams participants; multiple in-room microphone speakers
  without Teams; multiple in-room speakers plus multiple Teams participants.
  All need segmentation. Source identity must not be equated with person identity;
  current `Du`/`Andere` labels cannot represent these scenarios accurately.
- Prefer a single live transcript that becomes final. If a final pass is needed,
  replace the live version automatically and generate the summary only from the
  final transcript. Do not require a user approval step for this replacement.
- Segmentation means timestamped turns for individual people, with consistent
  anonymous labels and editable names. Separate per-person audio playback is
  not required by this request.
- Individual speaker identification is desirable live; final speaker accuracy
  takes priority if live identification is not technically reliable.
- Teams support must not depend on the user's current desktop/browser setup.
  Investigate and document platform capture limitations and supported paths;
  do not silently narrow the requirement to one browser or OS.
- Confirmed after streaming evaluation: default expected languages to German and
  English, editable per meeting. Test guidance on unused source audio before
  implementation; unrestricted detection produced wrong-language renderings.
- AssemblyAI streaming is an option to think through, not an approved integration.
- Approved evaluation: stream the existing StackFuel recording and synthetic audio
  to AssemblyAI, capped at USD 5. Start with nonoverlapping source excerpts
  09:00–14:00 and 25:00–27:43 plus 30 seconds of synthetic non-speech. No approval
  to upload other recordings or change the production transcription provider.
- Pending only if the architecture requires it: whether preserving separate
  raw sources is worth additional storage. Platform coverage is a requirement,
  not an outstanding request for the user to select one preferred platform.
