# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # tsx server.ts — Express with Vite in middleware mode (single process, port 3000)
npm run build        # vite build (dist/) + esbuild bundles server.ts -> dist/server.cjs
npm start            # NODE_ENV=production node dist/server.cjs
npm run lint         # tsc --noEmit — this is the only linter/typecheck
npm test             # vitest run
npm run test:pwa     # builds, then node --test tests/pwa.integration.mjs (needs dist/sw.js)
```

Single test file / single case:

```bash
npx vitest run src/lib/session.test.ts
npx vitest run -t "restores the token after reload"
```

The Cloud Run deploy-config tests are Python, not Vitest, and CI runs them separately:

```bash
python3 -m unittest discover -s tests -p 'test_deploy_config.py'
```

`DISABLE_HMR=true` disables HMR *and* file watching in `vite.config.ts` — set it when an agent is editing files during a running dev server.

## Architecture

**Microsoft ecosystem:** `MICROSOFT_IMPLEMENTATION.md` owns setup, permissions and recovery. Identity, calendar and archive provider are independent. Explicit Microsoft `home` refs use `users/{uid}/meetings` and isolated local namespaces; never put OneDrive IDs in legacy Google fields or fall back to Google. Server auth/upload routers, provider-aware worker IO and read-only MCP share the existing durable stores. Microsoft credentials belong only in Secret Manager and Firebase provider configuration.

Single Express process serves both the API and the SPA (`server.ts`): in dev it mounts Vite middleware, in production it serves `dist/` and 404s any `*.cjs` request so the server bundle sharing `dist/` is never publicly readable. `/api/health` reports whether `GEMINI_API_KEY` is set; the deploy smoke test asserts on it and on `transcriptionConfigured` (`ASSEMBLYAI_API_KEY`).

**Three independent storage backends, each able to fail alone.** This is the central design constraint:

- **Google Drive** (`src/lib/drive.ts`, `driveSettings.ts`) — durable store for the raw audio, `zusammenfassung.md`, `transkript.md`, and `bericht_daten.json`, all inside a per-report subfolder of a user-chosen root folder.
- **Firestore** (`src/lib/firebase.ts`, `reports.ts`) — cross-device *index* only, under `users/{uid}/reports/{id}`. `saveReport` writes `projectReport(next)`, which strips `transcription` and `speech`; the rules reject a non-empty transcript or any `speech` key. `acceptRemoteReport` must therefore merge rather than replace (`mergeRemoteReport`), or the cloud echo of a projection erases the transcript on the device that recorded it. The honest consequence — a meeting recorded on one device is not searchable by transcript content on another until it is restored from Drive — is surfaced on the dashboard rather than hidden. `firestore.rules` locks every path to its owner and denies everything else.
- **IndexedDB** (`src/lib/local.ts`, store `cheatmeet/workspace`) — same-device drafts and unsynced report copies, keyed `{uid}:report:{id}`, with a `BroadcastChannel` so multiple tabs stay in sync.

A local write succeeding must never be presented as a cloud save succeeding. `saveReport` writes locally first, then races the Firestore write against a 10s timeout and returns a *warning string* rather than throwing.

**Recording is gated on consent, and the notice is data.** `armCapture` opens
the microphone and the screen share and stops there: nothing is journaled to
IndexedDB and no AssemblyAI socket is opened until `beginRecording`. German
StGB § 201 is completed by the act of recording onto a storage medium, so
"record first, delete if they refuse" is the offence, not a workaround; the
armed window exists only so the consent press starts capture with no browser
dialogs left. `shared/consent.ts` derives the four legally required elements
(purpose, means, recipients, retention) from the meeting's real configuration
and assembles them in a fixed order. `POST /api/consent-notice` may only
*rephrase* an element; anything it omits or mangles falls back to the
deterministic German sentence, so coverage is structural. `einwilligung.md` is
written write-once **before** the audio, and each meeting's retention deadline
is read out of its own consent record (`audioExpiresAt`), so the days promised
are the days `retentionSweep.ts` enforces and a meeting recorded before consent
existed is never swept.

**The Drive folder is the archive, and it is meant to be read without this
app.** `src/lib/archive.ts` is the versioned interchange boundary for
`bericht_daten.json` — `toArchive` strips session internals, `fromArchive`
constructs the result explicitly so an externally edited file cannot inject
keys into the local store, and v0 files stay readable forever. The root also
carries a derived `index.json` and a `SCHEMA.md`; the per-meeting JSON is the
source of truth and the index says so.

**Drive authorization is server-held** (`server/googleAuth.ts`, `server/tokenStore.ts`). Firebase sign-in establishes identity only; data consent is separate and does not link another login method. The server runs the authorization-code flow (`access_type=offline`, PKCE), keeps new grants under `uidGrantKey(verifiedFirebaseUid)`, and mints short-lived access tokens at `POST /api/drive-token`. Owner-eligible historical Google-subject grants and cached clients remain supported; a historical alias is never authority over another owner's replacement. Workers and MCP resolve the effective opaque grant key through the same store, failing closed on read/CAS errors rather than falling back. The browser still uploads directly to Drive. The store reaches Firestore over REST with the runtime identity; no Admin SDK is needed. **If `GOOGLE_OAUTH_CLIENT_SECRET` is unset, `/api/auth/config` reports `serverAuth: false` and the client keeps the old popup flow.** `app.set("trust proxy", true)` remains load-bearing behind Cloud Run. Signing out does **not** revoke the grant; `POST /api/auth/revoke` is reserved for explicit revocation and distinguishes confirmed provider revocation from local-only containment.

Grant changes use native-version compare-and-set, including credential-free tombstones. Revocation cutoffs survive later generations; signed OAuth start times and final CAS prevent an older callback from reconnecting after revocation. Firestore cutoffs use native `REQUEST_TIME`. Same-millisecond start/cutoff ties fail conservatively and require restarting consent; an old unsigned in-flight popup must also restart. Existing durable grants need no migration.

**Auth is deliberately split in two.** Firebase identity persists across reloads (`onAuthStateChanged`); the Google Drive OAuth access token is separate, short-lived, kept in `sessionStorage` under `cheatmeet:drive-session`, and scoped to the owning uid with a 50-minute conservative lifetime (`src/lib/session.ts`). `driveToken()` is synchronous and returns `null` — never a stale token — on account mismatch, expiry, or a clock-skewed future expiry, so render paths can read it directly. `ensureDriveToken()` is the async path that mints from the server when the cache is close to expiry; it pins the signed-in uid **before its first await** and discards a result whose account has since changed, because a token minted for one user must never be stored under another.

**Account-change safety.** `src/lib/workflow.ts` wraps every multi-step cloud operation in `ownedOperation()`, which re-asserts `auth.currentUser.uid` before *and* after each await so a sign-out mid-upload aborts instead of writing into the wrong account. `backupDraft` and `syncReport` checkpoint returned Drive file IDs into IndexedDB after every upload, making retries resumable rather than duplicating files.

`handleCaptureOwnerChange` fences capture on every auth transition, including sign-out, while retaining the old owner's recoverable draft. PWA reload safety reads private `canReleaseCapture()` state and rechecks at activation; a foreign-masked public snapshot is not reload authority. Report edits/restores/checkpoints use observed local revisions; pending archive edits retain `archiveBaseSyncedAt`, and canonical JSON writes use provider-native conditional I/O. These checks do not make local, index, Markdown and archive writes one distributed transaction.

**Nutzung** (`server/usage/`, `src/lib/consumption.ts`, `src/pages/UsagePage.tsx`) records actual provider consumption per verified account: one Gemini entry per real SDK attempt, each live source/reconnection separately, and native batch reservations. Production uses the server-only `usageEvents` Firestore ledger; local development uses private `.usage-events/` files. Gemini counters are saved before response parsing; a paid response is never retried merely because accounting settlement failed. Browser-relayed live duration is labelled separately from server-received provider metadata, and missing measurements/history remain unknown. Day/week/month views use Vienna operation start, follow all bounded API pages, and show rate-snapshot USD **estimates**, not invoices. Every user can read only their own usage, without an operator/admin exception or environment-based privilege; API and store queries require the verified owner, and scope/owner overrides are rejected. Existing ledger history and rate snapshots remain intact. Report-derived meeting activity (`src/lib/usage.ts`) remains separate. See `USAGE_IMPLEMENTATION.md` for privacy, indexes, rates and rollout.

**AssemblyAI is the default for new recordings and imports.** See
`ASSEMBLYAI_IMPLEMENTATION.md` for the full flow and rollout requirements.
`src/lib/assemblyLive.ts` opens one Pro streaming connection per actual capture
source; `pcmWorklet.js` emits 16 kHz PCM frames. Partial turns replace by ID;
`assemblyEvents.ts` groups by word-level speakers and applies speaker revisions.
Dropped/paused audio is not replayed. The durable recording remains independent.

`server/transcription.ts` issues short-lived streaming tokens and manages one
final Pro batch job per owner/meeting. In production, `transcriptionStore.ts`
uses atomic Firestore reservations in the server-only `transcriptionJobs`
collection; local development uses private `.transcription-jobs/` files. Never
replace these with an in-memory production store or delete reservations to retry
an uncertain submission: this guards the two-transcription limit across restarts.

Recordings use their live transcript by default. On the finished-recording screen,
users can opt into one additional paid full-audio transcription before analysis.
`Draft.retranscribe` persists this choice locally until success; failed/uncertain
requests retain the live transcript and resume the existing server job. After
Drive backup, the server streams the saved audio to AssemblyAI without passing
the Drive credential to the provider. `prepareTranscript.ts` polls the reserved
job and checkpoints the batch text before analysis. `speakerMatches.ts` carries
over unambiguous live speaker names; uncertain matches keep neutral speaker labels.
Naming is optional and never pauses analysis or opens a mandatory review screen.
Names can still be corrected in the transcript. Imports also use this batch path. "Only save in Drive" never starts
paid ASR, even when the option is checked. Report speaker edits do not trigger ASR.
Only transcript text goes to Gemini for new recordings; there is no automatic
audio fallback when live transcription is empty.

The old `liveTranscription.ts`/`segmentCapture.ts`/`transcriptAssembler.ts` and
`/api/transcribe-segment` remain for compatibility/tests. They are not the default
recording path. Existing reports retain their saved transcript. Analysis routes
still authenticate Firebase identity and clean up Gemini files in `finally`.
The shared transcription types/helpers remain dependency-free and isomorphic.

**MCP access is a separate, read-only surface** (`server/mcp/`, full description in
`MCP_IMPLEMENTATION.md`). It is stateless Streamable HTTP at `/api/mcp` with its
own small OAuth authorization server, because Google can serve neither dynamic
registration nor client-ID metadata: Google sign-in is only the login on the
consent page (`/connect`), and no Google or Drive token ever reaches the
assistant. Grants (`mcpGrants`) and live transcripts (`mcpLive`) are server-only
Firestore collections behind one `DocStore` with compare-and-set - never
in-memory in production, for the same reason as `transcriptionJobs`. Tools take
the account from the verified token, never from an argument. The recording tab
feeds the live transcript through `src/lib/liveShare.ts`, which sends **no text**
until the server answers that an assistant holds a `meetings:live` grant. The
feature is off unless `MCP_PUBLIC_URL` and `MCP_TOKEN_SECRET` are set.

**Live transcription recovers on its own** (`src/lib/assemblyLive.ts`). Every
failure - close, error, provider-ended session, silence - goes through one
`interrupted()` path with capped back-off that resets after a healthy connection;
a watchdog (driven by `tick()`) rebuilds a source that goes quiet, using the
provider's `session_heartbeat`. Only a rejected request or a lost login gives
up, and then the user gets a "Live neu starten" button (`restartLive()`).
`src/lib/assemblyLive.stall.test.ts` holds the regression tests; keep the GUARD
cases green.

**Post-upload processing is server-owned when configured** (`server/processing/`,
`shared/processing.ts`). Cloud Tasks invokes an OIDC-authenticated worker; a
Firestore `processingJobs` document holds run identity, lease, retries and stage,
not audio/transcript content. Drive checkpoints let a restarted task resume the
existing ASR job or skip a completed summary. Each dispatch has a 200s awaited
budget, with one <=120s Gemini attempt. Source/index revision checks and a
conditional Drive update protect later edits. Drive v3 can omit ETag headers;
the worker checks v2's explicit etag/version and uses conditional v2 media PUT.
After audio + transcript JSON upload and job acceptance, the tab can close.
`src/lib/pipeline.ts` retains the local fallback for unconfigured development;
`JobProgress` guards only unfinished browser-owned work. Polling restores job
status and final/review reports after reload/on other devices. A revoked Drive
grant pauses processing without signing the user out of Firebase. See
`SERVER_PROCESSING.md` for runtime bindings and recovery.

**PWA**: `vite.config.ts` emits `sw.js` at build time with a content-hashed cache name. Only the public app shell is cached; `/api/`, `/__/` (Firebase auth helpers), cross-origin requests, and all user media are excluded by design. `tests/pwa.integration.mjs` runs the emitted worker in a `vm` sandbox and asserts these exclusions, so changing the caching rules requires updating that test.

**Deployment**: pushes to `main` build a container and deploy to Cloud Run via OIDC workload-identity federation. `scripts/prepare-cloud-run.py` exists because the target service carries an AI Studio source-overlay annotation that must be stripped atomically with its base image while preserving existing env vars and secrets; `scripts/deploy-cloud-run.sh` deploys a no-traffic candidate, smoke-tests it, re-checks that `main` has not moved, then shifts traffic.

## Repo-specific gotchas

- **Both lockfiles must stay committed and in sync.** `Dockerfile` and CI run `npm ci`, and CI additionally runs `bun install --frozen-lockfile` and then `git diff --exit-code` over `package.json`, `package-lock.json` and `bun.lock`. `bun.lock` must be generated by the bun version CI pins (1.3.10) — a newer bun writes `lockfileVersion: 2`, which 1.3.10 cannot parse.
- **This is a repurposed fork of "BauDoku"**, a German construction-site documentation app. Expect German user-facing strings and error messages throughout (keep new ones German for consistency) and the identifier `baudoku` in the service worker cache name and server log line. `ReportData.rawAudioUrl` is a legacy name holding a Drive file *ID*, not a URL. The photo/room model was removed; `src/index.css` and `src/pages/record.css` still carry unused `.photo-*` / `.room-*` rules.
- **`docs/` and `TODO.md` describe the upstream BauDoku project**, including a `development` → `main` promotion workflow and branch protection that do not exist here (this repo has no `development` branch, no branch protection and no rulesets). `.github/workflows/ci.yml` used to enforce that promotion policy on PRs to `main`; because the gate could never pass it was removed, so `verify` and `container` are the only checks. Treat those documents as inherited history, not as a description of this repo's current state.
- **Root-level `fix_*.py`, `patch_*.py`, `make_*.py` are one-off source-rewriting scripts** that were already applied to the TypeScript sources. They are not part of any build and are generally stale relative to the code they edit.
- `GEMINI_MODEL` selects the summarising model and `GEMINI_FAST_MODEL` the per-segment transcribe/stitch model; both fall back to a flash default. Upload limits come from `shared/analysis.ts` (`MAX_FILE_BYTES`, `MAX_SEGMENT_BYTES`) and are overridable per router for tests. Recording has no length cap by design — it warns rather than cutting the meeting off. `src/db/schema.ts` is empty.
- Firestore rules restrict `users/{uid}/settings/preferences` to exactly the key `summaryPrompt` and `settings/drive` to exactly `folder.{id,name}` — adding a settings field requires a rules change plus `firebase deploy --only firestore:rules`.
