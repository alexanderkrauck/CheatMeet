# Microsoft client progress

## FINAL HANDOFF — client ownership released
Client scope is landed in the shared working tree; no commits, push, deployment, browser/cloud/account/secret operations performed by this lane. No further client edits are in flight.

**Final verification:** `npx vitest run src shared/consent.test.ts` → **61 files, 758 tests passed**. `npm run lint` → passed. `git diff --check -- src shared/consent.ts` → passed. This includes the concurrent calendar lane tests; no calendar-owned files were edited by this lane. Earlier transient lint failures from the uploads lane's missing module resolved by the final run.

**Delivered:** Microsoft Firebase sign-in + explicit identity linking; separate server-held Graph connection/popup/token APIs; owner-scoped connection metadata and Firestore `settings/providers`; OneDrive folder navigation/default and per-meeting selection; home frozen before arming/consent and import, no fallback to Google; actual OneDrive consent wording preserved through server normalisation; owner-bound resumable audio handle/checkpoints; conditional archive JSON/text export, root index/schema, restore/download/edit/delete/retention; new Microsoft local and Firestore namespaces; pipeline correct credential/home refs + new-consumer processing header; provider-aware Login/Connect/settings/record/report/dashboard/shared actions.

**Final parent feedback fixed:**
- `connectMicrosoft` does not reject when a successfully authenticated popup closes while connections metadata is still loading; owner watcher and timeout remain.
- Graph/API/direct-upload throttling errors expose `retryAfterMs`; processing observer respects that delay.
- `deferCommit:true` update final fragment may return **202 + `nextExpectedRanges: []`** (or offset==size); client reaches `/uploads/complete` without claiming durability. Empty remaining ranges on session resume also proceed directly to complete. A non-OK complete (including 409) never becomes successful audio/archive checkpoint. Tested both final-202 success and complete-409 rejection.
- Google root index explicitly excludes Microsoft meetings; Microsoft root index is `cheatmeet.index/2` with explicit home refs. Google v0/v1 unchanged.
- Inspected parent's actual 390px screenshot: fixed install banner hid Microsoft sign-in. `InstallApp` now takes explicit `signedIn` from App and returns no banner for signed-out Login/Connect. RED/GREEN SSR regression covers both signed-out routes and signed-in install availability. **Parent must repeat actual 390px built-UI screenshot acceptance; this lane did not open a browser or manufacture a replacement screenshot.**

**Exact remaining integration/runtime seams (parent-owned):**
1. Upload backend lane sa-0-79381f99 must implement the three endpoint shapes below. Client is ready for deferred conditional commit. Verify Graph CORS, exact finalize response `{id,size,eTag,...}`, expiration/throttling, and resumed uncertain completion with real personal/business OneDrive; no live acceptance was attempted here.
2. Canonical JSON updates deliberately refuse unknown/changed browser ETag, before touching derivative text. After worker completion on another device or cleared browser metadata, **explicit “Aus OneDrive wiederherstellen” is needed before editing**. This safe stop is intentional, not an automatic Google fallback. Parent may improve revision propagation later without weakening preconditions.
3. Audio handles are persisted; small text-upload handles are not. If canonical JSON physically commits but its completion response/checkpoint is lost, retries detect the same-name file and refuse differing generated timestamps rather than overwriting it. Root/per-report restore provides recovery; fully automatic recovery of this narrow text-write uncertainty is not implemented.
4. Parent owns final build/PWA/full-server verification, actual old-build isolation acceptance, Microsoft identity/grant matrix, worker tab-close completion and real concurrent-edit acceptance. Local client regression is green; this handoff is not a claim of real Graph or production acceptance.

**New client files:** `src/lib/{microsoft,providerSettings,onedrive,microsoftWorkflow,microsoftIdentity}.ts` and corresponding tests; `archive.microsoft.test.ts`, `consent.microsoft.test.ts`, `storageConsumers.microsoft.test.ts`; `src/components/MicrosoftSettings.tsx`, `InstallApp.test.tsx`.
**Changed existing client surfaces:** App/types; Login/ConnectPage/RecordPage/ReportPage/SettingsPage/Dashboard; InstallApp/AppLayout/UI/MeetingRow/DeleteMeeting/ConsentRecordPanel/McpClients; workflow/local/reports/archive/archiveDrive/archiveIndex/consentDraft/session/pipeline/serverProcessing/retention/retentionSweep/deleteReport/markdown/meetingMeta/assignEvent plus focused existing tests. Shared change: `shared/consent.ts` only. Parent fields in ReportData preserved.

---
Historical milestone notes follow.


## Milestone 1 GREEN (completed)
- Binding Microsoft client and provider settings exports implemented. OneDrive resumable adapter stores only server handle in Draft; sequential direct chunks omit bearer; verifies finalized size via server. Graph and API calls pin owner.
- `microsoftWorkflow.ts` handles consent-before-audio, checkpointed explicit home artifact refs, JSON/text exports, restoration, derived root index/schema. `workflow.ts` explicitly routes Microsoft without Google fallback. Pipeline uses Microsoft credential, refuses browser AI fallback, sends home source refs; all processing API requests opt in with `X-CheatMeet-Storage: microsoft`.
- Archive v2 Microsoft restore binds caller-selected connection; Google v0/v1 unchanged. Draft adds `microsoftUploadHandle` only.
- REDs observed: new modules absent; Microsoft archive version expected 2 received 1; pipeline test showed Google credential requested for Microsoft. All now GREEN.
- Verification: `npx vitest run src/lib/microsoft.test.ts src/lib/providerSettings.test.ts src/lib/onedrive.test.ts src/lib/microsoftWorkflow.test.ts src/lib/workflow.test.ts src/lib/archive.microsoft.test.ts src/lib/archive.test.ts src/lib/archiveIndex.test.ts src/lib/pipeline.test.ts src/lib/serverProcessing.test.ts` -> 10 files / 66 tests passed. `npm run lint` -> passed. Earlier lint transient failures were concurrent auth/calendar/parent missing modules, now resolved.


## Parent interface needed now
Proposal requires resumable upload session capability URLs never persisted browser-side. Client will use owner-authenticated Microsoft endpoints:
- POST `/api/microsoft/uploads` `{connectionId,driveId,parentId,name,size,reportId,itemId?,etag?}` -> `{handle:string}`; server creates Graph session, retains uploadUrl in owner-only server state, explicit `fail` conflict behavior, If-Match when updating.
- POST `/api/microsoft/uploads/session` `{handle}` -> `{uploadUrl:string,nextExpectedRanges:string[],expirationDateTime:string}`; capability returned only authenticated exact owner, for direct sequential browser PUT. Client stores handle only in draft, never URL.
- POST `/api/microsoft/uploads/complete` `{handle}` -> `{id,size,eTag?,webUrl?}`; server verifies finalized item identity/size and exact drive/parent binding (can resolve deterministic name after uncertain last PUT). No Graph credential forwarded to uploadUrl.
This is also used for conditional canonical JSON updates (fresh session + If-Match), not unsafe content PUT replacement.
If parent prefers alternate exact shape, update this handoff; client will implement this contract now. No Microsoft local AI fallback on unconfigured server; explicit error preserves draft.

## Milestone 2 GREEN / UI consumers in progress
- Local Microsoft reports/drafts/active-pointer/progress/chunks now use `uid:microsoft:*`, invisible to Google-only cached clients. New app combines both. Capture passes explicit namespace flag and freezes selected home while armed/recording. Microsoft imports clear previous artifact IDs.
- New Microsoft Firestore writes ONLY `users/uid/meetings`; new reader subscribes both. Provider settings corrected per parent to `settings/providers` (calendarProvider, meetingHome only), connection metadata local only.
- Shared consent supports actual Microsoft OneDrive service; template bumped to 3; Google-only rephrasing rejected for Microsoft. Retention/delete routes explicit home refs, not Google IDs.
- Microsoft Firebase identity sign-in and explicit link helper; never merge by email. Login/ConnectPage buttons wired. Settings and new MicrosoftSettings support connection, optional Outlook scope, folder navigation/home selection and root restore. RecordPage home selection/freezing/preflight/import/save path wired. ReportPage/MeetingRow/DeleteMeeting now provider-aware (remaining UI polish/restore/consumer audit in progress).
- REDs: old namespaces visible to old clients; Firestore wrote reports not meetings; notice incorrectly said Google; capture setter absent; Microsoft retention didn't call OneDrive. GREEN: focused 11 files / 242 tests passed; `npm run lint` initially one owned ReportPage call signature, fixed; rerun pending.

## Milestone 3 / parent feedback
- Parent popup race fixed with RED/GREEN: valid same-origin/exact-popup success stops interpreting popup closure as cancellation while metadata loads; owner watcher + timeout remain active. `microsoftApi` and Graph request expose `status` / `retryAfterMs` (Retry-After seconds or date); direct upload failures carry it and pipeline observer respects it.
- Reload after uncertain final PUT first probes `/uploads/complete` with the opaque handle; HTTP 409 means still in progress (then inspect `/uploads/session`), 404/410 can inspect expired state, other failures stay failures. Completed result returns directly without creating a duplicate session. Parent should return 409 for a not-yet-finalized known upload.
- Added owner-scoped ETag metadata on downloads/finalized uploads; canonical JSON replacement refuses unknown/changed revision rather than replacing another edit. Actual upload session still sends If-Match via parent endpoint. Per-report restore action in ReportPage refreshes the full archive/revision; dirty local edits are never silently replaced.
- Root restore now uses mergeRestoredReport and skips dirty edits, rather than overwriting. Report metadata carries Microsoft home/calendar binding through dashboard rows and deletion actions. Shared CalendarStatus/assignEvent use provider-aware calendar grants; Markdown archive folder link uses explicit home.
- Most recent focused run: `npx vitest run src/lib/microsoft.test.ts src/lib/onedrive.test.ts src/lib/assignEvent.test.ts src/lib/microsoftWorkflow.test.ts` -> 4 files / 22 tests passed; lint passed. Previous full client/shared run 60 files / 746 tests passed + lint. UI finishing audit continues.

## Remaining
- Finish consumer wording/UI smoke and broader src regression. Upload backend implementation/real conditional precondition acceptance remains parent-owned, no live acceptance attempted. Need stale-session recovery UI, canonical preflight before text derivative writes, and final retry/recovery audit.
