# Calendar lane progressive handoff

## FINAL local delivery
- Runnable integration complete in CALENDAR-owned files. Latest focused run: **6 files / 54 tests passed**; latest `npm run lint`: **passed**; owned tracked diff whitespace check: **passed**. Whole repository `npx vitest run`: **83 files / 1087 tests passed** (then one extra final owner check added; focused/lint re-run clean).
- Created: shared/microsoftCalendar.ts + .test.ts, src/lib/microsoftCalendar.ts + .test.ts, src/lib/useCalendarEvents.test.ts, this handoff. Modified: src/lib/calendar.ts + .test.ts, calendarSync.ts + .test.ts, useCalendarEvents.ts, src/components/CalendarMatch.tsx. CalendarPage.tsx unchanged: already uses the upgraded shared feed. calendarQuery.test.ts unchanged and green. No other lane files edited.
- No browser, cloud/tenant, credentials, live user records, external writes, commits, pushes, deployment, skills or memory edits. Temporary whole-tree lint failures from concurrent lanes are now resolved.
- Parent/client integration actions below still apply: persist event provider+connection on assignment/archive/index, transport these in recording URLs, replace Google-only UI/assign gates, provider-scope dedupe keys. No default Calendar connection preference was specified: Outlook calendar default is first cached calendar-enabled connection, independent of meeting home; existing linked report always uses its exact connection. Real personal/work Graph acceptance and permission rollout remain parent-owned.


**Parent-ready now:** `shared/microsoftCalendar.ts` exports `mergeMicrosoftBody(existing:string, block:string, bodyType:'text'|'html'):string`. ZERO imports (including no type imports); worker can import directly. Use current Graph `body.content` and matching lowercase `body.contentType`, patch ONLY `{body:{contentType:originalType,content:merged}}` with `If-Match` from current `@odata.etag` (or response ETag); 412 is retryable conflict, not deletion. Preserve all other event fields. Closed HTML paragraph/text marker blocks only; incomplete block appends rather than guessing. No client contract mismatch so far.

## Milestone 6 — account and merge hardening
- Whole Graph operations now pin Firebase owner across token lookup, every pagination request, body JSON parsing and all-day re-read; report sync also checks owner between linked-event lookup and patch. Missing calendarConnectionId on linked Microsoft report refuses rather than redirects to default.
- Closed-block merge now chooses last closed opener so an older orphan marker cannot swallow organizer text before a subsequent valid block.
- RED: pagination owner test reached a second request after account switch; sync owner test incorrectly patched; missing connection test resolved instead of refusing; orphan marker test deleted organizer notes. GREEN: 52 focused tests; lint clean.
- No client contract mismatch: providerSettings and microsoft exports from brief available. Final formatting/regression verification pending.

## Milestone 5 — UI feed and all-day semantics
- Existing useCalendarEvents and CalendarMatch subscribe to selected provider/connection plus Firebase owner changes, not only Google Drive session. In-flight stale-owner results cannot populate attendees into the next account. CalendarPage consumes this shared hook unchanged; no parallel feed.
- All-day events fetched in UTC can shift to the prior date for positive offsets. Adapter re-reads these events in originalStartTimeZone via Graph Prefer, retaining all-day local date and exclusive end date without an incomplete Windows timezone table.
- RED: all-day test showed previous-day timestamps; hook test failed to fetch Outlook without Google. GREEN: 48 tests across 6 focused files; lint clean.
- Remaining local hardening/verification in progress. Real Outlook personal/work account acceptance remains parent-owned; no external APIs/browser/user records touched.

## Milestone 4 — existing facade and report sync routed
- Existing eventsBetween/eventsAround now read selected provider, Outlook defaults to first calendar-enabled cached connection (not meeting home). `hasAnyCalendarGrant(provider=savedCalendarProvider())` checks the selected or explicit provider. `getEvent(calendarId,id,provider='google',connectionId?)` remains Google for old callers. updateEventDescription accepts optional provider/connectionId/bodyType/etag; createEvent returns calendarProvider/calendarConnectionId.
- `syncReportToCalendar` pins linked report provider (absent means legacy Google), propagates bodyType/etag/connection into conditional write, new explicit creation uses selected default and returns metadata. Meeting archive link uses home.webUrl for Microsoft home, Drive folder otherwise. Existing automatic `{create:false}` stays non-creating.
- RED: facade missing hasAnyCalendarGrant and 3 provider sync assertions failed with undefined provider. GREEN: 45 focused tests, lint clean.
- CLIENT ACTION REQUIRED in owned RecordPage/AssignEvent/archive/projection paths: when assigning CalendarEvent, store `calendarProvider:event.provider || 'google'`, `calendarConnectionId:event.connectionId`; clearing assignment clears BOTH; preserve these optional report fields on all storage roundtrips. CalendarMatch onPick passes complete metadata. Calendar default is NOT derived from meeting home. **Observed remaining seams outside lane:** `src/lib/dayAgenda.ts` recordedEventIds/scheduledByDay/buildAgenda compare bare event.id; scope by provider+connection+calendar to avoid cross-calendar collisions (also upcoming matching if same pattern). `src/lib/assignEvent.ts` still calls Google-only hasCalendarGrant before writeback; switch to hasAnyCalendarGrant(event.provider || 'google'). `RecordPage.tsx` URL preselection still uses `getEvent('primary', requestedEvent)`; EventRow/UpcomingAlert record URLs need provider + connection query params and RecordPage must pass them to getEvent (legacy missing provider remains Google).
- Work continues: all-day original-zone handling and hook/UI subscriptions.

## Milestone 3 — runnable Graph adapter
- `src/lib/microsoftCalendar.ts` implements calendarView pagination/occurrence expansion, UTC + immutable ID Prefer on every request, exact connection pinning, getMicrosoftEvent, conditional updateMicrosoftEventDescription and explicit createMicrosoftEvent. New event returns calendarProvider and calendarConnectionId. Missing etag refuses write; Graph status maps to CalendarError preserving 404/410 vs 412 semantics.
- RED: absent adapter module, then missing update/get/create functions. GREEN: 34 focused tests passed. Lint most recent run only concurrent missing microsoftWorkflow module (previous run fully clean).
- Work continues: all-day original-zone handling, facade routing, provider-pinned report sync/UI.

## Milestone 1 — Graph normalization
- Added shared/microsoftCalendar.ts: GraphCalendarEvent and graphEventToCalendarEvent(raw, calendarId, connectionId). Type-only CalendarEvent dependency; no runtime/browser dependencies. Occurrences/exceptions become default meeting events; seriesMaster and cancellations excluded. UTC offset-less times normalized explicitly, all-day dates use local date-only semantics. CalendarEvent adds provider, connectionId, bodyType and etag.
- RED: focused test failed `Cannot find module './microsoftCalendar'` before implementation. GREEN: shared helper + existing calendar/calendarQuery tests: 26 passed.
- Lint attempted: blocked only by concurrent AUTH/CLIENT missing new modules and their test tuple errors; no calendar errors.
## Milestone 2 — safe body payload
- Added pure `mergeMicrosoftBody(existing, block, bodyType)` for server reuse. HTML escapes summary text, inserts before closing body, replaces only bounded CheatMeet paragraphs, preserves organizer/Teams bytes unchanged. Text bodies retain type and bounded text block. Does not touch onlineMeeting/attendees/organizer fields.
- RED: 2 tests failed `mergeMicrosoftBody is not a function`; GREEN: 28 focused tests passed. Lint now blocked only by concurrent server microsoftAuth test/module and processing-onedrive module (no calendar errors).
- Work continues: Graph requests/pagination, conditional writeback, facade routing, provider-pinned report sync/UI.
