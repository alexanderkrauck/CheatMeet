> **STATUS (2026-09-30, Vienna): IMPLEMENTED, except the items below.** This file is the plan as written
> before the work; where it disagrees with the code, `MCP_IMPLEMENTATION.md` and the code win.
> Done: P0 (stall fix), T1-T9 (config, shared core, storage, OAuth, consent page, tools, live server and client).
> Dropped by decision: T10 (live consent wording - owner said to ignore it).
> Not built: T7b (ChatGPT `search`/`fetch`), per-meeting exclusion.
> Not verified: a real Claude / ChatGPT / Hermes client, a real browser run of the consent page, Drive
> visibility of older meetings (spike S1: the local Drive grant had expired), any deployment.
> Verified against the real provider: the inactivity error, the 5 s heartbeat and a clean session (soak, partial).

# CheatMeet MCP access (past + live transcripts) — Implementation Plan

> **Plan only.** Nothing is implemented; this file is the only thing written (Vienna time, 2026-09-30).
> **Implementer:** follow `test-driven-development` (RED → GREEN per behaviour), keep functions small and pure so tests hit the real code (`.claude/CLAUDE.md`), match the German user-facing strings, **no commits unless asked** (suggested boundaries in §4).

**Goal.** An AI client that speaks MCP can, once the owner has approved it with their Google sign-in, (1) read every past meeting — metadata, summary, todos, full transcript, search — and (2) read the transcript of a meeting that is being recorded *right now*, as it grows.

**Shape.** One stateless MCP endpoint (`/api/mcp`, Streamable HTTP) in the existing Express process; a small OAuth 2.1 authorization server whose only login is the app's existing Google sign-in; and, for live, a new push path from the recording tab to the server.

**Two shippable phases.** **Phase 0 = live-transcription stall fix (P0, §3.8; independent, ships first).** Phase 1 = OAuth + past transcripts (T0–T7). Phase 2 = live (T8–T9; T10 is dropped) and **depends on Phase 0**. Phases 0 and 1 are each useful alone.

### Owner decisions (2026-09-30)

| # | Decision | Effect on this plan |
|---|---|---|
| D1 | **"Ignore live consent."** | T10 (notice wording, `CONSENT_TEMPLATE_VERSION`) is **dropped**; no per-meeting opt-in or settings toggle. The only gate is the OAuth scope `meetings:live` that you grant to an assistant: the recording tab sends transcript text **only while a live-scoped grant exists** (probe protocol, §3.5). The app does not tell participants that an AI reads along — your decision, not assessed by me. |
| D2 | Firestore | As designed (§3.2). |
| D3 | **"You pick" → hand-rolled authorization server on `jose`** | The SDK authors recommend a dedicated identity provider for new servers (v2 ships only the resource-server half; the AS helpers live in `server-legacy`, which npm marks deprecated/frozen). I am deliberately not following that: this is a single-user app with an existing Google sign-in, and I do not want a paid third party in the login path. Cost: ~350 LOC of security-critical code → its own review round (T12) and the explicit test list in T4. **Swappable:** the MCP endpoint depends only on `verifyAccessToken(token) → AuthInfo`, so an external IdP can replace `server/mcp/oauth.ts` later without touching a tool. |
| D4 | Clients: **Hermes, ChatGPT, Claude** | New §3.7 (vendor requirements, from their docs), optional T7b, tighter T4/T6 tests, §6.1. |
| D5 | Whole archive exposed | No per-meeting exclusion; revoking the grant is the only control. |
| D6 | **Open:** where the server is publicly reachable (§6.1) | Hermes can proceed on `localhost`; ChatGPT and Claude cannot. |

**Size, honestly (my estimates, nothing measured).** Roughly 1.1k LOC server, 0.5k client, 0.2k shared, plus ~1.5k LOC of tests. The authorization server (~350 LOC + a consent page) is the fixed cost of "MCP auth via Google OAuth" and cannot be skipped; live adds ~450 LOC; Phase 0 is roughly 250 LOC of source and 300 of tests (estimate).

---

## 1. Original decision list (historical — **superseded wherever the owner-decisions table above differs**: D1 no longer means opt-in, D3 is chosen, D4 names three clients; D6 is still open, §6.1)

| # | Decision | Recommendation | Alternative and its cost |
|---|---|---|---|
| **D1** | Live sharing sends speech to *another* AI. This repo is built around § 201 StGB and names its processors in the spoken notice (`shared/consent.ts`). | Live is **off by default**, opt-in per meeting (checkbox on the armed screen, default in Settings). When on, the notice gains a processor ("KI-Assistent (Live-Mitlesen, …)") and `CONSENT_TEMPLATE_VERSION` → `"3"`. **You approve the exact wording** — it is the legal artifact; I will not pick it alone. | Scope-level consent only ("live" ticked once on the consent page): less code, but nobody in the room is told. |
| **D2** | Where live state lives. | Firestore, server-only collection. Cloud Run can run several instances, and the repo already forbids in-memory state for the same reason (`transcriptionStore.ts`). | In-memory + `max-instances=1`. Simpler, but a scale-out or restart silently blinds the assistant. I have not checked the deployed instance limits (`gcloud` is installed here, but I did not touch your cloud project). |
| **D3** | Authorization server. | Hand-rolled, ~350 LOC on `jose` (already a dependency). The v2 SDK ships only the resource-server half. | `@modelcontextprotocol/server-legacy/auth` — npm marks it deprecated ("frozen copy … migration purposes only"). Less code, deprecated dependency in the security core. |
| **D4** | Client registration. | RFC 7591 DCR only, **stateless**: `client_id` is a signed token carrying name + redirect URIs, so nothing is stored. Spec 2026-07-28 still supports DCR but marks it deprecated in favour of Client ID Metadata Documents (CIMD). | Add CIMD later if a client you care about needs it. **Which clients do you want?** I can test Hermes; Claude/ChatGPT connectors I cannot verify from here. |
| **D5** | "All past transcripts" = the whole archive; no per-meeting exclusion in v1. | Accept for v1: revocation is one click and instant. | A per-meeting "not via MCP" flag needs a `firestore.rules` change + deploy. |
| **D6** | Inputs. | Production origin (Cloud Run URL or custom domain) → `MCP_PUBLIC_URL`, which is both OAuth issuer and token audience. Permission to generate `MCP_TOKEN_SECRET`. For spike S1: may I use your local `.google-grants/` refresh token and `GOOGLE_OAUTH_*` from `.env`? (I have opened neither.) | — |

---

## 2. What I verified, and what it changed

| # | Finding (evidence) | Consequence |
|---|---|---|
| 1 | **Google cannot be the MCP authorization server.** Google's discovery doc (fetched today) has no `registration_endpoint` and no `client_id_metadata_document_supported`. Spec 2026-07-28: clients register via CIMD / pre-registration / DCR; servers "MUST NOT accept or transit any other tokens" and must check the audience (RFC 8707 `resource`). | CheatMeet issues its **own** MCP tokens. "Google OAuth" = the user proves identity with the existing Google sign-in at the consent step; Google's Drive grant stays server-side and is never given to the MCP client. |
| 2 | **Spec/SDK.** `modelcontextprotocol.io/specification/latest` 307s to `2026-07-28`: no `initialize`, no `Mcp-Session-Id`, GET/DELETE → 405. SDK v2 (`@modelcontextprotocol/server` 2.2.0, `/express` 2.0.1, `/node` 2.1.0, released 23–28 Sep; the v2 line itself has been stable since 2026-07-27) implements it, and `createMcpHandler(factory)` also serves 2025-era clients **statelessly** from the same factory by default. Hermes' bundled Python SDK is 2.0.0 with `LATEST_PROTOCOL_VERSION = 2026-07-28`. v1 (`@modelcontextprotocol/sdk` 1.31.0) tops out at 2025-11-25 and declares `express ^5.2.1` as a dependency, i.e. a second Express next to the repo's 4.22 (read from its package.json; not installed here). | Use v2, no session storage. **Pin exact versions** — `server` shipped three stable releases in two months. |
| 3 | **Past transcript text is deliberately not in Firestore** (rules reject `speech`/non-empty `transcription`; `projectReport` strips both). It lives in Drive as `transkript.md` (frontmatter + `renderTranscript` output, uploaded `text/markdown`). The server already holds a per-user Drive refresh token (`driveGrants`, keyed by Google `sub`) and mints access tokens. The index (title, date, summary, todos, participants, `driveTranscriptId`, `updatedAt`) is in `users/{uid}/reports`, reachable over the same Firestore REST + service-account token the server already uses for `driveGrants`/`transcriptionJobs` (assuming that IAM role covers it — §6). | Past = Firestore index + Drive file, both through server-held credentials. No new data copies. |
| 4 | **No live transcript exists server-side.** The browser talks to AssemblyAI directly (`assemblyLive.ts`, 60 s token); turns exist only in the recording tab (`AssemblyEvents`) and its IndexedDB journal. | Live requires the recording tab to push. That is the only change in the recording path, and it must never be able to affect recording. |
| 5 | `drive.file` shows only files created by the app's OAuth client. If the client used by older popup sign-ins differs from the server flow's client, old meetings could be invisible. | Spike **S1** before building the past-transcript path. |
| 6 | Repo has Express 4.22, Node 22 in Docker (v2 needs ≥ 20). In dev the server cannot reach Firestore (no metadata server; hence `fileGrantStore`). | Dev seam in T3. |

---

## 3. Design

### 3.1 Flow

```
AI client                         CheatMeet (one Express process)                       Google / storage
─────────                         ──────────────────────────────                        ────────────────
POST /api/mcp (no token) ───────► 401 + WWW-Authenticate: resource_metadata=…
GET  /.well-known/oauth-protected-resource/api/mcp ──► {authorization_servers:[origin]}
GET  /.well-known/oauth-authorization-server ────────► S256, DCR, refresh, iss-param
POST /api/oauth/register ───────► signed client_id (stateless)
browser → GET /api/oauth/authorize ─► validate → 302 to SPA /connect?request=<signed>
                                     SPA: Firebase Google sign-in (existing) ◄────────── Google
                                     user sees client name + scopes → Allow / Deny
                                     POST /api/oauth/decision (Firebase ID token)
                                       → grant{pending, code hash} in Firestore mcpGrants
   ◄── redirect_uri?code=…&state=…&iss=…
POST /api/oauth/token (code+verifier+resource) ─────► access JWT (1 h, aud = MCP url) + rotating refresh
POST /api/mcp  Bearer … ────────► verify JWT → read grant (no cache → revocation is instant) → tool
                                    ├ past: Firestore users/{uid}/reports + Drive transkript.md
                                    └ live: Firestore mcpLive/{hash(uid,reportId)}
                                              ▲
recording tab ── PUT /api/live/:reportId (Firebase ID token), diff every ~1.5 s
```

Rules: issuer, audience and every URL come from `MCP_PUBLIC_URL`, **never** from `Host`/`req.protocol` (no host-header poisoning). The MCP server never sees or forwards a Google token.

### 3.2 Data placement

| Data | Store | Lifetime | Readable by |
|---|---|---|---|
| Grant (client, scopes, uid, googleSub, code/refresh hashes) | Firestore `mcpGrants` (server-only; the catch-all rule already denies clients) | pending 10 min; active until refresh expiry (90 d) or revoke; revoked kept 30 d | server |
| Live doc (turns, state, `seq`) | Firestore `mcpLive` | `expireAt` rolling 6 h; ended + 30 min | server |
| Past index / text | existing Firestore / Drive | unchanged | server, via owner's grant |
| Drive access tokens | server memory, ≤ 50 min | — | server |
| Dev | `.mcp-grants/` files (0600, gitignored); live in memory | — | — |

Collection-level TTL policy on `expireAt` must be enabled in Firestore (§6).

### 3.3 Grant state machine (one `DocStore<Grant>` with compare-and-set)

```
decision(approve) → {status:pending, code:{hash, exp +60 s, challenge, redirectUri, resource}}
token(code)       → CAS pending→active. Verifies PKCE, redirect_uri, client_id, resource.
                    Issues access JWT + refresh {hash, exp +90 d}.
                    Code presented twice → invalid_grant AND grant revoked (RFC 6749 §4.1.2: a code used twice must be denied and SHOULD revoke what it issued).
token(refresh)    → CAS: presented hash == current → rotate (keep prevHash).
                    presented == prevHash → replay → revoke grant.
                    Scope may narrow, never widen.
revoke (Settings / RFC 7009) → status:revoked
```

One abstraction covers grants *and* live docs:

```ts
interface DocStore<T> {
  get(id: string): Promise<T | null>;
  /** Atomic read-modify-write. fn: undefined = leave unchanged, null = delete. Retries on contention. */
  mutate(id: string, fn: (cur: T | null) => T | null | undefined,
         meta: { ownerKey: string; expireAt: Date }): Promise<T | null>;
  listByOwner(ownerKey: string): Promise<T[]>;
}
```

Implementations: memory, file (dev), Firestore REST (`currentDocument.exists=false` / `updateTime` preconditions — reuse the status handling in `transcriptionStore.ts`, including 400 `FAILED_PRECONDITION`).

### 3.4 Tools (all read-only: `annotations.readOnlyHint: true`; scope enforced with the SDK's `scopeChallenge: requireScopes(...)`)

*Every tool sets `readOnlyHint:true, destructiveHint:false, openWorldHint:false` (ChatGPT asks for accurate values). Checked: `annotations?: ToolAnnotations` exists in the v2 server types, `readOnlyHint` in the 2026-07-28 schema, and `scopeChallenge`/`requireScopes` in the SDK's authorization guide. The exact `registerTool` call shape is confirmed in spike S2, not assumed.*

| Tool | Scope | Arguments | Returns |
|---|---|---|---|
| `list_meetings` | `meetings:read` | `from?`, `to?` (ISO date), `limit?` ≤100 (30), `cursor?` | id, date, title, duration, participants, status, `has_transcript`, summary (≤400 chars), todo count; `next_cursor` |
| `get_meeting` | `meetings:read` | `meeting_id` | full summary, todos, takeaways, participants, project, `transcript_chars` |
| `get_transcript` | `meetings:read` | `meeting_id`, `offset?`, `max_chars?` ≤100k (40k — Claude Code cuts results at 25k tokens, §3.7) | text cut at a line boundary, `next_offset`, `total_chars`. Same format as `transkript.md` (timestamps + speaker names) |
| `search_meetings` | `meetings:read` | `query` (≥2 chars), `limit?` | hits `{meeting_id, title, date, where: title\|summary\|todos\|transcript, snippet}` + **`transcript_coverage {searched,total,truncated}`** so a partial search never looks complete |
| `list_live_meetings` | `meetings:live` | — | active meetings: id, `started_at`, `state`, `updated_age_s`, `turns` |
| `get_live_transcript` | `meetings:live` | `meeting_id?`, `last_minutes?`, `since_ms?`, `max_chars?` | rendered text, `state` (`recording`/`paused`/`ended`), `stale`, `cursor_ms` (next `since_ms`), `partial_tail`, `truncated` |

`meeting_id` is the same report id in both worlds, so "the meeting that just ended" is followed up with `get_meeting` after it syncs. Tool descriptions in English (the model reads them); content stays German. Consent screen lets the user untick `meetings:live`. Deterministic tool order (spec SHOULD). No write tools, no audio, no resources/prompts in v1.

### 3.5 Live push protocol

`PUT /api/live/:reportId` — `Authorization: Bearer <Firebase ID token>`, JSON ≤ 1 MB (id regex `^[a-zA-Z0-9_-]{1,100}$` as in `server/transcription.ts`):

```ts
interface LivePush {
  seq: number;                       // strictly increasing per meeting, from 1
  reset?: true;                      // replace everything (first push, or after 409)
  startedAt: string; languages: string[];
  state: "recording" | "paused" | "ended";
  upsert: LiveTurn[];                // {id,startMs,endMs,speaker,text,final,source?}
  remove: string[];                  // turn ids that vanished (speaker regrouping)
  speakerNames: Record<string, string>;
  warning?: string;
}
```

- `200 {seq, listening:true}`; `seq ≤ stored` → 200 no-op (idempotent retry); gap without `reset` → `409 {resync:true}`; 413; 429; 401.
- **Gate (D1):** the server first checks that the owner has an active grant with `meetings:live`. If not → `403 {listening:false}` and **nothing is stored**. A `{probe:true}` body carries no text and just answers `{listening}`; the tab probes first, sends the full transcript (`reset`) only after `listening:true`, and after a `403` falls back to a probe every 30 s. The check (an owner query on `mcpGrants`) is cached ≤10 s per instance, so revocation takes effect within that window for live and immediately for everything else.
- Caps: doc ≤ 900 KB (drop oldest *final* turns, record `droppedBeforeMs`; never the unfinished tail), ≤ 5 live meetings/user, ≥ 700 ms between pushes/user, heartbeat every 15 s, `stale` when `updatedAt` > 60 s old and state ≠ ended.
- Client (`src/lib/liveShare.ts`): pure `diffTurns`, trailing throttle 1.5 s, one request in flight, `acked` advances only on 200, 409 → `reset`, **401 (Firebase token) → stop and report `off`; 403 `{listening:false}` (no live grant) → send nothing and probe again in 30 s**, network errors → backoff. **It never awaits inside the transcription callback and never throws into recording.** The "KI-Live-Freigabe aktiv" pill (T9) shows only while the server reports `listening:true`; it is optional under D1.

### 3.6 Security

| Threat | Mitigation |
|---|---|
| Token for another resource replayed here | `aud` = `MCP_PUBLIC_URL/api/mcp`, `resource` is optional (this AS has exactly one resource, so absent = that one, and a client that omits it still works) but must equal it when present, else `invalid_target`; JWT verified with `alg` pinned to HS256 |
| Stolen auth code / refresh token | PKCE S256 only; code 60 s, single-use CAS, reuse revokes; refresh rotation with replay detection; only hashes stored |
| Consent phishing via DCR | Consent page shows client name (flagged "self-declared") and the redirect **host**; redirect URIs limited to `https` or loopback (RFC 8252); `client_id` is signed so it cannot be forged |
| Mix-up | `iss` on every authorize response + `authorization_response_iss_parameter_supported: true` |
| Open redirect | Unknown client / unregistered redirect → HTTP 400, **never** a redirect; exact match, loopback port-agnostic |
| Cross-user leakage | `uid` only ever from the grant; tools take no user argument; Drive file ids only from the owner's own index; isolation tests |
| Instant revocation | grant read on every request, no cache |
| Confused deputy / token passthrough | Drive tokens minted server-side, never returned; MCP token is a different credential |
| DNS rebinding / CSRF from browsers | `Origin` validated (absent = allowed, present + unlisted = 403); CORS only on token/register/metadata; `/api/mcp` allows its own origin plus `https://claude.ai` and `https://chatgpt.com` by default (their backends send no `Origin` today — unverified), extendable via `MCP_ALLOWED_ORIGINS`; rejected origins are logged |
| Unauthenticated OAuth surface | tiny in-memory per-IP limiter on `register`/`token`/`authorize` (Cloud Run `trust proxy` is already on); ≤ 25 grants per user |
| Consent page framing | `Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options: DENY` on `/connect` |
| Content in logs | log `{event, tool, ok, ms, grant: hash8}` only — never text or tokens |

---

### 3.7 Client requirements (from the vendors' own docs, fetched 2026-09-30; **nothing here is tested yet**)

| Requirement | Consequence here |
|---|---|
| Claude and ChatGPT call the server **from their own infrastructure** over public HTTPS (Anthropic egress `160.79.104.0/21`; OpenAI publishes connector IP ranges). Claude resolves the host itself: public **IPv4**, port **443**, and a URL that redirects to another host loses the `Authorization` header. | `localhost` works only for Hermes. The others need a public https origin (§6.1) and no WAF/CDN rule may block them. |
| Claude: a `401` with `WWW-Authenticate … resource_metadata` starts sign-in (a header on a `200` is ignored). PRM `resource` must equal the URL the user typed, path included; only `authorization_servers[0]` is used. | PRM `resource` = `MCP_PUBLIC_URL/api/mcp` exactly; serve PRM at the path-aware **and** the root well-known URL. |
| Registration: Claude uses CIMD only if the AS advertises `client_id_metadata_document_supported` **and** `none` in `token_endpoint_auth_methods_supported`, else DCR; ChatGPT prefers CIMD when advertised, else DCR. **Claude registers a new client on every fresh connection.** | DCR-only satisfies both. The stateless signed `client_id` (D4) means those registrations cost no storage. |
| Redirect URIs: `https://claude.ai/api/mcp/auth_callback`; Claude Code = loopback on any port for **both** `localhost` and `127.0.0.1`; ChatGPT = `https://chatgpt.com/connector/oauth/{callback_id}` or `…/connector_platform_oauth_redirect` (declared by the client at registration). | Validate by rule (https or loopback), not by host allow-list; the consent page shows the host. |
| PKCE S256 on every request; `resource` on authorize **and** token; ChatGPT/Codex **reject** a response whose `iss` is missing or differs from the metadata `issuer` when the AS advertises RFC 9207. | `iss` byte-equal to the metadata `issuer`; test both directions. |
| Token endpoint: form-encoded body; RFC 6749 error codes (`invalid_grant` for a dead refresh token); **rotating** refresh tokens for public clients; Claude refreshes on `401` and up to 5 min before expiry. | Matches §3.3; T4 tests the exact request shape. |
| **Deadlines:** Claude gives discovery/registration/token 10 s and refresh 30 s, then treats the flow as failed even if the server answers later. | A Cloud Run cold start plus a Firestore read must fit in 10 s; if setup flakes, `min-instances=1`. |
| Scopes: clients request what `scopes_supported` advertises; Claude appends `offline_access` when advertised; ChatGPT requests advertised OIDC scopes by default (a Supabase deployment broke on an advertised `openid`, claude-ai-mcp #1038). | Advertise **only** `meetings:read` and `meetings:live`; ignore, never reject, `openid`/`offline_access`. |
| claude.ai web silently rejects a **307** authorization redirect (#250). A global CORS allow-list that 500'd `OPTIONS` on `/token` broke a real deployment (#480). | T4 tests: every redirect is 302; preflight always answers. |
| Tool results: claude.ai/Desktop ≈150,000 characters; Claude Code cuts at 25,000 tokens by default. Tool-call timeout 240 s. | `get_transcript` default 40,000 chars, max 100,000; search deadline 20 s. |
| ChatGPT wants accurate `readOnlyHint` / `destructiveHint` / `openWorldHint`. Deep research and company knowledge additionally need `search` and `fetch` with a fixed schema, returned as `structuredContent` **and** as JSON text; citations appear only when `url` is non-empty. | Annotations on every tool; optional T7b adds `search`/`fetch`, `url` = `MCP_PUBLIC_URL/report/<id>` (that SPA route exists). |
| Account requirements: ChatGPT Developer mode (availability "can depend on account and workspace policy"); Claude custom connectors on Free (max one), Pro, Max, Team, Enterprise — Team/Enterprise need an Owner. | I cannot check either from here; you need an account that may add a custom connector. |
| Failure pattern: I read six `claude-ai-mcp` issues (#125, #228, #250, #385, #480, #1038); five turned out to be fixable on the server side (403 on the first authenticated `initialize`, WAF, CORS preflight, 307, a 500 in the token endpoint). #228 (refresh via Claude's proxy) has conflicting reports. | Treat the first real Claude/ChatGPT connect as a milestone, not a formality. Log (without content) the first authenticated request per grant, so "token issued but never used" is diagnosable. |

## 3.8 Phase 0 — live transcription stalls in long meetings (owner request, 2026-09-30)

**Symptom.** In long meetings the live transcript stops growing; pause → resume brings it back. **Independent of MCP, useful on its own, and a prerequisite for the live MCP feed** (a stalled source is a stalled feed) — so it ships first and separately.

### What I established

I copied `src/lib/assemblyLive.ts` (byte-identical, sha1-checked) into a scratch project with the repo's own test harness and wrote 10 tests. **At HEAD `5770193`: 8 fail, 2 pass, identical across 3 runs.** The file is saved at `.hermes/plans/assets/assemblyLive.stall.test.ts` (it drops into `src/lib/` unchanged). I have **not** reproduced it in a real browser or against the real provider, and I cannot tell from here which defect you hit — only that each one below is real and that each produces exactly your symptom.

| # | Defect (code at HEAD) | Result in the test | Why pause → resume "fixes" it |
|---|---|---|---|
| A | `Error` and unsolicited `Termination` frames call `dispose()` (`assemblyLive.ts:274-278`), not `interrupted()`. `dispose()` sets `closed`, so the following `onclose` is ignored: **no retry.** The connection sets `inactivity_timeout=20` (`:203`), so any 20 s without audio makes the provider end the session with a 3006 `Error` — and then nothing reconnects. | A1, A2: 1 socket, expected 2 | `resume()` calls `launch()`, a fresh connection |
| B | The retry counter `attempt` is never reset after a successful `Begin`; `attempt >= 3` (`:139`) means **three reconnects per source for the whole meeting**, however far apart. Test: 6 blips, 10 healthy minutes apart → sockets `[2,3,4,4,4,4]`, expected `[2,3,4,5,6,7]`. This is the defect that scales with meeting length. | B | fresh `startSource(attempt = 0)` |
| C | A socket that stays open but stops draining (`bufferedAmount > 6400`) only drops frames and calls `failed()` (`:246-253`); nothing rebuilds it. | C: 1 socket after 60 s | new socket |
| D | A suspended/dead `AudioContext` posts no frames; nothing notices, and after 20 s the provider gives up (→ A). | D | new context |
| F2 | A session where the provider goes silent is never rebuilt. `session_heartbeat` is not requested (G), so a browser has no liveness signal at all. | F2, G | new socket |
| E | Every dropped frame calls `failed()` → `publish()` → full `doc()` + `renderTranscript` (`:50-54`). 100 dropped frames → 100 republishes. | E: 100, expected ≤ 1 | — (load, not cause) |

**Making it worse with time (measured, not modelled).** `renderTranscript` calls `speakerLabel` per turn and `speakerLabel` rebuilds the speaker set on each call (`shared/transcription.ts:73`) — quadratic. On this machine (M3 Max, Node 22), one call: 250 entries 1.4 ms · 500: 3.4 · 1000: 13 · 2000: 52 · 4000: 197 ms. The live path calls it at least twice per event (`capture.ts:548`, `LiveMeeting.tsx:86`) plus `doc()`. Recorded provider traffic (`output/streaming-evaluation-2026-09-14`, 7 streams): median 0.77 `Turn` events/s per stream, max 2.05. **I did not derive how many entries a real 2-hour meeting has, so I cannot say at what length this starts to hurt, and I have not shown it causes a stall** — only that it is real main-thread load which grows with the meeting and which dropped-frame handling (E) multiplies. A per-render speaker map gives **byte-identical output** and is 13× (500) to 107× (4000) faster in the prototype (`.hermes/plans/assets/bench-render-prototype.ts`).

**Ruled out:** the token route does *not* cap sessions below the client's rollover (`max_session_duration_seconds=10800` vs rollover at 10 740 s), so a hard 1-hour/2-hour cutoff is not the cause. Provider docs confirm 3 h max session (3008) and that heartbeats arrive every 5 s when `session_heartbeat=true`; all 7 recorded streams show heartbeats every 4.9–5.4 s.

**Unverified, could matter:** background-tab timer throttling in long meetings (the code already works around it by ticking from `MediaRecorder` data events, `capture.ts:589`); whether the mic `AudioContext` suspends when the OS/browser changes audio devices. Both are covered by watchdog D/F2 without needing to know which it is.

**The workaround also costs audio.** `pauseCapture` pauses the recorder itself (`capture.ts:678-681`), so every manual pause/resume leaves a hole in the recording.

**What you get today when it stalls:** only a generic, sticky banner on the record page ("kann Lücken … enthalten", `RecordPage.tsx:495`) — same text for a healed blip and a dead connection, and nothing at all in `RecordingBar`.

### Design (all inside `startAssemblyLive`; the `LiveTranscription` interface only gains `restart()`)

1. **One recovery path.** `Error`, unsolicited `Termination`, `onclose`, `onerror`, Begin-timeout and watchdog trips all go through `interrupted()`. `dispose()` never decides about retries. Deliberate ends (`close()`/`terminating`, `paused`, `stopped`, ownership loss, superseded `generation`) still never reconnect.
2. **Retry forever while recording.** Backoff 2 s → 4 → … capped at 30 s, ±20 % jitter; **`attempt` resets on a successful `Begin`**. Stop only on unrecoverable answers: token route 401/403 → status `stopped`, "Bitte neu anmelden"; 400/404/413 → `stopped`. 429/5xx/network/503/409 retry (fresh session number). Fits the server's limit of 12 token requests/min/user with margin (2 sources × ≤ 2/min at the cap). Each attempt writes one small reservation document server-side; a full 3 h outage is ≈ 720 per meeting — acceptable, and the route already refuses `session > 10000`.
3. **Watchdog** (per source, evaluated in `tick()`, which `capture.ts` already drives from both a 500 ms interval and recorder data events): request `session_heartbeat=true`; then
   - no provider message (any type) for **15 s** → rebuild (three missed heartbeats, inside the provider's 20 s inactivity cutoff);
   - no worklet frame for **3 s** → `context.resume()`; still none at **12 s** → rebuild;
   - `bufferedAmount` above the limit continuously for **10 s** → rebuild.
   A healthy quiet meeting produces heartbeats and never trips it (GUARD F1). Times use the injected `now()`.
4. **Honest status instead of the sticky warning.** `MeetingTranscript` gains `liveConnection?: "connecting" | "live" | "reconnecting" | "stopped"` (an optional field on an object that is already stored without Firestore involvement — `speech` is stripped from the Firestore projection, so no rules change; I will confirm against `archive.ts` before adding it to the archive schema, otherwise it stays out of the archive). `RecordingBar` and the record page show "Live-Transkript getrennt – verbinde neu …" only while `reconnecting`, and for `stopped` a **"Live neu starten"** button that calls `restart()` — what pause → resume does, without pausing the recorder. `failed()` becomes idempotent (E). The existing "Lücken"-warning text stays for the review step.
5. **Diagnostics.** A ring buffer of the last 100 connection events (`{at, source, kind, code, attempt}`, no transcript text) with `console.info`, so the *next* stall says which of A–F it was. No UI for it (YAGNI).
6. **Quadratic render.** Add `speakerLabeler(doc)` to `shared/transcription.ts` (builds the order map once); `renderTranscript` and the loop callers (`transcriptRows.ts`, `meetingMeta.ts:372`, `SpeakerReview.tsx:37`, `LiveSpeakers.tsx:23`) use it; `speakerLabel` stays as a one-call wrapper. `LiveMeeting.tsx:86` memoises on `speech`. **Output must be byte-identical.**

### Non-goals
No replay of dropped audio (the repo's rule: "each packet is sent at most once"; the durable recording is unaffected). No change to the final-transcription path. No new dependency.

## 4. Tasks

Order = dependency order. Each task: RED first, then GREEN, then `npm run lint && npm test`. Suggested commit after each task (only if you ask).

### P0 — Live transcription stall fix (ship first, independent of MCP)

Order inside P0 is dependency order; each step RED → GREEN, then `npm run lint && npm test`.

- **P0.1 Bring the reproductions in.** Copy `.hermes/plans/assets/assemblyLive.stall.test.ts` to `src/lib/assemblyLive.stall.test.ts` (it uses the same fake-socket harness as `assemblyLive.test.ts`; check whether `vi.mock("./firebase")` needs the repo's existing pattern). Run it: **must show 8 failed / 2 passed** — if not, stop and re-investigate, the diagnosis is wrong. Read the eight existing tests in `assemblyLive.test.ts` first; they define behaviour that must keep passing (`reconnects with future audio only`, `pauses without sending paused audio`, `stops transmitting immediately after an account change`, …).
- **P0.2 Recovery path (A, B).** Route `Error`/`Termination`/close/error/Begin-timeout through `interrupted()`; reset `attempt` on `Begin`; unbounded capped-jitter backoff; classify token-route failures (401/403/400/404/413 stop, the rest retry). GREEN: A1, A2, B and the existing reconnect tests. **New RED first:** a test that a `Termination` we requested (finish/pause) and an account change still do *not* reconnect; a token-route 401 ends in `stopped` and sends no further token requests; a 503 keeps retrying.
- **P0.3 Provider heartbeat + watchdog (C, D, F2, G).** `session_heartbeat=true`; per-source `lastMessageAt`, `lastFrameAt`, `blockedSince`; evaluate in `tick()` with the thresholds in §3.8. GREEN: C, D, F2, G **and GUARD F1 stays green**. Extra RED: watchdog does nothing while `paused`/`terminating`/`stopped`; a rebuilt source gets a new `session` number and never replays audio (assert the frames sent after rebuild all have `contextTime` ≥ the rebuild moment); two sources are watched independently (one stalls, the other is not restarted).
- **P0.4 Idempotent `failed()` (E).** Publish only on the first transition. GREEN: E. Existing test `drops stale frames without a catch-up burst and exposes the live gap` must keep passing.
- **P0.5 Status + restart.** `liveConnection` on the published document; `restart()` on `LiveTranscription` (= `closeAll` + `launch`, recorder untouched); `RecordingBar` and `RecordPage` render the states and the button. **RED (`src/lib/capture.test.ts`, existing harness — read it first):** `restart()` does not pause the recorder or move the clock; status returns to `live` after a reconnect. Verify the UI visually in the isolated Chrome for Testing with a fake-provider page (see P0.7), screenshots of `reconnecting` and `stopped`.
- **P0.6 Render cost.** `speakerLabeler` + call-site changes + `useMemo`. **RED:** differential test — old `speakerLabel`/`renderTranscript` kept *inside the test file* as the reference, compared over ≥ 200 seeded random documents (speaker names set/unset, `:unknown`, suggestions, mixed sources, duplicates, empty); plus a guard that 4 000 entries render in < 25 ms (currently ~197 ms here; generous bound so CI hardware does not flake it).
- **P0.7 Real-provider soak (needs your approval — it costs AssemblyAI minutes and needs a valid session).** A throwaway page/script that opens a real session with a recorded WAV and: (1) kills the socket at 2, 7 and 15 minutes; (2) suspends the `AudioContext` for 30 s; (3) idles 25 s of silence. Expect recovery each time with no manual action. I cannot run this without credentials, so it is a stated acceptance step, not something I will claim.

**Definition of done for P0:** the ten tests green (8 fixed, 2 unchanged), the eight pre-existing `assemblyLive` tests green, full suite and `npm run build` green, plus P0.7 or an explicit "not run".

### T0 — Spikes (throwaway, in `$SCRATCH`, no repo changes)

- **S1 (needs D6).** Script that mints a Drive token from the local grant, lists the root folder, downloads one `transkript.md`, and tries `files.list q="fullText contains '<word>'"`. **Prints counts and sizes only, never transcript content.** Decides: (a) is the past archive visible to the server's OAuth client; (b) does Drive `fullText` index `text/markdown` (unknown today). Outcome → `search_meetings` = Drive `fullText` vs bounded scan (§T7).
- **S2.** Scratch project: Express 4.22 + the three MCP packages + `zod@4`; `createMcpHandler` + `requireBearerAuth` + `mcpAuthMetadataRouter`; bundled with the **same esbuild flags as `npm run build`** (`--bundle --platform=node --format=cjs --packages=external`), started as CJS. Probe with an SDK v2 `Client` (modern era) and a raw `initialize` POST at `2025-06-18` (expect a stateless 200 and no session header). Also confirm: localhost issuer accepted, body limit behaviour without a JSON parser, `Origin: https://evil.example` → 403. **Gate:** if it does not bundle/boot, stop and re-plan before T1.

### T1 — Dependencies, config, health

- **Files:** `package.json`, `package-lock.json`, `bun.lock`, `server/mcp/config.ts` (new), `.env.example`, `.gitignore` (+`.mcp-grants/`), `server.ts` (health: `mcpConfigured`).
- **Install:** `@modelcontextprotocol/server@2.2.0 @modelcontextprotocol/express@2.0.1 @modelcontextprotocol/node@2.1.0 zod@^4` (the `node` package peer-depends on `hono` — npm will add it and `@hono/node-server`; expected, server-side only).
- **Lockfiles (repo rule):** `npm install`, then `bun install` with **bun 1.3.10** (installed here), then on a clean tree `npm ci && bun install --frozen-lockfile && git diff --exit-code -- package.json package-lock.json bun.lock` (this is what CI runs).
- **RED (`tests/mcp-config.test.ts`):** `mcpConfig(env)` → `null` if `MCP_PUBLIC_URL` or `MCP_TOKEN_SECRET` missing; rejects secret < 32 bytes; rejects non-https except loopback; strips trailing slash; parses `MCP_ALLOWED_ORIGINS`; `MCP_ACCESS_TTL_S` (default 3600, allowed 60–3600) so token refresh can be exercised in minutes.
- **Not configured ⇒ degrade, don't lock out** (same principle as `serverAuth:false`): `/api/mcp` → 503 German JSON, well-known → 404.

### T2 — Shared pure core (`shared/mcp.ts`, isomorphic, dependency-free like `shared/transcription.ts`)

- **Phase 1 needs only** `Scope`, the past-tool constants, `sliceText`, `findSnippets`. The live types/constants (`LiveTurn`, `LivePush`, `LiveDoc`, §3.5) and `diffTurns`, `applyPush`, `renderLive` go in the same file but are written in T8/T9 — not before (YAGNI; Phase 1 must not carry dead live code).
- **RED (`shared/mcp.test.ts`)**
  - *(T8/T9, Phase 2)* `diffTurns`: unchanged → empty; text change → upsert; missing id → remove; order-insensitive.
  - *(T8, Phase 2)* `applyPush`: `reset` replaces; `seq ≤ stored` → no-op; no doc and no `reset` → resync; upsert/remove merge; size cap drops oldest finals, sets `droppedBeforeMs`, never the unfinished tail.
  - *(T8, Phase 2)* `renderLive`: output line format equals `renderTranscript` (parity test against the real function); `lastMinutes` windows by turn time; `sinceMs` returns turns with `endMs > since` and a `cursorMs` that never skips; unfinished turn flagged; truncation keeps the newest text and says so.
  - `sliceText`: cuts at a line boundary ≤ max; `nextOffset` null at end; offset past end → empty; a single over-long line is hard-cut (no infinite loop).
  - `findSnippets`: case-insensitive, ≤ 3 per text, context trimmed on word boundaries.

### T3 — Storage (`server/mcp/docStore.ts`, `firestoreRest.ts`)

- `DocStore<T>` (§3.3): memory, file (mode 0600, dir 0700, atomic rename), Firestore REST. `FirestoreRest`: create/replace with preconditions, `runQuery` by `ownerKey`, and a reader for the app-written `users/{uid}/reports` docs (decode Firestore value types; page with `pageSize=300`; mask to the index fields, not `transcription`).
- **Dev seam.** In dev the runtime-identity token does not exist. `MCP_DEV_ADC=1` (dev only, refused when `NODE_ENV=production`) fetches a token via `gcloud auth application-default print-access-token` (fixed argv, no env-supplied command; cached 50 min). Consequence to know: dev then reads **real** Firestore data with your credentials.
- **RED:** one contract suite run over `[memory, file, firestore-with-fake-fetch]` — `mutate` from absent creates once; 20 parallel "claim" mutations → exactly one winner; `listByOwner` isolates owners; `expireAt` written; contention beyond retries throws a typed error. Shared fake: `tests/helpers/fakeFirestore.ts` (honours `exists`/`updateTime`, returns 409/412/400-FAILED_PRECONDITION like the real thing). Reports reader: decodes every value type used by `ReportData`, tolerates missing fields and a non-parseable `date`.

### T4 — Authorization server (`server/mcp/oauth.ts` + routes)

- Pure helpers first (`redirectAllowed`, `redirectMatches`, `validateRegistration`, `sign/verifyClientId`, `sign/verifyAuthRequest`, `pkceMatches`, `narrowScopes`, `newSecret`, `hashSecret` with `timingSafeEqual`), then routes: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/api/mcp`, `/api/oauth/{register,authorize,decision,token,revoke}`, `/api/mcp/grants` (list, owner-only) and `DELETE /api/mcp/grants/:id`.
- Mount **before** both the dev Vite middleware and the production SPA fallback (`app.get("*")`) — `/.well-known/*` is outside `/api`, so it does not inherit the existing `app.use("/api", …)` mounts. The service worker already ignores non-shell paths, so `test:pwa` should be unaffected (verify).
- **RED (`tests/mcp-oauth.test.ts`, real Express on port 0, fake clock)**
  - metadata: issuer/endpoints from `MCP_PUBLIC_URL`; a spoofed `Host` changes nothing; `["S256"]`, `iss` parameter advertised, public clients (`none`).
  - `register`: rejects `http` non-loopback, `javascript:`, > 5 URIs, missing name; 201 with `client_id`, no secret.
  - `authorize`: bad client / unregistered redirect → 400 **without redirect**; missing or `plain` PKCE → error redirect (`invalid_request`, `state`, `iss`); wrong `resource` → `invalid_target`; **absent `resource` still succeeds and the token's audience is the MCP URL**; success → 302 to `/connect?request=…`.
  - `decision`: no bearer → 401; non-Google identity → 401; no Drive grant → 409 `no_drive_grant`; deny → `access_denied`; approve → `code`+`state`+`iss`; scopes can only narrow; 26th grant refused.
  - `token`: happy path; wrong verifier / redirect_uri / resource → `invalid_grant` / `invalid_target`; expired code; **code reuse → `invalid_grant` and the first access token stops working**; 20 parallel redemptions → exactly one 200; refresh rotates; **old refresh replay revokes the grant**; scope widening on refresh refused.
  - `verifyAccessToken` rejects: wrong audience, expired, revoked grant, tampered, `alg:none`.
  - `revoke`: revokes; unknown token → 200 (RFC 7009); rate limiter returns 429 with `Retry-After`.
  - *Vendor rules (§3.7):* PRM served at the path-aware **and** the root well-known URL with `resource` = the MCP URL exactly; `OPTIONS` with `Origin: https://claude.ai` on `/token`, `/register` and `/.well-known/*` → 204 with permissive CORS, never 5xx; every redirect the server itself issues is 302; `/token` accepts `application/x-www-form-urlencoded`; `scope=openid offline_access meetings:read` → `meetings:read` granted, no error; loopback redirect matches for `localhost` **and** `127.0.0.1` on any port; the largest allowed registration still yields a `client_id` under 2 KB.

### T5 — Consent page + settings (`src/pages/ConnectPage.tsx`, `src/components/McpClients.tsx`, `src/lib/mcpClients.ts`, `src/App.tsx`, `SettingsPage.tsx`)

- `/connect` sits **outside** the gated layout: `user ? <ConnectPage/> : <Login notice="Bitte anmelden, um den Zugriff zu bestätigen."/>` — signing in re-renders on the same URL, so the signed request in the query string survives (a `Navigate to="/"` would lose it).
- Copy (German): "Zugriff für „{Name}“ erlauben?", redirect host shown, name flagged "vom Programm selbst angegeben, nicht geprüft", one checkbox per scope the server currently offers (Phase 1: read only — the live checkbox appears only once T8 ships; the list derives from the registered tools' scopes, never hard-coded), "Nur lesen. Jederzeit in den Einstellungen entziehbar."
- Settings panel: MCP server URL with copy button, list of connected clients (name, host, scopes, created, last active) with "Zugriff entziehen".
- **RED (`src/lib/mcpClients.test.ts`):** parse/validate the signed request, `redirectHostOf`, scope labels, expired request handled. **Verify visually** in the isolated Chrome for Testing (your standing rule for OAuth): screenshots of consent, denial, revoke.

### T6 — MCP endpoint + `list_meetings` (tracer bullet)

- **Files:** `server/mcp/index.ts` (router: `hostHeaderValidation`/`originValidation`, `requireBearerAuth` with `resourceMetadataUrl`, `createMcpHandler` via `toNodeHandler`, **no JSON parser in front** so the handler reads the stream), `server/mcp/tools.ts`, `server/mcp/meetings.ts` (`listMeetings` on top of the T3 reports reader), `server.ts` (mount).
- **RED (`tests/mcp-tools.test.ts`, SDK v2 `Client` against the handler + raw HTTP):** no token → 401 with `WWW-Authenticate … resource_metadata`; every tool has `readOnlyHint:true`, `destructiveHint:false`, `openWorldHint:false` and a required scope (a relationship, not a name snapshot); `list_meetings` — date filter, newest-first with unparseable `date` strings tolerated, stable cursor, **two-user isolation**, missing scope → 403 `insufficient_scope`; legacy `initialize` at `2025-06-18` → 200 with no `Mcp-Session-Id`; `Origin: https://evil.example` → 403; not configured → 503.
- **Checkpoint — first real client.** Register with Hermes (`hermes mcp add cheatmeet --url <origin>/api/mcp --auth oauth`), consent in Chrome for Testing, `hermes mcp test cheatmeet`. Per the mailindex notes, an already-running Hermes process will **not** list new tools until `/reload-mcp` or restart — test from a fresh process (`hermes chat -q`). Once a public origin exists (§6.1), repeat with Claude (Settings → Connectors → Add custom connector) and ChatGPT (Developer mode → Plugins → +), one at a time, reading the server log after each attempt.

### T7 — Remaining past tools

- `get_meeting`, `get_transcript`, `search_meetings`; Drive access via a shared mint helper extracted from `server/googleAuth.ts` (the `/drive-token` handler and MCP use the same `refreshAccessToken`; small refactor covered by the existing `tests/google-auth.test.ts`).
- Search: index fields first (title, summary, todos, participants). Transcript search = Drive `fullText` **if S1 says it works**, else bounded scan: newest first, concurrency 6, ≤ 60 transcripts/query, 20 s deadline, LRU cache keyed `${id}:${updatedAt}` (≤ 20 MB). Always return `transcript_coverage`.
- **RED:** `get_transcript` paginates and reports `total_chars`; distinct results for "no transcript yet" / Drive file trashed / Drive grant revoked (`invalid_grant` → German "Google-Drive-Zugriff von CheatMeet wurde entzogen. Bitte in CheatMeet neu anmelden.", `isError:true`) / Drive unreachable; a meeting id not in the caller's index → not found even if the same Drive id belongs to someone else; search coverage numbers correct, cache invalidated on `updatedAt` change.

### T7b — ChatGPT deep-research compatibility (optional, ~80 LOC; **ask before building**)

`search(query)` → `{results:[{id,title,url}]}` and `fetch(id)` → `{id,title,text,url,metadata}`, each returned as `structuredContent` **and** as the same JSON in a text block; thin wrappers over `search_meetings` / `get_transcript` (`metadata.truncated` when cut at the size cap). Needed only for ChatGPT deep research / company knowledge; plain developer-mode chat calls any tool. Costs two more names in every client's tool list. **RED:** result shapes match the documented schema; an empty `url` is never emitted; both carry `readOnlyHint:true`.

### T8 — Live server (`server/mcp/live.ts`) — Phase 2

- `PUT`/`DELETE /api/live/:reportId` (Firebase-token auth via `verifyFirebaseToken`, `applyPush` in a `mutate` CAS), plus `list_live_meetings` / `get_live_transcript`.
- **RED (`tests/mcp-live.test.ts`):** **no active `meetings:live` grant → 403 `{listening:false}` and the store is untouched; `probe` answers without writing; revoking mid-meeting makes the next push 403;** auth and id validation; 413 above 1 MB; 429 rate limit; 6th concurrent meeting refused; idempotent replay; 409 → reset works; **user B writing the same `reportId` never touches user A's doc; B's MCP token cannot read A's live doc**; `stale` flips at 60 s (fake clock); ended meetings readable for 30 min then gone; two active meetings and no id → error naming both ids; `meetings:live` enforced; text parity with `transkript.md` formatting.

### T9 — Live client (`src/lib/liveShare.ts`, hooks in `src/lib/capture.ts`) — **start only after P0 is merged** (it feeds from the same callback and would inherit every stall)

- Start inside `beginRecording` (after the consent record is persisted, next to `startAssemblyLive`) unconditionally — the server's probe answer decides whether any text is sent; feed it from the existing `(speech) =>` callback (already merges aliases); `pauseCapture`/resume set state; **normal stop:** `end()` runs when `finishTranscription`'s `pipeline.finish()` resolves — *not* from `releaseCapture()` (`capture.ts:188`), which runs at `rec.onstop`, before the provider's last Turn events are drained, so ending there would drop the final words from the `ended` push. `discardCapture`, `disarmCapture`, `releaseAfterHandoff` and an owner change call `end()` immediately. Add a `capture.test.ts` case: words that arrive during the final drain are in the last push.
- No settings and no armed-screen checkbox (D1). `RecordingBar`: a small "KI-Live-Freigabe aktiv" pill only while the server reports `listening:true` ("unterbrochen" on failure) — removable if you would rather not have it.
- A live-scoped grant approved **mid-meeting** takes effect within one probe interval (≤ 30 s): the tab then sends a `reset` push with the transcript so far.
- **RED (`src/lib/liveShare.test.ts`, fake timers + fake fetch):** **no request body contains transcript text until a probe answered `listening:true`; a `403 listening:false` (grant revoked) returns to 30 s probing;** ≤ 1 push per 1.5 s under a burst, exactly one in flight, trailing flush; first push has `reset:true`, later pushes are diffs, idle → heartbeat only; failure leaves `acked` unchanged and the next push re-sends the gap; 409 → reset; 401 → stop and report `off`; `end()` flushes `ended` within its timeout even with a request in flight and is idempotent; `update()` returns synchronously and never throws. Extend `src/lib/capture.test.ts` (existing harness — read it first): `liveShare` is started on every recording, sends nothing while the probe says `listening:false`, and `end()` runs on every teardown path.

### T10 — Consent wording — **DROPPED by D1 (owner: "ignore live consent"). Kept only as a sketch in case the decision is reversed; do not implement.**

- `shared/consent.ts`: `ConsentProcessor.role` gains `"live-mitlesen"`; `AI_ASSISTANT_PROCESSOR`; German/English role labels; `ConsentDecision.liveAssistant?`; `decisionFacts` appends the processor only when set; `CONSENT_TEMPLATE_VERSION = "3"`. The `means` sentence then names it, and `acceptConsentParts` already forces any rephrasing to keep the processor's name.
- **RED (`shared/consent.test.ts`):** with the flag, the notice names the processor and passes `validateConsentRecord`; **without it the notice is byte-identical to today's** (regression guard so old behaviour cannot drift); a rephrasing that drops the processor falls back to the deterministic sentence. Exact German/English wording: your sign-off before merge.

### T11 — Docs, config, rollout artifacts

- New `MCP_IMPLEMENTATION.md` (flow, envs, Firestore collections, revocation, how to connect a client); a paragraph in `CLAUDE.md`; `.env.example` (`MCP_PUBLIC_URL`, `MCP_TOKEN_SECRET`, `MCP_ALLOWED_ORIGINS`, `MCP_ACCESS_TTL_S`, `MCP_DEV_ADC`, with the `openssl rand -base64 48` hint). `firestore.rules`: **no change needed** — the existing catch-all denies `mcpGrants`/`mcpLive` to clients; T3 includes a note in the rules file saying so. Extend `scripts/smoke-deployment.mjs` only if a configured container is available in CI (it currently is not: `MCP_*` unset ⇒ endpoints degrade).

### T12 — Review gate and acceptance

- Independent review before merge, split by concern (**max 3 reviewers in parallel**, per `.claude/CLAUDE.md`): (1) OAuth/token logic, (2) storage + CAS + live protocol, (3) client/recording-path isolation. Reviewers write their **own** probes through the real Express app rather than re-running the suite; re-review the fixes with the previous findings attached (the mailindex history: green suites still hid concurrency and quota defects). Run the full suite ≥ 8 consecutive times before believing the CAS tests.
- Acceptance script in §5.

---

## 5. Verification

Commands (I have **not** run any of them yet — record a baseline on the clean tree first, so a pre-existing failure is not blamed on this work): `npm run lint`, `npm test`, `npm run build`, `npm run test:pwa`, `python3 -m unittest discover -s tests -p 'test_deploy_config.py'`, lockfile check from T1.

**Acceptance for P0 (before anything MCP):** (a) the ten tests as above; (b) P0.7 soak or an explicit 'not run'; (c) one real 60-minute-plus meeting with the tab in the background for at least 10 minutes and one deliberate network drop (airplane mode for 40 s) — live text must resume without pressing anything, and the status pill must have shown `reconnecting` and returned to normal; (d) if it stalls again, the ring buffer output is attached to the report of the failure.

**Acceptance (real client, Vienna time in any report):**
1. `hermes mcp add … --auth oauth` → consent in Chrome for Testing → `hermes mcp test` lists 4 tools (Phase 1; 6 with live; +2 with T7b).
2. Fresh Hermes process: "list my last 3 meetings" matches the dashboard.
3. Ask about a decision in a known meeting → answer quotes a line that exists in that meeting's `transkript.md` in Drive.
4. Record ~2 min with live-share on: ask twice, ~10 s apart → text grows; pause → `paused`; stop → `ended`; later `get_meeting` returns the analysed report.
5. Settings → revoke → the next MCP call is 401 and the client re-authorises.
6. Negative: a second Google account sees none of the first account's meetings (also unit-tested).
7. Kill the recording tab mid-meeting → `stale:true` within ~60 s, gone after TTL.
8. Repeat 1–3 with **Claude** (custom connector) and **ChatGPT** (Developer mode).
9. **Force a refresh:** on the test deployment set `MCP_ACCESS_TTL_S=120`; after 3 minutes Claude and ChatGPT must still answer without a new consent screen (the claude-ai-mcp tracker has conflicting reports about refresh through Claude's proxy — #228 — so this is a real test, not a formality).

---

## 6. Rollout checklist (deploy is currently disabled in CI; nothing here runs automatically)

### 6.1 Public origin (open decision D6)

What I could see (public GET requests only; **I ran no gcloud or firebase command**):
- The only production URL in the repo is `https://drive-sync-notes-gma5yake7q-nw.a.run.app` (`.github/workflows/deploy.yml`).
- Its `/api/health` returns `{"status":"ok","analysisConfigured":true}` — no `transcriptionConfigured`, which current `server.ts` reports — and `/api/auth/config` answers 404. So what runs there is **older than `main`** (CI deploy is disabled).
- `.env` says the deployed service is called `cheatmeet`, not `drive-sync-notes`, and gcloud's default project on this machine is `goedly`, which is not the Firebase project named in `.env.example`. I cannot tell which service is the live one.

| Option | What it takes | Trade-off |
|---|---|---|
| **A. Tunnel to local dev** (`cloudflared` or `ngrok`; neither is installed) | install one; pass env on the command line; `MCP_DEV_ADC=1` for Firestore | No cloud change and no deploy. The URL changes per run, so clients must re-register; the tunnel's `Host` must be allowed (Claude's own testing guide says the same for `createMcpExpressApp`). |
| **B. Second Cloud Run service** from a branch (e.g. `cheatmeet-mcp-preview`) | you deploy it, or I do with your explicit OK; same Firestore | Stable URL, isolated from the live service, closest to production. Needs cloud access. |
| **C. Production service** | re-enable the deploy job — this ships **all of `main`**, including the transcription pipeline that CI says has not yet been exercised against live accounts | Fewest moving parts, largest blast radius. |

Recommendation: **A or B** while iterating on OAuth, **C** last. Hermes needs none of this and can use `http://localhost`.

Console-only steps for whichever origin is chosen (I cannot do them): add `<origin>/api/auth/google/callback` to the authorized redirect URIs of the Google OAuth client; check whether Firebase Authentication → Settings → Authorized domains needs the origin (I have not verified that the consent page's `signInWithCredential` path requires it).

### 6.2 Deployment checklist

- New Cloud Run env: `MCP_PUBLIC_URL`, `MCP_ALLOWED_ORIGINS` (optional); new **secret** `MCP_TOKEN_SECRET`. `scripts/prepare-cloud-run.py` preserves existing env/secrets, so add these once with `gcloud run services update` (I have not run it against your service).
- Firestore TTL on `expireAt` for `mcpGrants` and `mcpLive` (`gcloud firestore fields ttls update expireAt --collection-group=… --enable-ttl`). Until enabled, expiry is enforced in code but documents linger.
- IAM: runtime service account already needs Datastore access for `driveGrants`/`transcriptionJobs`; confirm it covers the new collections (same database).
- **No change** to the Google OAuth client or its redirect URIs: MCP clients never talk to Google.
- Docs for users: where to paste the URL; that live sharing exists only while an assistant holds a `meetings:live` grant (visible in Settings → verbundene Assistenten); how to revoke.

## 7. Risks and unverified points

1. **Client compatibility beyond Hermes** (Claude/ChatGPT connectors, Inspector) is untested; connector products have their own DCR/`resource` quirks.
2. **SDK v2 moves fast.** Stable since 2026-07-27, but `server` went 2.0.0 → 2.2.0 (28 Sep) and the adapters I would pin are days old. Exact pins + the S2 bundle test; a minor bump may change APIs.
3. **S1 unknowns:** `drive.file` visibility of older meetings; Drive `fullText` on `text/markdown`. Either could make Phase 1 search weaker than planned; the plan degrades to a bounded scan with honest coverage numbers.
4. **Live hot path:** a bug in `liveShare` could hurt recording. Mitigation is structural (no awaits in the callback, swallowed errors, tests for every teardown path) but this is the riskiest client change.
5. **Privacy:** anything a connected assistant reads is processed by that assistant's vendor; you decided D1 (no live-consent step) and D5 (whole archive) knowingly. The § 201 StGB exposure the app's own notice was built to avoid is now yours for live sharing; I did not assess it.
6. **Cold-path latency:** a Drive download per transcript; large meetings paginate. No streaming.
7. Firestore's ~1 write/s/document soft limit is respected by the 1.5 s throttle; a heartbeat-only meeting costs ~240 writes/hour.
8. Dev reads real Firestore through your ADC (T3) — intended, but say so if you'd rather use fixtures.
9. **The Firestore index can lag Drive.** `saveReport` tolerates a Firestore timeout (it returns a warning), so a meeting whose index write failed exists in Drive but not in Firestore, and `list_meetings` will not show it until a later save. v1 accepts this and says so in the tool description; the fallback is a Drive folder scan (what the app's own restore does), at one Drive round-trip per meeting.
10. **P0 changes the recording path's most delicate module.** Mitigations: the eight existing tests are the regression net, GUARD F1 protects the quiet-meeting case, and the watchdog can only rebuild a *transcription* source — the `MediaRecorder` audio is never touched. The remaining risk is a watchdog false positive causing needless reconnects (each costs a few seconds of live text, not audio); thresholds are constants in one place. I could not test against the real provider from here (P0.7).
11. **Cause not proven.** The tests prove six real defects that each produce the symptom; they do not prove which one you hit. The diagnostics ring buffer (§3.8.5) exists so the next occurrence is identified rather than guessed. If you remember whether a grey/yellow banner appeared when it stalled, that narrows it now: banner with 'Lücken' suggests A–D; no banner suggests a silent provider (F2) or main-thread load (E).
12. **Live write cost.** Each push is a read plus a conditional write of the whole live document. My estimate — not measured — is 100–300 KB for a two-hour meeting; if that shows up as latency, shard turns into chunk documents. Deliberately not in v1.

## 8. Not doing (YAGNI, in v1)

Write/edit/delete tools; audio access; MCP resources/prompts; CIMD; per-meeting exclusion; API keys/PATs (OAuth only); custom-scheme redirect URIs; team/multi-user sharing; server-side transcript indexing.

## 9. Files

**New (P0):** `src/lib/assemblyLive.stall.test.ts`, differential test for `speakerLabeler`.
**New:** `shared/mcp.ts` (+test), `server/mcp/{config,docStore,firestoreRest,oauth,index,tools,meetings,live}.ts`, `src/lib/{liveShare,mcpClients}.ts` (+tests), `src/pages/ConnectPage.tsx`, `src/components/McpClients.tsx`, `tests/{mcp-config,mcp-oauth,mcp-tools,mcp-live}.test.ts`, `tests/helpers/fakeFirestore.ts`, `MCP_IMPLEMENTATION.md`.
**Modified (P0):** `src/lib/assemblyLive.ts`, `src/lib/liveTranscription.ts` (`restart`), `shared/transcription.ts` (`speakerLabeler`, `liveConnection`), `src/lib/transcriptRows.ts`, `src/lib/meetingMeta.ts`, `src/components/{SpeakerReview,LiveSpeakers,LiveMeeting,RecordingBar}.tsx`, `src/pages/RecordPage.tsx`, `src/lib/capture.ts`.
**Modified:** `server.ts`, `server/googleAuth.ts` (extract mint helper), `src/lib/capture.ts`, `src/App.tsx`, `src/pages/SettingsPage.tsx`, `src/components/RecordingBar.tsx`, `package.json`, `package-lock.json`, `bun.lock`, `.env.example`, `.gitignore`, `CLAUDE.md`.
