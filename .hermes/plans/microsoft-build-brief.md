# Microsoft implementation — binding build brief

User mandate: "build it end to end." Approved proposal: `.hermes/plans/2026-11-13_173839-microsoft-ecosystem.md`. Baseline main `4647e06`, 1,003 tests previously green. End-to-end includes deployment and real acceptance, not a stub. Tenant choice is unanswered; parent owns external setup and must not create app in PF Fachkraft by default. No child may access browsers, live user data, cloud/tenant APIs, secrets, other repos, skills or memory; no commits/push/deploy. Every terminal explicit workdir `/Users/alexanderkrauck/Coding/CheatMeet`; no global cd/export/HOME/CLI config changes and no stash/reset/checkout.

## Shared contracts (already defined)

`shared/storage.ts` owns `ServiceProvider = 'google'|'microsoft'` and `MicrosoftHome`: `{provider:'microsoft',connectionId,driveId,rootId,rootName,folderId?,reportId?,audioId?,markdownId?,transcriptId?,consentId?,webUrl?,syncedAt?}`. Home exists ONLY for Microsoft. Google retains existing fields and legacy archive versions. `ReportData.home?: MicrosoftHome`, `calendarProvider?:ServiceProvider`, `calendarConnectionId?:string` added by parent. Never put OneDrive IDs in rawAudioUrl/driveFolderId/driveReportId. Main authority: home on report, not mutable default.

Microsoft records: Firestore `users/{uid}/meetings/{id}` (new, same transcript-free projection), Google legacy `users/{uid}/reports/{id}`. New app reads both, never dual-writes a meeting. Microsoft local report/draft/active-draft/chunk namespaces must not be visible to cached Google-only clients. Parent filters Microsoft processing jobs for old API clients: new client sends `X-CheatMeet-Storage: microsoft` on list/get/submit. Parent owns shared/storage.ts, server processing/MCP, Firestore rules, server.ts, dependencies, deployment, docs.

## Server auth lane exports (implement these exactly)

New `server/microsoftAuth.ts`:
- `microsoftConfigured():boolean` using MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / optional MICROSOFT_AUTHORITY (default https://login.microsoftonline.com/common), MICROSOFT_PUBLIC_URL for fixed origin/callback.
- `firebaseAccountFor(token:string, projectId?:string):Promise<{uid:string;googleSub:string}>` validates Firebase token regardless of sign-in provider. googleSub empty when absent.
- `getMicrosoftAccess(owner:string, connectionId?:string):Promise<{accessToken:string;expiresInSeconds:number;connectionId:string;accountName:string;calendar:boolean}>` owner-scoped server-held token cache.
- `listMicrosoftConnections(owner:string):Promise<Array<{connectionId:string;accountName:string;calendar:boolean}>>` safe metadata only.
- `createMicrosoftAuthRouter(options?:injection-options):express.Router` mounted by parent at `/api`.
Routes: GET `/microsoft/config` -> `{configured:boolean}`; authenticated GET `/microsoft/connections` -> `{connections:[...]}`; authenticated POST `/microsoft/connect` JSON `{calendar?:boolean}` -> `{url:string}`; callback GET `/auth/microsoft/callback` opens same-origin popup message `{source:'cheatmeet-microsoft-oauth',connected:true}` or safe German error, no credentials; authenticated POST `/microsoft/token` JSON `{connectionId?:string}` -> access response above; authenticated POST `/microsoft/disconnect` JSON `{connectionId:string}` removes that owner's exact local app grant (do not globally revoke Microsoft). Use delegated Files.ReadWrite + offline_access + OIDC; calendar optional Calendars.ReadWrite opt-in. Firebase Microsoft sign-in is separate frontend popup, configured externally by parent.
Use MSAL Node (parent installing dependency), persisted token cache through existing DocStore, server-only production Firestore, private dev files, CSRF+state+nonce+PKCE/account binding, single-use callback state. Refresh/cache races must not resurrect disconnected grants. No raw OAuth errors/token logging. Testable injected stores/provider calls, bounded request timeouts. No response ever contains refresh/cache secrets.

## Client lane exports (implement these exactly)

New `src/lib/microsoft.ts`:
- `microsoftRequest(path:string, init?:RequestInit, connectionId?:string):Promise<Response>` supplies Graph bearer for a pinned Firebase owner, only permits Graph v1.0 relative paths/same Graph nextLink; returns Response, throws German Error with `.status` on non-ok. No arbitrary-host token forwarding. UID check before/after await.
- `ensureMicrosoftToken(connectionId?:string):Promise<{accessToken:string;connectionId:string}>`.
- `connectMicrosoft(calendar?:boolean):Promise<void>` opens popup synchronously, obtains authenticated /microsoft/connect URL, same-origin/source checked completion and owner race guards.
- `loadMicrosoftConnections():Promise<Array<{connectionId:string;accountName:string;calendar:boolean}>>`.
New `src/lib/providerSettings.ts`:
- `savedCalendarProvider():ServiceProvider` sync owner-keyed local getter default google; `saveCalendarProvider(provider:ServiceProvider):Promise<void>` persisted across devices in settings/provider document with owner pinning.
- `savedMeetingHome():MicrosoftHome|null`, `loadMeetingHome():Promise<MicrosoftHome|null>`, `saveMeetingHome(home:MicrosoftHome|null):Promise<void>`; null Google default (does not migrate old reports). Dispatch `cheatmeet:provider-settings` on change.
- `hasMicrosoftCalendar():boolean` sync, owner-scoped safe connection metadata cache, client updates it after list/connect; no stale data across owner changes.
Optional refresh/read helpers allowed but preserve these binding exports.

Calendar lane may import these before client lane finishes. Calendar lane may add metadata fields to CalendarEvent, not ReportData (already updated). Its `getEvent(calendarId,id,provider?,connectionId?)` signature extends current compatibly; `updateEventDescription` accepts provider/connectionId/bodyType/etag optionally in event object. Export `hasAnyCalendarGrant():boolean`, preserving original Google behavior and incorporating Microsoft preference/connection. `eventsBetween/eventsAround` read chosen provider. `syncReportToCalendar` must use report's pinned calendar provider for linked events, not current default. Return calendarProvider/ConnectionId on new event creation. Parent server handles worker calendar via new pure shared helpers when available; lane writes exact handoff of provider payload semantics.

## Ownership

AUTH: NEW server/microsoftAuth.ts, NEW server/microsoftAuth.test.ts, NEW server/microsoftTokens.ts and its tests if helpful, `.hermes/plans/microsoft-auth-handoff.md` only.
CALENDAR: src/lib/calendar.ts, calendar.test.ts, calendarSync.ts, calendarSync.test.ts, useCalendarEvents.ts; src/pages/CalendarPage.tsx, src/components/CalendarMatch.tsx; NEW src/lib/microsoftCalendar.ts and test; NEW shared/microsoftCalendar.ts and test if helpful; `.hermes/plans/microsoft-calendar-handoff.md` only. Do not touch calendarQuery tests unless an actual changed contract requires it; report proposed change.
CLIENT/STORAGE: ALL other `src/**` except calendar lane list above; shared/consent.ts and shared/consent.test.ts if existing (verify), new related tests under src; `.hermes/plans/microsoft-client-handoff.md`. Parent already added ReportData fields; preserve them. Parent owns `shared/storage.ts`. Client owns no server files, package/lockfiles, firestore.rules. No replacing legacy Drive implementation wholesale: route Microsoft explicitly and preserve Google.
PARENT: all other files, runtime interfaces, server processing, MCP, security rules, dependencies and deployment. Parent will integrate seams rather than make parallel edits inside client/calendar ownership.

## Verification and durable progress

Load test-driven-development. Use vertical RED/GREEN behavior slices, retain actual failing output in handoff. Run focused `npx vitest run <exact owned tests>` and `npm run lint` after each coherent group. Whole-tree lint can temporarily fail on another lane's unfinished imports; identify exact external errors, don't edit their files. Existing baseline 1,003 tests. No known accepted failures. Do not build a large new framework or enormous test suite. Protect owner isolation, no double-paid ASR, consent-before-capture, archive edit revisions and Google compatibility. Save handoff after EACH completed milestone (not only final). Include exact exports, tests actually run and remaining acceptance gaps. Complete runnable code rather than a design report.
