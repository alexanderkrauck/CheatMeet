# Microsoft AUTH handoff — progressive

## Slice 1: runnable server auth flow
- Created `server/microsoftAuth.ts` and `server/microsoftAuth.test.ts` only.
- RED observed: focused Vitest failed `Cannot find module './microsoftAuth'` (feature absent).
- GREEN observed: `npx vitest run server/microsoftAuth.test.ts` — 1 test passed. Real loopback Express routes exercise bearer Firebase-only identity, PKCE start, callback, persisted cache across service instances, safe metadata, owner isolation, disconnect and replay rejection. Provider calls injected; no external services accessed.
- `npm run lint` initially found two owned typing errors (fixed immediately), plus another lane's missing `src/lib/microsoftCalendar` import. Re-run pending.

## Exact public exports
`microsoftConfigured()`, `firebaseAccountFor(token, projectId?)`, `getMicrosoftAccess(owner, connectionId?)`, `listMicrosoftConnections(owner)`, `createMicrosoftAuthRouter(options?)` match brief. Extra testable `createMicrosoftAuthService(options?)` exposes `begin/complete/list/getAccess/disconnect`; types `MicrosoftAuthOptions`, `MicrosoftClient`, `MicrosoftAuthDocument`, `MicrosoftConnection` exported.

## Runtime contract
- Parent mounts router at `/api` and provides JSON parser. Real default uses `ConfidentialClientApplication` from installed `@azure/msal-node`.
- Fixed origin mandatory: MICROSOFT_PUBLIC_URL is HTTPS origin only (HTTP localhost allowed outside production). Missing/unsafe origin or credentials => configured false; authority restricted to Microsoft login endpoint. Callback exactly `${MICROSOFT_PUBLIC_URL}/api/auth/microsoft/callback`.
- Production existing Firestore DocStore collection `microsoftGrants`; dev existing private fileDocStore `.microsoft-grants/` (parent should add ignore). No Firebase Admin/new identity platform. Runtime serviceAccountToken reused.
- Grant IDs are opaque stable hashes of Firebase uid + Microsoft homeAccountId (never Google sub). Reauthorization replaces that account's cache while preserving pinned report connectionIds; explicit disconnect removes only the local grant. Multiple different accounts without explicit selection are rejected. Cache updates use compare-and-set grant revision; disconnect cannot be undone by stale refresh.
- Pending state is server persisted, cookie-bound, owner-bound, 10-minute lifetime, claimed atomically before code exchange. Nonce compared to MSAL token response; OIDC+offline+Files.ReadWrite; calendar only opt-in and granted scopes.
- Callback posts only `{source:'cheatmeet-microsoft-oauth',connected:true}` or generic German error to fixed origin, with CSP/no-store; no raw provider errors/logging. API returns access tokens only, never MSAL cache/refresh credentials.

## Slice 2: generic Firebase lifetime validation
- Added real RS256 signed offline Firebase token regression. JWKS key resolver alone is injected via module mock; jose signature/issuer/audience/lifetime checks run for real, no network.
- RED: correctly signed token missing `exp` incorrectly resolved `{uid:'firebase-microsoft-owner',googleSub:''}`. Added required sub/iat/exp/auth_time and future-issued checks.
- GREEN: owned suite 2/2 passed. Lint has no owned errors; current external errors: missing `src/lib/microsoftWorkflow` and MCP test `readMeeting` no longer in TranscriptReader (other lanes mid-edit).

## Slice 3: real MSAL integration + race/security coverage
- RED: token with missing Files scope returned 200 instead of 403. Added scope verification after silent acquisition (including calendar when required).
- Real MSAL adapter offline integration RED exposed `ClientAuthError: nonce_mismatch`: MSAL requires `nonce` on `acquireTokenByCode`, not only authorization URL. Fixed exact request field. GREEN now executes actual MSAL discovery, code/PKCE exchange, cache serialize/deserialize, automatic refresh and subsequent persisted-cache hit through injected HTTP fixtures.
- GREEN: focused suite 10/10. Coverage additionally includes correctly signed Microsoft-only Firebase identities, wrong audience/claims/signature, cookie/nonce/replay rejection, atomic concurrent callbacks, disconnect-during-refresh no-resurrection, multiple connection selection, owner-specific disconnect, cross-origin/malformed requests and secret-free errors.
- `npm run lint` passed cleanly after other lanes completed their intermediate writes.

## Slice 4 / final: reconnect semantics and cache contention
- RED: MSAL `invalid_grant` returned 503 rather than reconnect 403. Known interaction/revocation codes now produce safe German 403; transient provider failures remain generic 503. Never deletes unrelated grants or globally revokes Microsoft.
- RED: same-account reauthorization accumulated two connection IDs, making pinned homes unusable. Connection ID now stable per owner/homeAccountId; callback replaces only that account grant, with a fresh cache revision. Explicit reconnect after disconnect restores the same pinned ID.
- RED: simultaneous valid access requests produced one fulfilled/one rejected result. Added bounded (two retries) CAS contention recovery; disconnection still immediately fails closed and cannot resurrect a grant.
- Added opt-in calendar capability, expired state, unsafe/missing config tests.
- FINAL `npx vitest run server/microsoftAuth.test.ts`: **16 passed**, exit 0.
- FINAL `npm run lint`: **clean**, exit 0.
- FINAL `git diff --check -- server/microsoftAuth.ts server/microsoftAuth.test.ts .hermes/plans/microsoft-auth-handoff.md`: no output, exit 0.
- No files outside owned auth/test/handoff changed. No cloud/tenant calls, live user data, browser, secrets, commits, deployments, skill/memory writes.

## Remaining acceptance / parent integration
- No remaining local implementation gaps found in owned lane. Parent should add `.microsoft-grants/` to gitignore before using local live credentials. Use `MICROSOFT_PUBLIC_URL` origin only, no trailing path; credentials and authority read at service construction, so restart after configuration changes.
- MSAL HTTP fetch timeout 15s/request; Firebase JWK 10s; existing Firestore requests 10s. No provider error logging. Calendar capability is verified against actual granted token scopes, not just request intent.
- Owner document holds only private connection metadata/MSAL serialized caches (365-day rolling retention); pending state documents expire after 10 minutes. Both use server-only collection `microsoftGrants`. A Firestore TTL policy on `expireAt` is optional cleanup, not a security requirement: store enforces expiry itself.
- Parent owns tenant/app registration, env/secrets, Firestore deny-by-default/rules review, gitignore, route mounting, worker integration, deployment and real account acceptance. No external setup performed here.
