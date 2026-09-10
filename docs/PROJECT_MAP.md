# Project map

## Original implementation and observed failure modes

The original repository contained four React screens (`Login`, `Dashboard`, `RecordPage`, `ReportPage`), a small Drive client, Firebase initialization, and an Express `/api/analyze` handler. Vite ran as Express middleware in development; the production server served the built SPA.

- Routes required both a Firebase user and an in-memory Google access token. Reload cleared the token and sent a still-authenticated user back to login.
- Recording coupled media upload, AI analysis, Firebase saving, and Drive export into one fragile path. Audio was labelled WebM regardless of the recorder's actual output format.
- The server used an unchecked model response, returned parse failures as apparent reports, and did not consistently clean temporary/uploaded files on every failure path. Upload/model lifecycle and photo identifiers were not validated end to end.
- Firebase Storage duplicated the intended Drive media backend. There was no included Firestore rules deployment or clear database configuration, making a permission/database mismatch difficult to diagnose.
- A hardcoded Drive root prevented choosing the destination. Private Drive files were treated as if they could always be rendered as public URLs.
- There was no install manifest, service worker, or durable local recovery layer, and the page metadata still described a different notes product.

These findings come from repository inspection, not from a successful reproduction against the owner's production Google account.

## Current module responsibilities

| Area              | Module                                                                           | Responsibility                                                                 |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Application       | `src/App.tsx`                                                                    | Firebase session lifecycle, routes, app shell                                  |
| Sign-in           | `src/pages/Login.tsx`, `src/lib/session.ts`                                      | Google sign-in, separate expiring Drive permission, actionable auth errors     |
| Overview          | `src/pages/Dashboard.tsx`                                                        | Report list, local/cloud status, entry points                                  |
| Capture           | `src/pages/RecordPage.tsx`                                                       | Microphone lifecycle, pause/resume, photo timing, draft recovery               |
| Review            | `src/pages/ReportPage.tsx`                                                       | Structured report, editing, media access, save/retry/export                    |
| Firebase          | `src/lib/firebase.ts`, `src/lib/reports.ts`                                      | Database selection, per-user report index, cloud/local reconciliation          |
| Local persistence | `src/lib/local.ts`                                                               | Per-user IndexedDB drafts and unsynchronized report copies                     |
| Workflow          | `src/lib/workflow.ts`                                                            | Analysis request, resumable Drive backup, export, draft restoration            |
| Drive             | `src/lib/drive.ts`, `src/lib/driveSettings.ts`                                   | Authorized folder/file operations and destination selection                    |
| Shared contract   | `shared/analysis.ts`                                                             | Audio format and generated-report validation                                   |
| Backend           | `server.ts`, `server/`                                                           | Authenticated analysis endpoint, bounded media processing, Gemini integration  |
| Installation      | `src/components/InstallApp.tsx`, `public/manifest.webmanifest`, `vite.config.ts` | Install/update affordance, icons, public-shell-only service worker             |
| Deployment        | `.env.example`, `firebase.json`, `firestore.rules`, `README.md`                  | Runtime setup, owner-only database access, deployment and live smoke checklist |

## Data flow

1. Firebase restores the user independently of Drive's short-lived authorization.
2. The recording screen gathers audio and photos and saves a recoverable local draft.
3. Media backup writes to a report folder in the selected Drive destination and checkpoints returned file IDs for retries.
4. The authenticated Express endpoint accepts multipart media, validates it, requests structured Gemini analysis, and validates the response before returning it.
5. The report is stored locally first and indexed under the user's Firestore path. Cloud failures remain visible and retryable.
6. Drive receives the JSON data and readable Markdown report export in the same folder as the source media. Report edits must be synchronized to update that export.

Google Drive is the durable file store, Firestore is the cross-device index, and IndexedDB provides same-device recovery. Each can fail independently; a local success must not be presented as confirmation that every cloud destination has succeeded.

## PWA caching boundary

The Vite build emits `sw.js` with the build's public hashed assets and static app metadata. Navigation uses the network with the precached HTML shell as an offline fallback. `/api/`, Firebase auth helper paths, cross-origin requests, and user media are excluded. Cache cleanup only removes prior `baudoku-shell-*` caches. A waiting service worker activates when the user chooses to update, avoiding forced reloads while capturing.
