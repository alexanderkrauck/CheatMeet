# Microsoft sign-in, Calendar and OneDrive

Microsoft is an alternative to the existing Google connection, not a second application or an Azure hosting migration. Firebase still owns workspace identity; Firestore is a transcript-free cross-device index; OneDrive/Google Drive hold the readable meeting archive. AssemblyAI/Gemini and Cloud Tasks continue unchanged.

## User flow

- Google and Microsoft sign-in identify the workspace only; neither sign-in asks for archive/calendar permission. Only genuinely new Firebase accounts enter `/setup`, with separate storage and optional calendar steps. Returning accounts keep their UID, defaults, grants and archives without restarting setup. Settings offer symmetric explicit linking for both sign-in methods. Matching email addresses alone never merge accounts.
- OneDrive authorization and optional Outlook calendar authorization are separate from Firebase sign-in. Both personal and organizational Microsoft accounts are intended to work; organizational consent, Conditional Access and OneDrive provisioning remain tenant-controlled.
- Choose a OneDrive folder in settings as the default for future meetings, or choose a home for an individual meeting before recording/consent. Existing meetings retain their pinned home; no migration or dual-write occurs.
- Calendar selection is independent: Google Calendar with OneDrive and Outlook with Google Drive are supported combinations. Linked calendar events retain their original provider and connection, regardless of later default changes.
- Shared SharePoint/Teams document libraries, Teams joining/recording import and Copilot integration are outside this implementation.

## Permissions

The server-held Microsoft grant requests OIDC identity, `offline_access` and delegated `Files.ReadWrite`; `Calendars.ReadWrite` is requested only when the user opts into Outlook. The Entra application also declares the identity/profile permissions needed by Firebase Microsoft authentication.

`Files.ReadWrite` is **not folder-only** permission: it grants access to the user's own OneDrive files, while the app restricts its operations to the selected archive. No application permission or tenant-wide employee-data consent is granted. Selecting a folder neither creates a sharing link nor changes existing sharing. Google's existing `drive.file` scope is unchanged.

## Runtime configuration

All three Microsoft settings are needed together:

| Setting | Meaning |
|---|---|
| `MICROSOFT_CLIENT_ID` | Entra application's public client ID. |
| `MICROSOFT_CLIENT_SECRET` | Runtime credential supplied through Secret Manager, never browser code. |
| `MICROSOFT_PUBLIC_URL` | Exact HTTPS public origin, without a path. |

`MICROSOFT_AUTHORITY` defaults to `https://login.microsoftonline.com/common`. National clouds and custom authorities are not implemented.

The deploy workflow manages `MICROSOFT_CLIENT_ID`, `MICROSOFT_PUBLIC_URL` and `MICROSOFT_CLIENT_SECRET_NAME` from GitHub variables. The last is the Secret Manager resource name, not the secret value. Existing service environment and Google grants are preserved. Health reports `microsoftConfigured`; `/api/microsoft/config` exposes only readiness. Configured deployments are smoke-checked for readiness and authenticated connection access.

Entra redirect URIs:

- `https://cheatmeet.ai.studio/api/auth/microsoft/callback` — server-held Graph grant.
- `https://gen-lang-client-0187125016.firebaseapp.com/__/auth/handler` — Firebase Microsoft identity.

The Firebase project must enable `microsoft.com` with the same application client ID and credential. This identity provider is distinct from the app's server-held Graph cache.

### Provisioned ownership and rotation

Registration belongs to the authorized progress.works tenant `3301b473-eb5c-408e-aae1-03d7b40ace17`, managed by Alexander. App client ID: `0ff7ecd1-f390-4353-ab4f-1bd9984b773f`; application object ID: `0f32ff1a-efd9-4c8e-bef5-1c1d55f8b463`. Runtime secret resource: `cheatmeet-microsoft-client-secret` in Google project `gen-lang-client-0187125016`.

The initial credential expires **12 May 2027, 19:34 Vienna time**. Before expiry, add a new Entra application credential, privately update both Secret Manager and Firebase's Microsoft provider configuration, deploy a revision using the new secret, verify Microsoft sign-in plus server refresh, then remove the retired credential. Never paste credentials into chat, logs, GitHub variables or this document.

## Storage and compatibility

`shared/storage.ts` defines the explicit Microsoft home: connection, drive, root and meeting folder, artifact item IDs and safe human-visible URL. Microsoft records never reuse `rawAudioUrl` or the legacy `drive*Id` fields. Invalid provider bindings fail rather than selecting Google.

- Legacy Google indexes remain `users/{uid}/reports/{id}`.
- Microsoft indexes use `users/{uid}/meetings/{id}`, with the same transcript-free projection. New readers combine both; each meeting has one authoritative index record.
- Microsoft local reports, drafts and chunk/progress namespaces are separated from legacy keys so cached Google-only clients cannot export a Microsoft meeting to Google.
- New processing API clients send `X-CheatMeet-Storage: microsoft`; old clients cannot list/hydrate Microsoft jobs.
- Google archives remain v0/v1 compatible. Microsoft archives use version 2; readers require an explicitly selected Microsoft context and never derive connection authority from editable JSON.

The per-meeting JSON is canonical. Root `index.json`/`SCHEMA.md` are derived conveniences. Consent records name the actual service and freeze retention before recording; changing defaults does not change an existing promise.

## Server authorization and processing

`server/microsoftAuth.ts` uses MSAL Node, authorization code + PKCE, nonce, owner-bound one-use state and a cookie-bound callback. The fixed public origin prevents forwarded-host callback substitution. Production `microsoftGrants` uses the existing Firestore DocStore; development uses private `.microsoft-grants/`. Only access tokens reach the authenticated browser. Grant cache and refresh material never enter report documents or MCP responses. Explicit disconnect removes this app's owner-specific connection, not global Microsoft access.

`server/processing/storage.ts` routes the existing worker through Google or OneDrive IO. OneDrive IO verifies the connected account's own drive and artifact parentage, checkpoints processing in the archive, checks source/index revisions and applies conditional canonical updates. No new worker engine or paid-submission identity is introduced. Microsoft-only identities do not need a Google subject/Google OAuth secret.

Opted-in calendar write-back is provider-aware and nonfatal to archive completion. Outlook requests immutable IDs, preserves the current HTML/Teams body, replaces only the bounded CheatMeet block and uses a revision precondition. Automatic processing never creates a missing event.

Resumable browser uploads are backed by owner-only server session handles: `/api/microsoft/uploads`, `/uploads/session` and `/uploads/complete`. Only the opaque handle is journaled on the device; preauthenticated upload URLs remain server-side except while returned to their owner for direct chunk upload. Graph bearer credentials are not forwarded to those URLs. Final acceptance requires a verified item, not merely a successful chunk request. Emit OData annotations before ordinary item properties: real Graph rejects the opposite ordering even though generic JSON fixtures accept it.

Existing bounded text uses native Graph `PUT /content` with the known `If-Match` revision; a real Business OneDrive check returned 200 followed by 412 for the stale revision. Personal-style deferred sourceUrl commits are not supported by Business OneDrive, so the client does not use them for text edits. The older server upload-update path fails closed rather than dropping its revision guard; clients must refresh to use the native text path. Large audio remains resumable, new-file-only upload-session data.

## Recovery and failure semantics

The durability boundary remains **complete source upload plus acknowledged server job**. Before it, keep the browser open; explicitly requested uploads resume on reopening. After it, Cloud Tasks owns continuation and the recording tab may close.

Never silently change provider, broaden permission, replace unknown/newer canonical content, restart a paid ASR submission with uncertain acceptance, or upgrade backup-only intent into analysis. Expired upload sessions may require retransferring bytes; grant revocation requires reconnecting the exact account. Throttling is temporary, not lost consent. Actual user edits remain protected from stale local machine failures.

## Verification

Use `npm run lint`, `npm test`, the production build, emitted PWA integration and Python deploy-config tests. Focused coverage includes owner isolation, Microsoft-only identity, mixed calendar/archive routing, resumable sessions, stale edits, old-client isolation, consent and archive compatibility. These checks are not a claim of real Graph acceptance.

Release acceptance additionally needs real Microsoft sign-in/linking, the actual granted account/scopes, OneDrive upload/read-back, conditional conflict rejection, a closed-tab worker completion and Outlook write-back on an owned disposable event. Record which account type was actually exercised; tests or Entra's configured audience do not establish that every tenant policy or personal account was tested.
