# CheatMeet backlog

Maintained from real recordings. Each item says what was observed and where, so
it can be picked up without re-deriving the context.

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
- A source that was silent for a whole segment is correctly dropped rather than
  emitting an empty turn.

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

- [ ] Decide whether to adopt it. If yes: switch the segment transcription call
      to `gemini-3.5-transcribe` with diarization, and extend the glue step to
      map each segment's speaker labels onto the running transcript using the
      overlap.
- [ ] Measure the cost difference first — it runs per segment, so a pricing
      change multiplies across a meeting.

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
