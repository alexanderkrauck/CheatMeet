# Microsoft build dispatch

Baseline 4647e06. Parent owns integration, shared/storage.ts, processing contracts/router/runtime, existing server code, MCP, Firestore rules, dependencies, cloud configuration and deploy.

- deleg_acb3ef69 / sa-0-f56b9e04 — Microsoft auth; `.hermes/plans/microsoft-auth-handoff.md`.
- deleg_acb3ef69 / sa-1-50bf587e — Microsoft Calendar; `.hermes/plans/microsoft-calendar-handoff.md`.
- deleg_acb3ef69 / sa-2-aef577d6 — browser/storage/client; `.hermes/plans/microsoft-client-handoff.md`.
- deleg_7267e7d3 / sa-0-034dbfe7 — worker OneDrive IO; `.hermes/plans/microsoft-worker-handoff.md`.

Full binding interfaces and file ownership in microsoft-build-brief.md. Worker adapter alone additionally owns new server/processing/onedrive.ts and tests/processing-onedrive.test.ts. No child owns external resources or Git operations. Old deleg_04b2c524 belongs to already-deployed recovery and is unrelated.

External dependency: question to user selecting registration tenant timed out, no answer. Default active az tenant is PF Fachkraft and MUST NOT be used for this private app. Available isolated progress.works CLI is alexander@progress.works, tenant 3301b473-eb5c-408e-aae1-03d7b40ace17; registration requires user choice. No CheatMeet app found in either tenant. Code work continues independently.

Parent verified checkpoint: Microsoft processing-source acceptance and legacy job hiding RED 400/202 -> GREEN; Microsoft-only worker readiness RED false/true -> GREEN; MCP Microsoft-only tool/search and authorization RED -> GREEN; typed home validation and personal OneDrive navigation links GREEN. Most recent independent parent run: eight backend/auth/processing/MCP test files, 140 passed. Whole-tree lint temporarily red because client writer's capture test references setCaptureHome before implementing it; no backend type errors at that checkpoint. Firestore rules compile through official Rules API returned 200 with no issues (quota-project header required). Firebase Microsoft identity provider lookup returned 404 CONFIGURATION_NOT_FOUND. No Microsoft registration/cloud writes made.

Controller reports auth and worker children finished, calendar/client still running. Parent mounted Microsoft auth router, switched worker identity to generic Firebase and wired storageIO(createDriveIO(),createOneDriveIO()), and provider-aware MCP. Remaining parent integration: worker calendar mixed-provider write-back hook; review child security/IO diffs; runtime/cloud setup once tenant choice answered; verify client consumers, full suite/build/PWA/deploy, real acceptance.

User asked what separate app means; parent explained a new CheatMeet app registration, not a new tenant/subscription, and no employee data access. This was a clarification, NOT permission to create it yet.

UPDATE: User answered "yes" to the explicit progress.works registration question. Microsoft app registration in tenant 3301b473-eb5c-408e-aae1-03d7b40ace17 is now authorized. Only CheatMeet resources, delegated scopes and own-account acceptance; no tenant-wide data grant or PF Fachkraft changes. Verified current progressworks CLI identity alexander@progress.works, user 67f01f55-2edd-425f-8e6d-60c37b5a1873. Google secret cheatmeet-microsoft-client-secret did not exist before setup.

Next parent checkpoint: worker OneDrive handoff read and actual adapter diff reviewed. Added callback seam in both storage adapters plus server/processing/calendar.ts; runtime passes syncWorkerCalendar independently of archive provider. Added RED/GREEN for mixed-provider hook and Teams HTML/ETag preservation. Fixed MS router missing its own JSON parser after removing global parser from test fixture (real disconnect failed 400 before fix; all 16 auth tests green after). Fixed initial OneDrive canonical JSON missing its own newly assigned reportId (RED conflict; allow only omitted self-reference while checking known account/root and verifying actual parent).

Full integration at 18:21 CET: lint clean; 84 files / 1093 tests passed. Production build and five emitted PWA integration cases passed at next checkpoint (before remaining client edits). Python deployment suite 17 passed; deploy manages complete Microsoft client/public-origin/secret-reference group and smoke checks configured endpoint/auth gating. No commit/push/deploy, registration or Firebase provider writes yet. Current local isolated-review server: proc_15c141854fc4, port 3217, built bundle with MCP/processing/provider secrets explicitly disabled. Parent must stop it at completion. Calendar lane handoff read; caller seams (event provider metadata, URL params, agenda dedupe/assign gates) still client-owned to check after return.
