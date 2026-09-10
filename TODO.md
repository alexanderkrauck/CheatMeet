# CheatMeet backlog

Derived from the first real end-to-end run: `Meeting 2026-09-10 – 0daa78f1`
(2:58.9 of audio, 4 segments, live transcript + report + Drive export).

The previous contents of this file were the upstream BauDoku project's
completed checklist; it is preserved in git history.

## Verified working in that run

- Segment boundaries landed at exactly 0 / 60 / 110 / 160 s (`[0:00] [1:00]
  [1:50] [2:40]`), i.e. 60 s segments advancing 50 s. The tick-driven scheduler
  behaves as designed in a real browser.
- `durationMs` 178910 ms vs. decoded audio 178.859 s — the recording clock is
  accurate to ~50 ms.
- Drive export wrote audio, `bericht_daten.json`, `transkript.md` and
  `zusammenfassung.md`, with all file IDs and `driveSyncedAt` recorded.
- The report correctly extracted the spoken intent into German to-dos and
  takeaways.

## 1. Separate microphone and system audio — highest value

Today `mergeAudioStreams` mixes both into one track, so one transcript
interleaves music with speech and loses speech under the music. In the sample,
segment `[1:00]` is cut off mid-sentence at "Damit das in zwei getrennte
Streams" and `[1:50]` contains no speech at all — it was drowned by the song.

- [ ] Run a second segmented capture over the microphone stream alone, and keep
      the mixed stream only for the durable Drive recording.
- [ ] Transcribe the two sources independently and label them in the transcript
      (e.g. `[1:00] (Du) …` / `[1:00] (Andere) …`) instead of interleaving.
- [ ] Feed only the speech sources to `/api/insights` and `/api/ask`; song
      lyrics are noise for both.
- [ ] Decide what happens when only system audio is shared (call with no local
      speaker) so the labelling still reads sensibly.

## 2. The recording has no duration in its container

`ffprobe` reports `duration=N/A`; the file decodes to 2:58.859 but nothing can
seek it. MediaRecorder never writes the EBML `Duration` element. Consequences:
Drive's preview and any player cannot scrub, and `<audio>` reports `Infinity`,
which also affects the in-app review player.

- [ ] Patch the WebM header before upload (write `Duration` into Segment Info),
      or remux, so the stored file is seekable.
- [ ] Until then, drive the review player's duration from `report.durationMs`
      rather than from the media element.
- [ ] Investigate the two `Error parsing Opus packet header` warnings ffmpeg
      emits for this file.

## 3. Repetition inside a single segment

Segment `[1:50]` contains the same three sentences twice, and `[1:00]` repeats
"Ooh. It's black and white." and "No more.". This is within one segment, so it
is not the overlap glue — it is either a genuine repeated chorus or the model
looping. Gemini 3's own guidance warns that looping is the failure mode when
sampling is constrained.

- [ ] Verify against the raw audio whether the repetition is real.
- [ ] If it is looping: log the raw segment transcript alongside the glued
      continuation so the two can be told apart in future runs.
- [ ] Consider dropping a continuation that is an exact repeat of the text
      immediately before it.

## 4. Transcript coverage looks thin

1587 characters for 179 s of audio. Some of that is genuinely music, but the
missing speech in §1 suggests real loss.

- [ ] After §1 lands, re-measure characters per minute of speech on a
      speech-only recording to get a baseline.
- [ ] Surface `failedSegments` in the review screen rather than only as a
      warning, so a gap is visible before the report is generated.

## 5. Report polish

- [ ] `reportToMarkdown` escapes the ISO date into `2026\-09\-10T15:20:35\.868Z`.
      Format it as a readable date instead of escaping the raw string.
- [ ] A typed project name overrides the generated title (`title: "gaw"`).
      Decide whether the AI title should win, or be offered as a suggestion.

## 6. Still unverified end to end

- [ ] `/api/ask` and `/api/insights` have never run against live Gemini — only
      against mocked clients and a stubbed browser mount.
- [ ] The dashboard redesign (hero action, draft cards, transcript search with
      snippets) has not been seen signed-in; only typecheck and build cover it.
- [ ] Re-enable the Cloud Run deploy job in `.github/workflows/ci.yml` once the
      above has been exercised against the live project.
