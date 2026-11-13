# Microsoft uploads handoff (complete; live acceptance pending)

Only `server/microsoftUploads.ts`, its focused test, and this handoff are owned by this task. Parent mounts `createMicrosoftUploadRouter()` at `/api`. Route-owned 8 KiB JSON parser; no global middleware needed.

## RED → GREEN so far
- Initial create test: missing module RED, then handle creation/persisted target/fail-on-conflict GREEN; lint passed.
- Restart/resume, lost create final-chunk response, deferred update final conditional commit: missing endpoints RED, then 4 tests GREEN; lint passed.
- Commit readback protection RED (incorrectly returned200 on intervening edit), then GREEN.
- Impossible provider range + capability hidden in webUrl RED, then GREEN. Completion now deliberately omits optional webUrl.
- Concurrent stale status erasing persisted result RED, then GREEN via atomic completion-preserving mutate.
- Final focused verification: **22 tests passed**; `npm run lint` passed; full `npm test`: **86 files / 1126 tests passed**; scoped `git diff --check` passed.

## Integration and storage
- Export `createMicrosoftUploadRouter(options?)` and `UploadDocument`; exact injected options requested are supported. No parent/client files changed.
- Production: lazy Firestore DocStore collection `microsoftUploads`, configured Firebase project + named database, runtime service account. Local: lazy private `fileDocStore(path.resolve('.microsoft-uploads'))` (directory0700/files0600 supplied by existing DocStore).
- Credentials/access failures403; unknown or foreign handle404; incomplete/conflicting known session409; expired410; provider429 with Retry-After; all errors sanitized German, parser failures JSON400/413.
- Own drive and exact parent checks; reject remote/shared-anonymous parents; session creation verifies delegated writable access. Archive names fixed; audio filenames restricted to safe Unicode filename + webm/mp3/mp4/m4a/wav/ogg/flac/aac. Size must be positive, <=250 GiB; empty-file sessions intentionally rejected400.
- The test transport is injected; the only HTTP sockets exercised are localhost test servers, not Microsoft/tenant endpoints.

## Provider request shape requiring live acceptance by parent
Docs retrieved (no tenant calls): https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0, especially Examples 4 and 7.
- Create: `POST /v1.0/drives/{drive}/items/{parent}:/{name}:/createUploadSession`, body `{item:{name,"@microsoft.graph.conflictBehavior":"fail"}}`. Checks name absence first.
- Update: `POST /v1.0/drives/{drive}/items/{item}/createUploadSession`, `If-Match: originalEtag`, body `{item:{name,"@microsoft.graph.conflictBehavior":"replace"},deferCommit:true}`.
- Update FINAL commit: `PUT /v1.0/drives/{drive}/items/{item}`, `If-Match: originalEtag`, JSON `{name,"@microsoft.graph.conflictBehavior":"replace","@microsoft.graph.sourceUrl":uploadUrl}`. NO unconditional POST commit fallback. Docs describe this explicit sourceUrl+If-Match commit for Personal; Business/SharePoint support needs actual acceptance. If unsupported it fails closed rather than dropping conditionality.
- Status: GET preauthenticated upload URL WITHOUT Authorization and with redirect:error. Only Microsoft `.up.1drv.com` / `.sharepoint.com` host suffixes accepted (plus sovereign .up.1drv.com.cn).

## Recovery limits
- Creation recovery requires prior absence + fail-on-conflict session + now-consumed session + exact name/drive/parent/size/file and newly created timestamp. This excludes arbitrary preexisting same-size files, but cannot cryptographically distinguish a concurrently created new same-name item if the session independently vanished. Parent should evaluate whether stronger provenance is required.
- Updates keep final chunks deferred; losing final chunk response is recoverable via status + conditional explicit commit. Losing the SERVER's commit response before persistence remains ambiguous: returns409, never adopts another writer's same-size target. Persisted completed results are idempotent across router/process restart.
- Session expiry is queried live because chunk uploads extend it; local tombstones retained 30 days (then handles become404).
- No live/cloud/tenant APIs, user records/secrets, commits/push/deploy were used.
