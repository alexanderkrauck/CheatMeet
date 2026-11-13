# Provider-neutral setup UI handoff

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
