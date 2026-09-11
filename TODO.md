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

- [ ] Add a server-side authorization-code flow (`access_type=offline`,
      `prompt=consent`, scope `drive.file openid email profile`) with a
      `/api/auth/google/callback` endpoint. Needs the OAuth **client secret**
      deployed as a Cloud Run secret; only `oAuthClientId` exists today.
- [ ] Exchange the code server-side, store the refresh token per user, and
      return the Google `id_token` so the client can call
      `signInWithCredential` — one consent screen, not two.
- [ ] Add `POST /api/drive-token`: given a valid Firebase ID token, mint a fresh
      access token from the stored refresh token. The client caches it in memory
      until shortly before expiry. `sessionStorage` and the popup path go away.
- [ ] Make `driveToken()` async and update every call site (`capture.ts`,
      `RecordPage`, `ReportPage`, `Dashboard`, `workflow.ts`, `drive.ts`).
- [ ] On `invalid_grant` (consent revoked, long inactivity) return a distinct
      401 and sign the user out with an explicit message.
- [ ] Keep audio uploading straight from the browser to Drive. Do **not** proxy
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

### 2. Report and transcript design pass

The live meeting screen got a design pass; the finished report did not.

- [ ] `ReportPage` renders `view.transcription` as one raw `<p>` inside a
      `<details>`. Reuse `parseTranscript()` and the chat markup from
      `LiveMeeting` so a finished transcript reads like the live one.
- [ ] Give the summary, to-dos and takeaways the same treatment as the live
      surface — spacing, hierarchy and the glass styling — instead of plain
      stacked panels.
- [ ] Review button placement and labelling across the report and dashboard.

---

## From the 2026-09-11 feedback recording (`c02db430`)

### 3. A single-channel recording must not be labelled "Du"

On the phone there is no system audio, so everything is one channel. Labelling
every turn `(Du)` is wrong and implies a speaker separation that does not exist.

- [ ] When only the microphone is captured, drop the speaker label (or use a
      neutral one) rather than asserting `(Du)`.
- [ ] `parseTranscript` must keep rendering older two-source transcripts.

### 4. The pause button sits off-centre

Confirmed: `.walk-capture-controls` is a flex row that used to hold two buttons.
Since the photo button was removed the single 78 px `.walk-pause` sits hard
left.

- [ ] Centre it, or let it fill the row.

### 5. The PWA icon is still BauDoku

Confirmed: `public/icons/icon-192.png`, `icon-512.png` and
`apple-touch-icon.png` are the old dark-green house. `icon.svg` was updated to
the CheatMeet waveform, but the manifest references only the PNGs.

- [ ] Regenerate the PNGs from `icon.svg` at 192, 512 and apple-touch sizes.
- [ ] The service worker precaches these paths; confirm the hashed shell picks
      up the change and reinstall the PWA to verify.

### 6. Absolute timestamps alongside relative ones

- [ ] Record the wall-clock time each segment was spoken, not only the offset
      from the recording start, and show both.
- [ ] `report.date` plus the relative offset gives this without new storage;
      decide whether to derive or store it.

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
