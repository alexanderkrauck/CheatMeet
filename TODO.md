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

## 1. Recording must not take over the app

Starting a meeting currently locks you out of everything else: the capture
screen is `position: fixed; inset: 0` with the back button disabled while
recording. Worse, the session lives in `RecordPage`'s refs, so navigating away
would not merely hide the UI — it would stop the recording.

- [x] Move the recording session into a module-level store, the way
      `src/lib/pipeline.ts` already owns save/analyse/export: the MediaRecorder,
      the source streams, `RecordingClock`, `LiveTranscription` and the
      IndexedDB journalling all live there and survive navigation.
- [x] Make `RecordPage` a view that subscribes to that session. Unmounting must
      tear down the UI only; the account-ownership guards move into the store.
- [x] Add a persistent recording bar on every screen, alongside the job progress
      strip: live dot, elapsed time, transcription lag, and actions to jump
      back, pause and finish.
- [x] Re-enable the back button and let a meeting keep running while recording,
      so the dashboard, search and past meetings stay reachable mid-meeting.
- [x] Wake lock and interruption handling follow the session, not the page.
- [x] Keep the `beforeunload` guard — closing the tab still ends the capture.
- [ ] Still open: show the newest insight in the bar, so the assistant stays
      useful while you are on another screen.

## 2. Separate microphone and system audio

Today `mergeAudioStreams` mixes both into one track, so one transcript
interleaves music with speech and loses speech under the music. In the sample,
segment `[1:00]` is cut off mid-sentence at "Damit das in zwei getrennte
Streams" and `[1:50]` contains no speech at all — it was drowned by the song.

- [x] Run a second segmented capture over the microphone stream alone, and keep
      the mixed stream only for the durable Drive recording.
- [x] Transcribe the two sources independently and label them in the transcript
      (e.g. `[1:00] (Du) …` / `[1:00] (Andere) …`) instead of interleaving.
- [ ] Still open: feed only the speech sources to `/api/insights` and `/api/ask`; song
      lyrics are noise for both.
- [x] Microphone-only remains the fallback when nothing is shared (call with no local
      speaker) so the labelling still reads sensibly.

## 3. The recording has no duration in its container

`ffprobe` reports `duration=N/A`; the file decodes to 2:58.859 but nothing can
seek it. MediaRecorder never writes the EBML `Duration` element. Consequences:
Drive's preview and any player cannot scrub, and `<audio>` reports `Infinity`,
which also affects the in-app review player.

- [x] Patch the WebM header before upload (write `Duration` into Segment Info),
      or remux, so the stored file is seekable.
- [ ] Still open: drive the review player's duration from `report.durationMs`
      rather than from the media element.
- [ ] Still open: no real upload has exercised the patch yet. The Drive sample
      still reports `duration=N/A` because it predates the fix, so the only
      evidence is the offline run against that file.
- [x] `Error parsing Opus packet header` is benign — no action needed.
      Decoding the first 60 s or 170 s produces no warning; decoding the full
      178.86 s produces exactly one, so it is the final packet of a stream that
      was stopped mid-flight. Remuxing with `-c copy` does *not* remove it, so
      it is not Chrome's container header, and the decoded PCM of the original
      and the remux have identical checksums — nothing is lost. Expect one such
      line for any MediaRecorder recording.

## 4. Repetition inside a single segment

Segment `[1:50]` contains the same three sentences twice, and `[1:00]` repeats
"Ooh. It's black and white." and "No more.". This is within one segment, so it
is not the overlap glue — it is either a genuine repeated chorus or the model
looping. Gemini 3's own guidance warns that looping is the failure mode when
sampling is constrained.

- [ ] Still open: verify against the raw audio whether the repetition is real.
- [ ] Still open: log the raw segment transcript alongside the glued
      continuation so the two can be told apart in future runs.
- [x] Drop a continuation that merely repeats of the text
      immediately before it.

## 5. Transcript coverage looks thin

1587 characters for 179 s of audio. Some of that is genuinely music, but the
missing speech in §2 suggests real loss.

- [ ] Still open: re-measure characters per minute of speech on a
      speech-only recording to get a baseline.
- [x] Surface `failedSegments` in the review screen rather than only as a
      warning, so a gap is visible before the report is generated.

## 6. Report polish

- [x] `reportToMarkdown` no longer escapes the ISO date into `2026\-09\-10T15:20:35\.868Z`.
      Format it as a readable date instead of escaping the raw string.
- [x] A typed project name still wins, but the model's title is kept (`title: "gaw"`).
      Decide whether the AI title should win, or be offered as a suggestion.

## 7. Still unverified end to end

- [ ] `/api/ask` and `/api/insights` have never run against live Gemini — only
      against mocked clients and a stubbed browser mount. Blocked on API quota.
- [ ] The dashboard redesign (hero action, draft cards, transcript search with
      snippets) has not been seen signed-in; only typecheck and build cover it.
- [ ] The mic/system split and the recording bar have not been exercised with
      real devices; only unit tests and a stubbed browser mount cover them.
- [ ] Re-enable the Cloud Run deploy job in `.github/workflows/ci.yml` once the
      above has been exercised against the live project.
