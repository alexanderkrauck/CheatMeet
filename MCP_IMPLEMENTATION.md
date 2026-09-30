# MCP access: past and live transcripts for AI assistants

CheatMeet exposes the signed-in user's meetings to any MCP client (Claude,
ChatGPT, Hermes, …) after the user approves it with their Google sign-in.
Everything is **read-only**.

## What an assistant can do

| Tool | Scope | Purpose |
|---|---|---|
| `list_meetings` | `meetings:read` | Past meetings, newest first; date filter and paging |
| `get_meeting` | `meetings:read` | Summary, to-dos, takeaways, participants |
| `get_transcript` | `meetings:read` | Full transcript of a past meeting, paged |
| `search_meetings` | `meetings:read` | Titles, summaries, to-dos and transcripts; reports how much it covered |
| `list_live_meetings` | `meetings:live` | Meetings being recorded right now |
| `get_live_transcript` | `meetings:live` | What has been said so far; `since_ms` to follow along |

The tool list a client sees follows the scopes the user granted.

## How it fits together

```
assistant ── POST /api/mcp (Bearer) ──► server/mcp/index.ts   stateless Streamable HTTP
    │                                       │ verifies the token, reads the grant every time
    │                                       ├─ past:  Firestore users/{uid}/reports  +  Drive transkript.md
    │                                       └─ live:  Firestore mcpLive/{uid:meetingId}
    └─ OAuth ─► /api/oauth/*  (server/mcp/oauth.ts)  ─► consent page /connect (Google sign-in)

recording tab ── PUT /api/live/:id (Firebase ID token) ──► server/mcp/live.ts
```

- **Google is the login, not the authorization server.** Google offers neither
  dynamic client registration nor client-ID metadata documents, so CheatMeet
  issues its own tokens. The assistant never receives a Google or Drive token;
  Drive is read by the server with the refresh token it already holds.
- **Stateless.** No MCP session is kept, so any instance answers any call and
  a restart loses nothing. Grants and live transcripts are in Firestore
  (`mcpGrants`, `mcpLive`, server-only: `firestore.rules` denies clients).
- **Client ids are signed, not stored.** Registration keeps no data; a
  registration flood costs nothing.

## Configuration

| Variable | Meaning |
|---|---|
| `MCP_PUBLIC_URL` | The public origin, no path. OAuth issuer and token audience. **Required.** |
| `MCP_TOKEN_SECRET` | ≥ 32 bytes, signs tokens. **Required**, a secret in production. |
| `MCP_ALLOWED_ORIGINS` | Extra browser origins for `/api/mcp` (own origin, claude.ai, chatgpt.com are built in). |
| `MCP_ACCESS_TTL_S` | Access-token lifetime, 60–3600 (default 3600). Lower it to test refresh. |
| `MCP_DEV_ADC=1` | Dev only: use real Firestore with your gcloud login instead of local files. |

Without the first two the feature is off: `/api/mcp` answers 503,
`/api/health` reports `mcpConfigured: false`. Nothing else is affected.

Connect a client to `<MCP_PUBLIC_URL>/api/mcp`. Hermes:
`hermes mcp add cheatmeet --url <url>/api/mcp --auth oauth`. Claude and
ChatGPT need a **publicly reachable https** address (they call from their own
servers), so `localhost` works for Hermes only.

## Deployment checklist

1. Set `MCP_PUBLIC_URL`, and `MCP_TOKEN_SECRET` as a **secret**.
2. Enable a Firestore **TTL policy** on `expireAt` for collection groups
   `mcpGrants` and `mcpLive` (`gcloud firestore fields ttls update expireAt
   --collection-group=mcpGrants --enable-ttl`, same for `mcpLive`). Until then
   expiry is enforced when reading, but documents linger.
3. The runtime service account already needs Firestore access for
   `driveGrants`; confirm it covers the new collections (same database).
4. No change to the Google OAuth client: assistants never talk to Google.
5. `firestore.rules` needs no change; its catch-all already denies these paths.

## Security properties worth keeping

- Authorization codes: 60 s, single use; a second use revokes the grant.
- Refresh tokens rotate; a stale one turning up after 10 s revokes the grant.
- PKCE `S256` only; redirect URIs must be `https` or loopback and are matched exactly.
- Tokens are bound to the MCP URL (audience); the grant is read on every call, so
  revocation is immediate (Settings → Verbundene Assistenten).
- Every tool takes the account from the verified token. No tool accepts a user id.
- Live text is stored **only while** the account holds an active `meetings:live`
  grant. Otherwise the server answers `listening: false` and writes nothing.
- The consent page refuses to be framed.
- Logs never contain transcript text or tokens.

## Known limits

- The archive index in Firestore can lag Drive (a save tolerates a Firestore
  timeout), so a meeting whose index write failed is missing from `list_meetings`.
- `search_meetings` reads at most 60 transcripts (newest first) within 20 s and
  says so in `transcript_coverage`.
- Live: the recording tab is the source. If it closes, the meeting turns `stale`
  after 60 s and disappears after its TTL.
- Whole-archive access: there is no per-meeting exclusion; revoking the grant is
  the only control.
