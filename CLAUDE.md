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

Single Express process serves both the API and the SPA (`server.ts`): in dev it mounts Vite middleware, in production it serves `dist/` and 404s any `*.cjs` request so the server bundle sharing `dist/` is never publicly readable. `/api/health` reports whether `GEMINI_API_KEY` is set; the deploy smoke test asserts on it and on `transcriptionConfigured` (`ASSEMBLYAI_API_KEY`).

**Three independent storage backends, each able to fail alone.** This is the central design constraint:

- **Google Drive** (`src/lib/drive.ts`, `driveSettings.ts`) — durable store for the raw audio, `zusammenfassung.md`, `transkript.md`, and `bericht_daten.json`, all inside a per-report subfolder of a user-chosen root folder.
- **Firestore** (`src/lib/firebase.ts`, `reports.ts`) — cross-device *index* only, under `users/{uid}/reports/{id}`. `firestore.rules` locks every path to its owner and denies everything else.
- **IndexedDB** (`src/lib/local.ts`, store `cheatmeet/workspace`) — same-device drafts and unsynced report copies, keyed `{uid}:report:{id}`, with a `BroadcastChannel` so multiple tabs stay in sync.

A local write succeeding must never be presented as a cloud save succeeding. `saveReport` writes locally first, then races the Firestore write against a 10s timeout and returns a *warning string* rather than throwing.

**Drive authorization is server-held** (`server/googleAuth.ts`, `server/tokenStore.ts`). Firebase's Google sign-in hands the browser an access token that expires in about an hour and **never a refresh token**, so the browser alone cannot renew and the user gets re-prompted. Instead the server runs the authorization-code flow (`access_type=offline`, PKCE), keeps the refresh token per user, and mints short-lived access tokens at `POST /api/drive-token`. The browser still uploads straight to Drive — media never passes through the server. The grant is keyed by the Google `sub`, read from the Firebase ID token's `firebase.identities["google.com"]` claim, because deriving the Firebase uid server-side would need the Admin SDK. `server/tokenStore.ts` reaches Firestore over REST with a token from the Cloud Run metadata server, so there is still no Admin SDK and no extra dependency. **If `GOOGLE_OAUTH_CLIENT_SECRET` is unset, `/api/auth/config` reports `serverAuth: false` and the client keeps the old popup flow** — an incomplete deployment degrades instead of locking everyone out. `app.set("trust proxy", true)` in `server.ts` is load-bearing: without it `req.protocol` is `http` behind Cloud Run, Google rejects the redirect URI, and the state cookie loses `Secure`. Signing out does **not** revoke the grant — Google's revoke endpoint kills it for that OAuth client on every device, so `POST /api/auth/revoke` exists but is reserved for an explicit "revoke access" action.

**Auth is deliberately split in two.** Firebase identity persists across reloads (`onAuthStateChanged`); the Google Drive OAuth access token is separate, short-lived, kept in `sessionStorage` under `cheatmeet:drive-session`, and scoped to the owning uid with a 50-minute conservative lifetime (`src/lib/session.ts`). `driveToken()` is synchronous and returns `null` — never a stale token — on account mismatch, expiry, or a clock-skewed future expiry, so render paths can read it directly. `ensureDriveToken()` is the async path that mints from the server when the cache is close to expiry; it pins the signed-in uid **before its first await** and discards a result whose account has since changed, because a token minted for one user must never be stored under another.

**Account-change safety.** `src/lib/workflow.ts` wraps every multi-step cloud operation in `ownedOperation()`, which re-asserts `auth.currentUser.uid` before *and* after each await so a sign-out mid-upload aborts instead of writing into the wrong account. `backupDraft` and `syncReport` checkpoint returned Drive file IDs into IndexedDB after every upload, making retries resumable rather than duplicating files.

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

After Drive backup, the server streams the saved audio from Drive to AssemblyAI
without passing the Drive credential to the provider. Browser requests carry a
small reference, avoiding Cloud Run's HTTP/1 upload cap. `finalTranscription.ts`
polls the same job and checkpoints final structured turns plus plain text before
analysis. Only final text goes to Gemini for new recordings; empty final text is
silence, not an audio fallback. Report speaker edits do not trigger ASR again.

The old `liveTranscription.ts`/`segmentCapture.ts`/`transcriptAssembler.ts` and
`/api/transcribe-segment` remain for compatibility/tests. They are not the default
recording path. Existing reports retain their saved transcript. Analysis routes
still authenticate Firebase identity and clean up Gemini files in `finally`.
The shared transcription types/helpers remain dependency-free and isomorphic.

**Save/analyse/export runs in `src/lib/pipeline.ts`, not in a component.** It is a module-level job store, so navigating away no longer cancels the work; `JobProgress` renders running jobs from any screen and guards `beforeunload`. Recording hands off to it and navigates straight to the report. The job still belongs to the tab — closing it abandons the upload.

**PWA**: `vite.config.ts` emits `sw.js` at build time with a content-hashed cache name. Only the public app shell is cached; `/api/`, `/__/` (Firebase auth helpers), cross-origin requests, and all user media are excluded by design. `tests/pwa.integration.mjs` runs the emitted worker in a `vm` sandbox and asserts these exclusions, so changing the caching rules requires updating that test.

**Deployment**: pushes to `main` build a container and deploy to Cloud Run via OIDC workload-identity federation. `scripts/prepare-cloud-run.py` exists because the target service carries an AI Studio source-overlay annotation that must be stripped atomically with its base image while preserving existing env vars and secrets; `scripts/deploy-cloud-run.sh` deploys a no-traffic candidate, smoke-tests it, re-checks that `main` has not moved, then shifts traffic.

## Repo-specific gotchas

- **Both lockfiles must stay committed and in sync.** `Dockerfile` and CI run `npm ci`, and CI additionally runs `bun install --frozen-lockfile` and then `git diff --exit-code` over `package.json`, `package-lock.json` and `bun.lock`. `bun.lock` must be generated by the bun version CI pins (1.3.10) — a newer bun writes `lockfileVersion: 2`, which 1.3.10 cannot parse.
- **This is a repurposed fork of "BauDoku"**, a German construction-site documentation app. Expect German user-facing strings and error messages throughout (keep new ones German for consistency) and the identifier `baudoku` in the service worker cache name and server log line. `ReportData.rawAudioUrl` is a legacy name holding a Drive file *ID*, not a URL. The photo/room model was removed; `src/index.css` and `src/pages/record.css` still carry unused `.photo-*` / `.room-*` rules.
- **`docs/` and `TODO.md` describe the upstream BauDoku project**, including a `development` → `main` promotion workflow and branch protection that do not exist here (this repo has no `development` branch, no branch protection and no rulesets). `.github/workflows/ci.yml` used to enforce that promotion policy on PRs to `main`; because the gate could never pass it was removed, so `verify` and `container` are the only checks. Treat those documents as inherited history, not as a description of this repo's current state.
- **Root-level `fix_*.py`, `patch_*.py`, `make_*.py` are one-off source-rewriting scripts** that were already applied to the TypeScript sources. They are not part of any build and are generally stale relative to the code they edit.
- `GEMINI_MODEL` selects the summarising model and `GEMINI_FAST_MODEL` the per-segment transcribe/stitch model; both fall back to a flash default. Upload limits come from `shared/analysis.ts` (`MAX_FILE_BYTES`, `MAX_SEGMENT_BYTES`) and are overridable per router for tests. Recording has no length cap by design — it warns rather than cutting the meeting off. `src/db/schema.ts` is empty.
- Firestore rules restrict `users/{uid}/settings/preferences` to exactly the key `summaryPrompt` and `settings/drive` to exactly `folder.{id,name}` — adding a settings field requires a rules change plus `firebase deploy --only firestore:rules`.
