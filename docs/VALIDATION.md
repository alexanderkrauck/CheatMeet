# Validation — 10 September 2026

## Automated checks

- TypeScript (`npm run lint`) passed.
- 52 Vitest tests passed: authenticated analysis API, upload boundaries, cleanup, room/tag validation, Markdown export and retry IDs, Drive folder settings and imports, local/remote revision conflicts, account changes, recording clock, and Cloud Run payload budgets.
- Five production/PWA checks passed (`npm run test:pwa`): generated assets, offline navigation, authenticated-request cache exclusions, cache lifecycle, and actual production Express routes.
- Production build passed; Vite reports a large frontend bundle warning (Firebase is the largest dependency).
- Dependency audit reported zero vulnerabilities.
- Git diff whitespace checks passed.

## Browser exercises

Playwright CLI was used with a local browser and synthetic data. Firebase sign-in was seeded in the browser's real persistence store; Google identity responses were mocked. Firebase writes were deliberately blocked to exercise recovery. Drive and Gemini responses were mocked; no real user files or Google account were changed.

Verified:

- Desktop login and mobile login layout.
- Firebase account survives refresh while the temporary Drive token is absent.
- Actual MediaRecorder with a synthetic audio stream: start, pause, frozen pause timer, resume, stop, and playable preview.
- Local audio/title recovery after page reload and an interrupted development reload.
- Capture/import photo selection, stable photo ID through multipart analysis, authenticated image rendering, and manual reassignment between rooms.
- Full recording → original media backup → mocked AI → Markdown/JSON export → report navigation, while Firebase is unavailable.
- Room/tag filters, room name and tag edits, local save despite unavailable Firebase.
- No horizontal overflow at 390 px in login, recording/review, and report views.
- Browser JPEG analysis-copy generation preserves photo ID/timeline and leaves originals unchanged.
- Production service worker controls the app, and an offline reload renders the app shell.

Screenshots and temporary scripts live under ignored `output/playwright/` locally.

## External configuration still to verify

This does not claim a live Gemini call, real Google Picker consent, actual Firestore write acknowledgement, cloud rules deployment, real-device microphone/background behavior, or installation on a physical iPhone/Android device. These depend on the deployment's Google project configuration and authenticated user account. Follow the setup and live verification steps in the README.

## Mobile recording follow-up (2026-09-10)

Built on Gemini commit `6d17259`; its model selection and dependency files are unchanged.

- TypeScript, 63 Vitest tests and all five production/PWA checks pass. New tests cover separate draft recovery, legacy migration, ordered/idempotent chunk recovery, targeted deletion, storage failures, background flushing and microphone interruptions.
- Real Chromium MediaRecorder with synthetic audio/video: capture controls fit 390×844, 320×568 and 844×390. Document height equals viewport height. Photo, pause and finish buttons remain inside the viewport.
- In-app photo capture leaves the synthetic microphone track live. Pause/resume works; finishing exposes the primary save/analysis action.
- Reload during recording recovered the same 32,286 audio bytes and one photo. Starting a different draft retained the previous recording. The recovered save button fits the 320×568 viewport, including the interruption notice.
- With the browser offline, recording committed audio to IndexedDB, microphone mute paused the timer, explicit resume worked, and the finished recording played. Cloud save remained disabled until connectivity returned.
- Injected IndexedDB quota errors during camera capture. The photo remained in memory, the camera closed without inviting duplicate capture, and the storage error was shown. Once writes were re-enabled, pending audio and the photo committed and the error cleared.
- Existing live Gemini behavior is user-verified; local browser exercises use mocked identity/Drive/AI and blocked Firestore. No physical phone lock-screen guarantee is inferred from desktop simulation. Browser storage eviction, OS termination and delayed media events remain platform limits.
- Re-ran finish → mocked Drive originals → mocked room analysis → Markdown/JSON export → report navigation with Firestore unavailable; the new primary action completed the flow.

## Drive authorization timing follow-up (2026-09-10)

- Fixed the root cause of repeated authorization after reload: the Drive access token previously existed only in module memory. It now survives reload in sessionStorage, retains its original expiry, and is scoped to the restored Firebase account. Sign-out, account mismatch and expiry invalidate it.
- Online capture requires authorization before opening the microphone and checks Drive access with a read-only request. Near-expiry tokens are renewed before starting a new recording. The existing Google sign-in already requests the required drive.file scope.
- Saving no longer calls OAuth implicitly. Expired authorization exposes a separate reconnect action and disables both save variants. Offline recording remains possible; temporary Drive/network failures offer explicit local capture.
- 81 Vitest tests, TypeScript, production build and five PWA checks pass. Added tests exercise session reload, account restoration/switching, expiry, blocked storage, event notification, scope-check rejection and transient failures.
- Browser exercises with synthetic credentials and media verify pre-capture authorization, reload reuse, denial before any microphone request, explicit expiry state, and controls fitting 320×568. A failed network preflight keeps the microphone stopped until the user chooses local capture.
- Access-token expiry still follows Google's browser OAuth model; this does not implement server-side refresh-token storage or claim permanent authorization. Live Google consent remains dependent on the deployed project's configuration.
- Re-ran the save/analysis/Drive-export flow through the new primary action with mocked services; it completed without an OAuth popup.

## CI lockfile compatibility follow-up (2026-09-10)

GitHub run 34462619595 failed during setup-node because package-lock.json had been removed. Restored the previously validated npm lock (package.json had not changed) and regenerated bun.lock from it with Bun 1.3.10. Both include the qs override.

A clean npm ci and an isolated clean bun install --frozen-lockfile each passed TypeScript, all 81 tests, production build, and all five PWA/production-server checks. CI now runs both installation paths on Linux and rejects lockfile changes during checks. AI Studio's dev command, media plugin, frame permissions, DISABLE_HMR handling, Node production server and Gemini model are unchanged. No live AI Studio deployment was performed.

## Protected release and Cloud Run setup (2026-09-10)

- GitHub default branch is development. Active ruleset 22758062 protects main with required PRs, strict GitHub Actions checks (verify npm/bun, container, promotion-policy), no force pushes/deletion, and no bypass actors. Ruleset 22758063 preserves development history.
- Development and PR checks passed before PRs 1 and 2 merged; the initial PR was observed BLOCKED until checks completed. A test timing race exposed by the main gate was fixed by giving upload validation cases separate routers. The suite now contains 82 tests.
- Production authentication uses repository/owner-ID-scoped Workload Identity Federation, limited to the protected main reusable deployment workflow. GitHub successfully authenticated and published an image without a service-account key.
- Google Cloud identified an AI Studio source-overlay annotation incompatible with ordinary image deployment. The candidate-preparation helper removes that overlay atomically, preserves env/secret references and settings, and freezes existing live traffic. The real service specification passed gcloud services replace --dry-run.
- Nine Python regression tests cover service configuration preservation, traffic safety, and invalid configurations. CI runs these before the production container smoke test. Smoke checks have per-request and overall deadlines.

- The complete automatic deployment succeeded in [Checks run 34467950362, attempt 2](https://github.com/alexanderkrauck/Baudoku/actions/runs/34467950362). Revision `drive-sync-notes-gh-7d4526609891-34467950362-2` serves 100% of live traffic.
- Both candidate and live health/Gemini-configuration/SPA/PWA/private-bundle smoke tests passed. An independent post-deploy comparison confirmed all existing environment values, runtime identity, resource limits and the public URL were preserved.
- The deployer's custom project role grants only `resourcemanager.projects.get` for gcloud's project lookup; service mutation remains scoped to this Cloud Run service.
- The successful release went through protected development-to-main PRs. The local checkout and GitHub default branch are development; main rules remain active with no bypass actors.
