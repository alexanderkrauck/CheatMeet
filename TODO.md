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

### 2b. Report screen: second design pass — product, not generated document

The first pass fixed correctness. It did not fix **composition**: too many
elements compete at the same visual level, so the screen still reads as a
well-styled generated report rather than a mature product screen.

Design against this principle: **compact report header → concise intelligence
overview → transcript as the dominant workspace.**

- [ ] Shrink the header. A multi-line 44px title eats the first screen to tell
      the user what they just opened. Content should start much higher.
- [ ] Stop giving every section the same full-width card. Summary, tasks,
      insights and transcript share one treatment, which flattens hierarchy.
      The transcript is the primary artifact; the rest is secondary.
- [ ] Put `Aufgaben` and `Wichtigste Erkenntnisse` side by side, or into one
      compact intelligence region. Today they are two tall cards holding two
      lines each, so the page is long without being informative.
- [ ] Reconsider the chat metaphor **for the finished report**. Large left/right
      bubbles waste horizontal space and make scanning harder when reading
      rather than following live; a timeline/speaker layout is likely stronger.
      Keep the chat view on the live recording screen — it was asked for there
      and it works, because following along is a different task from scanning.
- [ ] Unify the action row. `Bearbeiten / PDF / .md` on the left and Drive on
      the far right read as two unrelated islands. One clear primary action plus
      a compact export/share group.
- [ ] Demote status. "Bericht erstellt" and "In Drive gespeichert" are two green
      success states occupying prime space for low-priority information.
- [ ] Use the gradient more selectively. It gives the app personality but makes
      a report feel less serious, and slightly like an AI landing page.
- [ ] Differentiate the cards semantically. A summary, a checklist, an insight
      list and a transcript should not behave identically.
- [ ] Decide the focal workflow. Read the summary, edit, work the tasks, or go
      through the transcript? One should be obviously primary.
- [ ] Design the transcript region for the interactions it should support even
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

- [x] Regenerated the PNGs from a rebuilt `icon.svg` at 192, 512 and apple-touch sizes.
- [ ] Still open: the service worker precaches these paths — reinstall the PWA
      on a device to confirm the hashed shell picks the new icon up.

### 6. Absolute timestamps alongside relative ones

- [x] Each turn shows the wall clock beside its offset ("1:40 · 12:02"),
      derived from `report.date` rather than stored, so no schema change.

---

## Research and ideas

### 7. Proactive assistant (explicitly a nice-to-have)

- [ ] Every minute or two, have the assistant proactively offer topics,
      questions or things to raise, rather than only answering when asked.
      Most valuable in an online meeting.

### 8. Speaker diarization

- [ ] Single-channel phone recordings cannot separate speakers with the current
      model. Research whether a dedicated diarization model is worth adding, or
      whether the two-source split covers the realistic cases.

---

## Carried over

- [ ] Feed only speech sources to `/api/insights` and `/api/ask`; music and
      video audio are noise for both.
- [ ] Show the newest insight in the recording bar so the assistant stays useful
      from other screens.
- [ ] Drive the review player's duration from `report.durationMs` rather than
      from the media element.
- [ ] Re-measure transcript characters per minute on a speech-only recording to
      get a coverage baseline.
- [ ] Log the raw segment transcript alongside the glued continuation so model
      looping can be told apart from genuine repetition.
- [ ] `/api/ask` and `/api/insights` have still never run against live Gemini.
- [ ] Re-enable the Cloud Run deploy job in `.github/workflows/ci.yml` once the
      above has been exercised against the live project.
