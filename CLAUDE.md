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

Single Express process serves both the API and the SPA (`server.ts`): in dev it mounts Vite middleware, in production it serves `dist/` and 404s any `*.cjs` request so the server bundle sharing `dist/` is never publicly readable. `/api/health` reports whether `GEMINI_API_KEY` is set; the deploy smoke test asserts on it.

**Three independent storage backends, each able to fail alone.** This is the central design constraint:

- **Google Drive** (`src/lib/drive.ts`, `driveSettings.ts`) — durable store for the raw audio, `zusammenfassung.md`, `transkript.md`, and `bericht_daten.json`, all inside a per-report subfolder of a user-chosen root folder.
- **Firestore** (`src/lib/firebase.ts`, `reports.ts`) — cross-device *index* only, under `users/{uid}/reports/{id}`. `firestore.rules` locks every path to its owner and denies everything else.
- **IndexedDB** (`src/lib/local.ts`, store `cheatmeet/workspace`) — same-device drafts and unsynced report copies, keyed `{uid}:report:{id}`, with a `BroadcastChannel` so multiple tabs stay in sync.

A local write succeeding must never be presented as a cloud save succeeding. `saveReport` writes locally first, then races the Firestore write against a 10s timeout and returns a *warning string* rather than throwing.

**Auth is deliberately split in two.** Firebase identity persists across reloads (`onAuthStateChanged`); the Google Drive OAuth access token is separate, short-lived, kept in `sessionStorage` under `cheatmeet:drive-session`, and scoped to the owning uid with a 50-minute conservative lifetime (`src/lib/session.ts`). `driveToken()` returns `null` — never a stale token — on account mismatch, expiry, or a clock-skewed future expiry. Saving must not trigger an implicit OAuth popup; expired Drive access is surfaced as an explicit reconnect action.

**Account-change safety.** `src/lib/workflow.ts` wraps every multi-step cloud operation in `ownedOperation()`, which re-asserts `auth.currentUser.uid` before *and* after each await so a sign-out mid-upload aborts instead of writing into the wrong account. `backupDraft` and `syncReport` checkpoint returned Drive file IDs into IndexedDB after every upload, making retries resumable rather than duplicating files.

**Live transcription** is the app's core loop and has three separable parts:

- `src/lib/segmentCapture.ts` runs *additional* MediaRecorders alongside the main one, producing 60 s segments that advance 50 s (a 10 s overlap). A single recorder cannot be sliced after the fact — only its first chunk carries the container header — so each segment needs its own recorder, and two overlap briefly. **Boundaries are decided by `tick()` against the recording clock, never by timers:** a hidden tab has `setTimeout` clamped to 1 s and, after five minutes, to once a minute. `RecordPage` drives `tick()` from the main recorder's `ondataavailable`, which is media-pipeline driven and keeps firing while backgrounded.
- `src/lib/transcriptAssembler.ts` applies segments strictly in order — each one needs the transcript so far as its overlap context — and survives a failed segment by counting it and moving on.
- `POST /api/transcribe-segment` transcribes the segment, then makes a second cheap call that returns **only the continuation**, stripping the duplicated overlap and cleaning obvious errors. Returning a continuation rather than a rewritten full transcript keeps per-call cost flat as the meeting grows.

`POST /api/analyze` summarises the assembled transcript and **does not re-upload the audio**; audio is only sent when there is no transcript at all (an imported file). A supplied transcript always wins over whatever the summarising model echoes back. The full raw audio still goes to Drive regardless.

Both routes verify the Firebase ID token via `jose` against Google's JWKS (no Admin SDK) and delete the remote Gemini file and the multer temp file in `finally` on every path — including rejected uploads and media that never becomes `ACTIVE`. `/analyze` holds a per-user concurrency slot; segment transcription deliberately does not, since the client already serializes it.

`shared/analysis.ts` is imported by both the browser and the server — keep it dependency-free and isomorphic.

**Save/analyse/export runs in `src/lib/pipeline.ts`, not in a component.** It is a module-level job store, so navigating away no longer cancels the work; `JobProgress` renders running jobs from any screen and guards `beforeunload`. Recording hands off to it and navigates straight to the report. The job still belongs to the tab — closing it abandons the upload.

**PWA**: `vite.config.ts` emits `sw.js` at build time with a content-hashed cache name. Only the public app shell is cached; `/api/`, `/__/` (Firebase auth helpers), cross-origin requests, and all user media are excluded by design. `tests/pwa.integration.mjs` runs the emitted worker in a `vm` sandbox and asserts these exclusions, so changing the caching rules requires updating that test.

**Deployment**: pushes to `main` build a container and deploy to Cloud Run via OIDC workload-identity federation. `scripts/prepare-cloud-run.py` exists because the target service carries an AI Studio source-overlay annotation that must be stripped atomically with its base image while preserving existing env vars and secrets; `scripts/deploy-cloud-run.sh` deploys a no-traffic candidate, smoke-tests it, re-checks that `main` has not moved, then shifts traffic.

## Repo-specific gotchas

- **Both lockfiles must stay committed and in sync.** `Dockerfile` and CI run `npm ci`, and CI additionally runs `bun install --frozen-lockfile` and then `git diff --exit-code` over `package.json`, `package-lock.json` and `bun.lock`. `bun.lock` must be generated by the bun version CI pins (1.3.10) — a newer bun writes `lockfileVersion: 2`, which 1.3.10 cannot parse.
- **This is a repurposed fork of "BauDoku"**, a German construction-site documentation app. Expect German user-facing strings and error messages throughout (keep new ones German for consistency) and the identifier `baudoku` in the service worker cache name and server log line. `ReportData.rawAudioUrl` is a legacy name holding a Drive file *ID*, not a URL. The photo/room model was removed; `src/index.css` and `src/pages/record.css` still carry unused `.photo-*` / `.room-*` rules.
- **`docs/` and `TODO.md` describe the upstream BauDoku project**, including a `development` → `main` promotion workflow and branch protection that do not exist here (this repo has `main` only, two commits). `.github/workflows/ci.yml` still enforces that promotion policy on PRs to `main`. Treat those documents as inherited history, not as a description of this repo's current state.
- **Root-level `fix_*.py`, `patch_*.py`, `make_*.py` are one-off source-rewriting scripts** that were already applied to the TypeScript sources. They are not part of any build and are generally stale relative to the code they edit.
- `GEMINI_MODEL` selects the summarising model and `GEMINI_FAST_MODEL` the per-segment transcribe/stitch model; both fall back to a flash default. Upload limits come from `shared/analysis.ts` (`MAX_FILE_BYTES`, `MAX_SEGMENT_BYTES`) and are overridable per router for tests. Recording has no length cap by design — it warns rather than cutting the meeting off. `src/db/schema.ts` is empty.
- Firestore rules restrict `users/{uid}/settings/preferences` to exactly the key `summaryPrompt` and `settings/drive` to exactly `folder.{id,name}` — adding a settings field requires a rules change plus `firebase deploy --only firestore:rules`.
