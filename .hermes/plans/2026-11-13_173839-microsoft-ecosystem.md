# Microsoft Calendar and OneDrive meeting homes

Status: proposal only — no implementation, app registration, consent, deployment or data migration authorized by this document.
Prepared: 2026-11-13, Europe/Vienna. Inspected baseline: `4647e06`.

## 1. Proposed user-facing result

Support Microsoft personal accounts and Microsoft 365 work/school accounts alongside Google:

- Sign in with Microsoft without first obtaining a Google account. Existing Google users can connect Microsoft to their existing CheatMeet workspace.
- See Outlook/Microsoft 365 calendar meetings, their times, attendees and available Teams links; select an event for a recording.
- Choose a OneDrive folder as the default meeting home, with a per-meeting override before recording. OneDrive for Business and personal OneDrive are both in scope.
- Store the same independently readable archive: original audio, `einwilligung.md` where applicable, `transkript.md`, `zusammenfassung.md` and `bericht_daten.json`, plus the existing derived root index/schema equivalents.
- Optionally write the summary and archive link back into the selected Microsoft calendar event, subject to actual event permissions and explicit write-back opt-in.
- Keep Google Calendar and Google Drive working. Calendar and archive are independent choices: Google Calendar + OneDrive and Microsoft Calendar + Google Drive must both work.
- Restore, search, edit, retain/delete and expose authorized archived transcripts through MCP regardless of which archive provider holds a meeting.

A meeting home means one authoritative folder for that meeting's archive. Connecting Microsoft or changing the default does not move, copy or dual-write existing Google meetings. Existing meetings retain their original home.

Proposed first scope is Outlook calendars plus the user's own OneDrive. Shared SharePoint/Teams document libraries are a separate scope extension, not silently included or granted organization-wide access. Use drive/item references so that extension does not require another storage-model rewrite.

Not included: a Teams bot that joins calls, automatic import of Teams recordings/transcripts, Copilot integration, Exchange on-premises, Azure hosting migration, or replacing AssemblyAI/Gemini. Microsoft storage does not make the existing AI/hosting stack Microsoft-only.

## 2. What the repository currently assumes

| Area | Inspected current binding | Required change |
|---|---|---|
| Identity and connection | `src/pages/Login.tsx`, `src/lib/session.ts`, `server/googleAuth.ts`, `server/tokenStore.ts` | Separate Firebase workspace identity from connected service accounts; add Microsoft sign-in and a server-held Graph grant. |
| Calendar | `src/lib/calendar.ts`, `src/lib/calendarSync.ts`, `src/components/CalendarMatch.tsx` | Introduce a small shared event/calendar contract and retain Google behavior behind its adapter. |
| Archive and location | `src/types.ts`, `src/lib/drive.ts`, `src/lib/driveSettings.ts`, `src/lib/archive.ts`, `src/lib/workflow.ts` | Replace the assumption that every file ID and folder belongs to Google with explicit provider/connection references. |
| Durable processing | `server/processing/index.ts`, `server/processing/runtime.ts`, `server/processing/drive.ts`, `src/lib/pipeline.ts` | Resolve storage through the meeting's pinned home. Current worker configuration and identification require Google OAuth and cannot simply serve a Microsoft-only user. |
| Consent/retention | `shared/consent.ts`, `src/lib/retentionSweep.ts` | The notice currently literally names Google Drive; derive the actual storage service and route retention to that provider. |
| MCP | `server/mcp/meetings.ts`, `server/mcp/tools.ts`, MCP authorization/runtime consumers | Current transcript reader takes a Google subject and Drive file ID; resolve the authorized user's meeting home instead. |
| Security rules/settings | `firestore.rules`, settings consumers | Existing report index is transcript-free; settings currently allow only `summaryPrompt` and the Google folder shape. Add explicit, owner-scoped settings rules; keep token/cache collections server-only. |

This is more than adding a login button, but does not require a second processing engine or moving hosting away from Cloud Run.

## 3. Identity and Microsoft authorization

1. Retain Firebase `uid` as the stable workspace owner. Enable Firebase's documented `microsoft.com` sign-in provider. Linking from a signed-in Google account must preserve its UID, existing meetings and local workspace.
2. Never merge accounts merely because their email addresses match. Handle account-existing/different-credential errors through explicit authentication and account linking.
3. Use a Microsoft Entra application supporting organizational and personal accounts. Use a server-side authorization-code flow with PKCE, state, nonce and validated account identity for Graph access; recommend the supported MSAL Node library rather than inventing token protocol handling. This would be a new dependency, not something already installed.
4. Keep Microsoft refresh material/token cache on the server, scoped to Firebase owner + explicit connection ID. Preserve tenant/account identity and granted capabilities. Cache refresh updates must be atomic across workers.
5. App sign-in is not the same as permission to read/write OneDrive or Calendar. A Firebase refresh token is not a Microsoft Graph refresh token. The service grant must survive closing the browser so accepted jobs can finish.
6. Bind consent callbacks to the initiating workspace and connection; reject account-switch races. Existing Google grants need a compatibility lookup, not destructive recreation.
7. Revoked/expired Microsoft access pauses only operations using that connection. Do not sign the user out of CheatMeet, switch homes to Google, or lose draft data. Tenant consent restrictions, MFA/Conditional Access and missing OneDrive provisioning need distinct messages; these are not automatically fixable by retry.

### Permissions proposal

Request capabilities when enabled, not a blanket organization-wide grant:

| Capability | Proposed delegated permission |
|---|---|
| Sign-in/account identity | OIDC `openid profile email`; Graph `User.Read` only where the account/profile operation requires it. |
| Server-side continuation | `offline_access` for the server-owned Graph connection. |
| Calendar reading, including bodies needed for safe write-back | `Calendars.Read`; request `Calendars.ReadWrite` when write-back is enabled. |
| User-selected folder in the user's own OneDrive | `Files.ReadWrite`. |

**Important tradeoff:** `Files.ReadWrite` is broader than a chosen-folder-only permission. The app would constrain its own operations to the selected meeting home, but the granted credential is not confined to that folder. Do not describe this as equivalent to Google's existing `drive.file` boundary, and do not widen the Google scope.

A dedicated CheatMeet app folder is a narrower alternative using `Files.ReadWrite.AppFolder`, but it is not arbitrary folder selection. Its exact delegated account-type and resumable-upload behavior must be verified before choosing that alternative. Microsoft documentation contains broader app-folder guidance than some permission/API tables; do not silently fall back to broader scopes if a test fails. Recommended proposal for freely chosen meeting homes is `Files.ReadWrite`, disclosed explicitly.

No `Mail.Read`, contacts access, directory-wide access, application-wide SharePoint permission, or Copilot seat is part of this design. Organizational tenant policy can still require an administrator to approve otherwise delegated permissions.

## 4. Provider-aware meeting home and compatibility

Proposed logical records, not existing symbols:

- **Connection:** owner, provider, stable connection ID, verified service account/tenant, granted capabilities; secrets kept separately server-side.
- **Meeting home:** provider + connection ID + root/meeting-folder references. Microsoft references use both `driveId` and `itemId`; Google references keep their actual Drive IDs.
- **Artifacts:** typed references for audio, consent, transcript, summary and canonical JSON, plus provider revision metadata. An opaque OneDrive item ID must never be passed through a Google URL helper or interpreted as a URL.
- **Calendar link:** provider + connection ID + calendar ID + event ID + occurrence identity where applicable. Do not use bare provider-ambiguous event IDs.

Freeze the selected home for the recording before its consent notice is generated. Changing a default applies to future meetings only. Moving an existing archive is not part of the first implementation; a later move would require copy, verification and explicit authority before switching the reference or removing anything.

Keep archive content portable and explicit; do not serialize tokens, upload capabilities, server cache handles or an authority to select another user's connection. Continue constructing restored content explicitly. Add a versioned schema when necessary and keep v0/v1 archives readable. Legacy fields such as `rawAudioUrl` remain readable as Google references only through a well-defined compatibility mapping.

**Cached-client safety is a release requirement.** Today's Google-only clients can fall back to a Google folder when Microsoft references are absent. They must not receive Microsoft records and then silently export them to Google. Recommended additive rollout: a versioned index/local namespace for new provider-aware records, read alongside the legacy Google index by new clients; one authoritative index record per meeting, no dual-write copies. Legacy job-list consumers must not hydrate Microsoft jobs into Google-only local records. Finalize this read/write compatibility boundary before enabling Microsoft homes, and prove it with the actual old build.

## 5. OneDrive archive and upload behavior

- Keep a small archive/storage contract with Google and Microsoft adapters, not a plugin framework. Cover folder resolution, artifact read/write, revisions, audio upload/download, restoration, retention and human-visible links.
- Use Microsoft Graph item IDs rather than paths as persisted identity. Do not lowercase or otherwise normalize opaque IDs. Folder names remain presentation, not identity.
- Read/write small archive text through Graph. Use resumable upload sessions for recording audio; Microsoft simple upload supports only up to 250 MB, below an actual 471 MB recording already encountered here.
- Upload chunks directly from the browser to OneDrive. Resume from the provider's `nextExpectedRanges`; obey the sequential-fragment and fragment-size requirements. An expired session may require a fresh upload, not a claim that the bytes are already safe.
- Keep sensitive upload-session URLs in owner-bound, server-only state; the draft may keep an opaque session handle. Return capabilities only to the authenticated owner as needed for direct upload. Never put them in archive JSON, the public report index, MCP output, logs or URLs shown in UI.
- Verify the finalized item's identity/size before acknowledging the durable audio checkpoint. Preserve the existing local journal until the complete source and server job are accepted.
- For authoritative JSON updates, use a provider-supported conditional revision operation and test actual stale-write rejection. Upload sessions document `If-Match`; do not assume every Graph content endpoint enforces it identically. If the chosen path lacks a safe precondition, stop instead of replacing newer content.
- Folder selection does not grant sharing permissions. Do not create anonymous links or change ACLs. A selected existing folder may already be shared; do not claim it is private without evidence.
- The worker reads OneDrive audio by validated owner/connection/item references and streams it through the existing ASR upload path. Do not hand Graph credentials or preauthenticated storage URLs to the transcription provider.
- Preserve existing ASR reservations by owner + meeting ID. Changing storage providers must never create a new paid-submission identity for the same meeting.

## 6. Microsoft Calendar behavior

- List selected calendars and use `calendarView` for date ranges, including recurring occurrences/exceptions. Follow pagination and disclose any existing application result budget rather than silently truncating.
- Normalize timestamps for the existing calendar UI, including all-day events and daylight-saving boundaries. Display Vienna local time for Alexander; do not treat a date without a time as a midnight meeting.
- Request Outlook immutable event IDs consistently. They remain stable within the same mailbox, not across archive-mailbox moves or export/reimport.
- Map subjects, attendee names, cancellation state, available Teams links and actual calendar write capability into the common model. A calendar entry with a Teams link does not authorize joining or reading a Teams transcript.
- Optional write-back updates only CheatMeet's bounded block in the existing event body. Preserve HTML, organizer text and the Teams meeting blob; Microsoft's documentation warns that removing it can disable the online meeting.
- Do not modify attendees, times or recurrence as a side effect of adding a summary. Do not create a replacement event when an existing event is read-only or missing. Event creation stays an explicit user action.
- Calendar write-back can have notification/organizer-side effects, especially with recurring meetings; do not promise silent updates. Verify behavior with disposable test events and make unsupported cases a nonfatal warning after the archive is safe.
- A calendar permission failure must not fail an otherwise successful archive or restart ASR/summary generation.

## 7. Implementation order and acceptance

These are engineering checkpoints in one implementation, not requests for separate approval rounds. Nothing starts until implementation is authorized.

| Checkpoint | Concrete outcome and principal files |
|---|---|
| Identity and connection | Microsoft sign-in/linking and server-held Graph grant; `src/pages/Login.tsx`, `src/pages/ConnectPage.tsx`, `src/lib/session.ts`, `server/googleAuth.ts` identity boundary, `server/tokenStore.ts`, plus proposed `server/microsoftAuth.ts` and a narrow connection store. |
| Data/compatibility | Typed home/calendar/artifact references and the legacy mapping; `src/types.ts`, `src/lib/archive.ts`, `src/lib/reportProjection.ts`, `src/lib/local.ts`, `src/lib/reports.ts`, `firestore.rules`, and `shared/processing.ts`. Prove cached old builds cannot reroute Microsoft data to Google. |
| Archive adapter | OneDrive folder selection, upload sessions, export/restore and provider-aware storage settings; current `src/lib/drive.ts`, `driveSettings.ts`, `workflow.ts` consumers and proposed Microsoft storage modules. Reuse existing archive filenames. |
| Calendar adapter | Outlook events and optional safe write-back; `src/lib/calendar.ts`, `calendarSync.ts`, `CalendarMatch.tsx`, record/report/calendar settings surfaces and proposed Microsoft calendar module. |
| Worker and remaining consumers | `server/processing/index.ts`, `runtime.ts`, `drive.ts` adapter boundary, `server/transcription.ts`, `src/lib/pipeline.ts`, MCP readers/authorization, `shared/consent.ts`, retention and storage cleanup. Job readiness must no longer depend unconditionally on a Google client secret. |
| Deployment and live acceptance | Entra/Firebase setup, callback registration, Secret Manager references, GitHub deployment settings, docs and smoke checks. Deploy through the existing candidate/smoke/promotion flow only after the provider matrix passes. |

Required verification:

1. Google-only regression; Microsoft-only sign-in + Outlook + OneDrive; Google sign-in with connected Microsoft; both mixed calendar/storage combinations. Test organizational and personal Microsoft accounts separately.
2. Link Microsoft to the existing Google workspace and verify the same UID, existing archive and account isolation. Test a mid-upload account switch and cross-owner connection/reference rejection.
3. Small and large real OneDrive uploads, interrupted network, reload/resume, uncertain completion and expired session. Read back the exact files; show no duplicate audio or paid transcription.
4. Close the tab after source/job acceptance; prove Cloud Tasks finishes Microsoft-backed processing and a fresh browser restores it. Test Microsoft revocation, throttling/Retry-After, quota failure and a real concurrent archive edit.
5. Verify the selected storage service in the frozen consent record and retention deletion routed to the correct provider only. Provider failure must not be mislabeled as data loss or fixed by silently choosing Google.
6. Verify archived transcript MCP reads/search across both providers with existing read-only authorization; assistants receive no service credentials.
7. Outlook recurrence, all-day events, Vienna DST, moved event IDs, HTML/Teams body preservation and read-only events. Inspect actual write-back effects, not only an HTTP 200.
8. Run the maintained TypeScript, Vitest, PWA/build and Python deployment checks, plus narrowly targeted new regressions. Keep real-data acceptance separate from mocks.

## 8. External prerequisites and planning limits

Implementation would need an Entra app registration with the intended account types, Firebase Microsoft provider configuration, registered Firebase and server callbacks, server-held credentials and any required tenant consent. No account/configuration inspection or changes were performed for this plan, so existing Microsoft app registration, tenant policy, licenses and access are unknown.

No new hosting platform, queue or paid AI product is proposed. Existing AI usage and storage quota still apply; this document is not a hosting-price estimate.

The scope choices to confirm before building are the broader permission for arbitrary OneDrive folders versus an app-folder-only design, and whether shared SharePoint/Teams libraries should be included rather than left outside this first scope.

## 9. Sources checked

- Firebase Microsoft sign-in and linking: https://firebase.google.com/docs/auth/web/microsoft-oauth
- Microsoft authorization-code/OIDC/PKCE and offline access: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- Graph resumable uploads, permissions, ranges and conditional headers: https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0
- Graph simple-upload size limit: https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0
- App-folder behavior and permission tradeoff: https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder
- Calendar occurrences and time ranges: https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0
- Outlook immutable identifiers: https://learn.microsoft.com/en-us/graph/outlook-immutable-id
- Event body/online-meeting and notification cautions: https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0
