# Provider consumption and cost estimates

## What is measured

`/usage` shows **consumption by authenticated CheatMeet account**, not by meeting participant or speaker. The existing report-derived meeting activity remains a separate section; meeting length never substitutes for billed provider usage.

The server records one `usageEvents` entry per real Gemini SDK attempt, issued live-transcription connection token, or batch submission attempt:

- **Gemini:** requested model, returned model version and response ID, input/output/thinking/cached/total token counters. Metering wraps the actual SDK call inside existing explicit retry loops, before parsing its response. Successful but invalid generated JSON is still consumption. SDK-internal retries are disabled. A missing usage block is unknown, not a free request. Omitted proto3 cache/thinking zero counters are decoded only within an otherwise complete, consistent usage block.
- **Live AssemblyAI:** microphone and system audio, plus each reconnect, have distinct events. Token issuance is not proof that a connection ran. The browser relays `Begin` and `Termination`, including provider session ID and separate session/audio seconds. These are explicitly **browser-relayed**, not server-verified invoice measurements. A lost termination, tab closure, or account change can leave unknown usage. The recorder's wall-clock meeting duration is never substituted.
- **Batch AssemblyAI:** a usage ID is saved with the existing native paid reservation before submission. Existing result polling settles that same entry from provider `audio_duration` and reported `speech_model_used`; polling and restarts do not invent additional paid runs. Unsupported reported models retain measured seconds but stay unpriced; malformed reported models use an explicit unconfirmed marker, not the requested model's tariff. Confirmed safe retries get distinct usage IDs. Uncertain submissions keep their native reservation closed. Historical reservations without a usage ID are not fabricated or resubmitted for accounting.

Attribution uses the verified Firebase UID. Optional meeting ID and archive namespace are metadata, not authority. Worker jobs retain an optional bounded name/email label derived from the matching, verified bearer token; they do not accept a submitted account label. No transcript, prompt, question, summary, audio, credential, signed download URL, or meeting title belongs in the ledger. Own-account UI may resolve a locally available meeting label; the operator API remains usage metadata only.

## Durability and failures

`server/usage/index.ts` owns the recorder and HTTP surface. Production uses the server-held Firestore REST store in `server/usage/store.ts`, the configured named database, native compare-and-set, and the `usageEvents` collection. There is no in-memory production fallback and no automatic accounting-history TTL. Existing Firestore rules deny direct browser access through their catch-all rule; no public ledger permission is added.

Local development uses private `.usage-events/` files, ignored by Git; memory storage is for injected tests. A durable begin failure prevents dispatching untracked paid work. A settlement failure **after** provider work preserves the pending entry and emits a content-free diagnostic, rather than converting a successful response into another paid retry. Known terminal receipts are idempotent and cannot be overwritten by a later interruption or a different account.

Accounting is not a distributed transaction with the provider. Crashes after upstream work, missing response metadata and incomplete browser receipts remain visible gaps; this implementation does not promise exactly-once billing or historical completeness.

Worker accounting REST calls share the current processing deadline. Analysis and its awaited settlement reserve the final 20 seconds of the 200-second dispatch for the existing durable checkpoint. The SDK timeout is recomputed after durable admission, immediately before dispatch; an expired window cannot start paid work. A contended/unavailable settlement can leave a pending usage entry but returns an already paid result while checkpoint time remains. This headroom is not a guarantee that external archive writes succeed.

## Access and queries

- `GET /api/usage?start=YYYY-MM-DD&end=YYYY-MM-DD&scope=mine|all&cursor=...` uses operation-start accounting days in **Europe/Vienna**, with an exclusive end and a bounded range of at most 32 days. Each response is a bounded page; clients follow `nextCursor`, deduplicate, cancel on changes, and label partial results. Reads never call an AI/transcription provider.
- `mine` is the default. Supplying a different owner does not grant access.
- `all` requires an exact verified Firebase UID in **`USAGE_OWNER_UIDS`**, a comma-separated server environment allowlist. It defaults to no operators; neither email domain nor browser claims grant operator access. The response's `canViewAll` controls the optional UI, but the server enforces it independently. Keep this environment value server-side; do not add it to Vite configuration. Use verified account UIDs, not Google subject IDs, Microsoft IDs, email addresses, or sample values.
- `POST /api/usage/live/:id` accepts only authenticated own-session receipts. Clients cannot create authoritative usage rows or submit owner, model, price, or cost. Receipt failure does not block transcript delivery.

`firestore.indexes.json`, bound in `firebase.json`, declares the owner/accounting-day and owner/start-time indexes. **Local implementation does not deploy them.** On a separately authorized release, apply these indexes to the same configured named database and wait until ready before relying on production queries. The existing runtime identity must retain its server-held Firestore permissions. No collection migration or fabricated backfill is required.

The cross-account view is available only after the deployment has explicitly configured `USAGE_OWNER_UIDS`. An empty allowlist is an intentional secure default, not a reason to auto-promote the first user.

## Costs, rates and limits

`server/usage/pricing.ts` contains the source-qualified public standard PAYG rates checked on **2026-11-14**, including their documented effective-date changes. The event stores its rate ID, source URL, checked date and USD estimate when settled; page reads do not silently reprice past entries.

- Cached tokens are a subset of input: charge uncached input plus cached input, not both full input and cache again.
- Thinking is displayed separately and contributes to billed output alongside generated-response tokens.
- Live transcription uses session-open seconds; batch uses processed audio seconds. Enabled speaker-label and other explicitly known add-ons are part of the applicable estimate.
- Unknown models, unsupported features, inconsistent token counters, missing measurements, and legacy multimodal input without modality counts stay unpriced. Their known consumption is still displayed.
- Estimates exclude discounts, credits, tax, FX, hosting, storage, and any unmeasured fees. USD estimates are **not** invoices, per-user charges, or reconstructed historical totals. Actual invoice reconciliation is not implemented.

The day/week/month views show known subtotals with coverage, model and operation breakdowns, per-meeting own-account details, and an authorized account overview. An empty period means no recorded events in the selected range, not proof of zero historical spend. Account/range/scope changes fence pending responses and hide stale foreign data before effects run.

## Verification boundaries

Use the repository's full Vitest, TypeScript, build, emitted-PWA and deploy-config gates. Focused accounting tests cover actual router/store behavior, privacy, account fencing, pagination, rate calculation, retries, and missing data. The disposable acceptance fixture under the dated Hermes artifact workspace loads the actual app, usage API, metering wrapper and private file ledger with synthetic identities and provider responses, while blocking external network and physical capture. It is not a deployed billing reconciliation or live paid-provider acceptance.

This feature does not change the existing one-final-pass retranscription allowance, consent boundary, archive format, sign-in identities, storage defaults, or paid reservation recovery semantics.
