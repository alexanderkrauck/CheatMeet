# OneDrive worker handoff

## Verified slice 1 — source loading
- New `server/processing/onedrive.ts`, export `createOneDriveIO({fetchImpl?,access?,runtimeToken?})`.
- Injected access is owner + pinned connection scoped; own `/me/drive` check, folder/artifact membership, content-only archive parser, trusted Microsoft home, no legacy fields.
- Canonical raw JSON hash and stable metadata/content ETag snapshot; owner `users/{owner}/meetings/{id}` index with binding/newer-edit checks.
- RED: `npx vitest run tests/processing-onedrive.test.ts` failed missing new adapter import. GREEN: 1 test passed.
- `npm run lint` reached only external unfinished lanes: microsoftAuth.test tuple, microsoftAuth union grants, missing microsoftCalendar/onedrive client modules and client tuple.
## Verified slice 2 — checkpoints
- Immutable run/stage/revision-bound checkpoints in the same OneDrive folder; direct name addressing avoids pagination URLs entirely. Creation uses conflictBehavior=fail plus If-None-Match:*; retry reads the existing checkpoint and never overwrites divergent content.
- RED: second test failed `Checkpoint noch nicht verfügbar.` GREEN: 2 tests passed.
- Latest lint only external unfinished `src/lib/microsoftWorkflow.test.ts` missing microsoftWorkflow import.
## Verified slice 3 — authoritative export
- Markdown/transcript upsert with artifact membership and If-Match; missing artifacts created with fail-on-conflict semantics.
- Source/index guards run before all writes and again before authoritative JSON PUT; stable ETag comparison plus If-Match closes races.
- Immutable export-plan checkpoint recovers a successful source PUT whose response was lost; existing summaries/calendar bindings remain intact (no calendar API calls).
- RED: new export tests failed `Export noch nicht verfügbar.` GREEN: 4 tests passed. Latest lint only external archive/calendar contract work in progress.
## Verified slice 4 — index publication + live contract seam
- Owner `meetings` index publish uses Firestore updateTime (or exists=false), transcript-free projection, Microsoft home only, conflict detection + same-projection retry acceptance.
- RED: publish test failed `Index noch nicht verfügbar.` GREEN: 5 tests passed; `npm run lint` now clean.
- Client concurrently landed `fromArchive(raw,{home:h})` and rejects Microsoft raw.home in Google context. Adapter now uses that explicit Microsoft context, then STILL revalidates and overrides home/artifact refs itself. This is the actual binding (not the earlier Google-context fallback).
## Verified slice 5 — audio streaming
- Full runnable adapter now implements every ProcessingIO method + audio; no stubs remain.
- Graph content requests manually follow only a single HTTPS Microsoft download-host redirect; second request has no Authorization/header forwarding and redirect=manual. Credentials/capabilities are never archived.
- RED: audio tests failed `Audio noch nicht verfügbar.` GREEN: 7 tests passed; `npm run lint` clean.
## Final verified slice 6 — adversarial guards + regression checks
- Added own-drive mismatch, invalid finalized home, foreign-folder artifact, remote shortcut, canonical key-order/hash, stable metadata/content ETag, late ETag-only edit, HTTP412, changed-index no-write, source/derived alias, discovered-audio overwrite, and interrupted-download retry coverage.
- Retention regression RED: loading a missing audio reference incorrectly returned 404. GREEN: a missing audio artifact is omitted from trusted home while saved text remains recoverable; foreign/existing audio still must pass membership validation.
- Alias regressions RED: source-file derived ID was accepted; a derived name could target source/discovered audio before later validation. GREEN: distinct artifact IDs and protected target checks now block these before writes.
- Download-body regression RED: a transport interruption became permanent 422. GREEN: only SyntaxError is permanent invalid JSON; transport errors retain retry semantics.
- Final command: `npx vitest run tests/processing-onedrive.test.ts tests/processing.test.ts tests/processing-runtime.test.ts tests/processing-analysis.test.ts` => **4 files, 51 tests passed** (20 new adapter tests + 31 existing processing tests).
- Final `npm run lint` => **clean**.

## Parent integration / exact remaining acceptance
- Export is `createOneDriveIO(options?:{fetchImpl?:typeof fetch;access?:(owner:string,connectionId:string)=>Promise<string>;runtimeToken?:()=>Promise<string>}): ProcessingIO & {audio(j,r):Promise<Readable>}`. Default access dynamically imports `getMicrosoftAccess(owner,connectionId)`; defaults use boundedFetch and serviceAccountToken.
- Source job home is authority; legacy internal refs are ignored by this adapter. Returned/archived Microsoft reports never carry legacy Drive IDs. Actual parser seam is now **`fromArchive(raw,{home:h})`**, because client lane changed the original Google-context parser to reject Microsoft archives; adapter independently validates/rebinds home afterward.
- Parent still owns runtime dispatch to this adapter and optional provider-aware calendar wrapper; adapter makes **no calendar API calls** and preserves calendar fields.
- No real Graph/OneDrive, browser, cloud, records, secrets, external state, commits, pushes, or deployments used. Real Graph conditional creation/update behavior, real download-host redirect shape, task dispatch/restart, and closed-tab acceptance remain parent-owned and unverified here.
- Only created/modified owned files: `server/processing/onedrive.ts`, `tests/processing-onedrive.test.ts`, `.hermes/plans/microsoft-worker-handoff.md`.
