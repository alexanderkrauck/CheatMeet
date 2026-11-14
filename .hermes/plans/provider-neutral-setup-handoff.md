# Provider-neutral setup UI handoff

## Parent release and live acceptance
**Resolved post-acceptance blocker:** after acceptance and deployment, fresh direct settings reads returned429 `RESOURCE_EXHAUSTED / Quota exceeded`, and the actual signed-in runtime connection endpoint returned503. Monitoring confirmed the fixed `ReadOperationsPerProjectPerDay` limit. Full Pacific-day read counters:1,471 LOOKUP,81 NOT_FOUND,48,649 PIPELINE. Complete last12h CloudRun logs:4,799 GET processing requests,4,521 list requests;2,462 HTTP304 responses still performed the owner query. The source's unconditional five-second observer reloaded terminal job history even while idle/hidden. Subsequently fixed and deployed as documented below.

The exact named database was Enterprise, `freeTier:false,freeTierLimited:true`; project billing was already enabled. Firebase Console explicitly labelled it `AI SHARED QUOTA` and offered `Upgrade database` to move just this database to pay-as-you-go. A safe attempted100,000/day consumer override was rejected as a fixed limit, with no quota change. Alexander subsequently approved the scoped pay-as-you-go conversion with “do it then” after receiving pricing and cutoff explanations. Completed the exact database's Firebase Console confirmation; readback clears `freeTierLimited`, while the separate DriveSyncNotes database remains free-tier-limited. After propagation, actual signed-in settings reads and the runtime connection endpoint both returned200, one Microsoft connection remained, and exact saved Drive/provider/preferences versions still match the original baseline.

The read-amplification fix is deployed as `b9e5c9a4b2b60a3e2dc8aefc854b499df200a633`, Actions `43490599179`, Cloud Run revision `cheatmeet-gh-b9e5c9a4b2b6-43490599179-1` at100% traffic. Parent reran lint, full1,146 tests, build, five PWA cases and17 deployment-config cases; npm/Bun/container/deploy CI passed. Visible-idle observer cadence is five minutes, active five seconds; hidden observers pause. Per-instance owner metadata cache coalesces old-client requests, with60s idle/5s active TTL and per-request auth/provider filtering. No durable stores, reservation identities or user archives changed. Configuration-only health flags are not a substitute for actual database reads.

Billing alert completed after the scoped-access correction: billing-account-wide budget list returned403, but `budgets.list?scope=projects/107228250814` succeeds with project-owner permissions. It revealed an existing10EUR whole-project monthly budget, which was preserved exactly. Created and read back `billingAccounts/011F35-894D98-D8CBE9/budgets/1e47e01f-778b-4666-816d-a35f54e42117`, a1EUR monthly alert filtered to this project and Cloud Firestore (`services/EE2C-7FAC-5E08`), current-spend thresholds50/80/100%, excluding credits so promotional credits do not hide underlying costs. Notifications go to project-level recipients; default billing-account recipients are disabled. No spend cap, shutdown action or IAM changes. This service filter includes Firestore in this project, not a database-ID filter. Earlier claim that no alerts existed was incorrect: the existing10EUR alert already covered the project.

- Initial code release `460250352c0a0dd7c6835cab95f398354c0727ab`; Actions `43483809915` passed npm, Bun, container, build/PWA and deployment. Cloud Run revision `cheatmeet-gh-460250352c0a-43483809915-1` initially served100% of traffic.
- Final suite: 88 files / 1,142 tests. Live desktop/mobile login has equal provider buttons. Real settings show symmetric identity links and separate storage/calendar setup; Google disconnect belongs to the actual Drive connection, not identity.
- Walked the deployed four-step setup, skipped calendar changes and finished. Exact Firestore Drive/provider/preferences versions before and after were identical.
- Signed out and used the actual Microsoft sign-in button. The resulting Firebase token identifies `microsoft.com`, preserves the exact original Google workspace UID and both identity links, goes to `/dashboard` rather than new-user setup, and still exposes the original 60 meetings.
- Real progress.works account/grant verified against tenant and object ID; actual scopes include Files.ReadWrite and Calendars.ReadWrite. OneDrive Business folder browsing and 384,044-byte two-fragment upload/resume/readback succeeded; native conditional text update returned 200, and reusing its stale ETag returned 412.
- Disposable synthetic meeting `af671ce2-1ebf-46e2-96c2-22cbb18a6f9c`: production worker accepted the job, initiating tab closed, actual Gemini summary and v2 OneDrive JSON/Markdown read back. Final calendar retry completed with no warning, wrote the summary, retained original paragraph and real Teams meeting details. Synthetic transcript remained exact.
- Real pre-Microsoft cached client stayed at 60 reports, did not expose the fixture; it existed only in the new Microsoft local namespace. Legacy API access to its processing job returned 404.
- Removed the exact test event, trashed its own OneDrive test root, and removed its three upload records, completed job, meeting index and one local report. All external deletion targets read back 404; local key readback was empty. User identity links, provider grants and original settings remain intact; private browser acceptance instrumentation was removed.
- Live-provider checks exercised Microsoft 365 Business, not a separate personal Microsoft account or the complete mixed-provider runtime matrix. Personal-account and mixed routing coverage remains protocol/unit evidence, not a claim of live acceptance.

## Outcome / exact parent seams
- Login now calls `session.signInGoogle(): Promise<void>` or existing `signInMicrosoft()`, never the Google data-grant API. Identical button classes/size and exact labels `Mit Google anmelden` / `Mit Microsoft anmelden`.
- Account settings call `session.linkGoogleIdentity(): Promise<void>` and existing `linkMicrosoftIdentity()` explicitly; Google revoke is conditional on a linked Google identity, not shown to Microsoft-only users.
- Default export `ConnectionSetup({ onComplete?: () => void } = {})` is ready for parent `/setup` route. Finish calls supplied callback, otherwise `navigate('/')`.
- Parent retains ownership of new-user detection/owner-scoped pending marker and routing. No setup persistence/Firestore fields were added by this lane. Parent wrapper may clear only its new-user marker and navigate('/dashboard').
- Settings re-entry is `<Link to="/setup">` and does not flag existing accounts for setup.

## Implementation / compatibility
- Four explicit steps: identify current account; equally sized Google Drive/OneDrive cards; independent optional Google/Outlook calendar connection and selection; finish.
- Setup hydration reads current provider settings; render never writes defaults. Existing OneDrive home and calendar selection are preserved unless explicitly changed. Skipping calendar saves nothing. Reopening does not migrate data.
- Storage default selection is separate from connection/folder browsing. Google uses `saveMeetingHome(null)` only through its explicit default button after obtaining the real grant; owner is pinned around the async authorization. Microsoft uses existing folder selection/save APIs.
- Both calendar connect buttons disclose that the current authorization APIs also include provider file access. Connecting does not select a default; explicit calendar selection requires actual known calendar permission.
- `MicrosoftSettings` keeps existing `meetingOnly`, `onSelect`, `value` semantics and recording's Google-choice/folder controls. Adds optional `storageOnly`, `onSaved`, `defaultSelectionDisabled`; setup/settings suppress embedded identity/calendar controls. Restore actions remain for both providers.
- Existing grants, UID, archive fields, indexed records and retention are untouched. No identity-derived storage/calendar defaults.
- Responsive equal-provider cards and symmetric login spacing added to owned index.css.

## RED / GREEN evidence
- RED: focused command failed with missing ConnectionSetup implementation; existing InstallApp test stayed green.
- GREEN: `npx vitest run src/components/ConnectionSetup.test.tsx src/components/InstallApp.test.tsx` passed 2 files / 7 tests (6 setup cases + existing installation case).
- Setup tests exercise actual component handlers via a small state/effect harness (no DOM dependency): existing account/no writes, equal storage/existing OneDrive preservation, optional calendar skip, parent callback/default navigation, mixed-provider calendar choice without storage changes, connection failure without saving defaults.
- `npm run lint` passed after integration with parent identity exports.
- Full `npm test` passed 88 files / 1139 tests in the shared working tree (baseline 1129; includes concurrent parent additions).
- Final focused tests/lint and `git diff --check` passed again after the Google default-selection owner guard.

## Files owned / modified
- src/pages/Login.tsx
- src/pages/SettingsPage.tsx
- src/components/DriveSettings.tsx
- src/components/MicrosoftSettings.tsx
- src/components/ConnectionSetup.tsx (new)
- src/components/ConnectionSetup.test.tsx (new)
- src/index.css
- This handoff file.

## Remaining gaps / constraints
- No browser/cloud/live-record/secret operations, commits, deployments, skills/memory writes or other-repository changes in this lane.
- Parent must mount `/setup` and own new-user routing/marker clearing; no route edits performed here.
- Real OAuth/provider acceptance and visual/browser acceptance are not established by these unit tests; parent owns that lane.
- Existing authorization APIs bundle file/calendar grant surfaces as documented; no new calendar-only permission API invented.
- Users may retain their existing storage default and connect missing services later; setup does not force migration or claim missing grants were verified.
