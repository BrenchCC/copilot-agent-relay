# Copilot Relay Design Spec

A self-hosted, local reverse proxy that lets Claude Code CLI use a GitHub Copilot subscription. The relay authenticates with Copilot via GitHub OAuth, manages multiple accounts with failover, and transparently forwards Anthropic Messages API requests to Copilot's native Claude endpoint.

## Architecture Overview

### Core Premise

GitHub Copilot natively supports Claude models via the `/v1/messages` endpoint (Anthropic Messages format). This means requests from Claude Code can be forwarded to Copilot with near-zero modification — only authentication headers and Copilot-specific metadata need to be injected.

### Request Flow

```
Claude Code CLI
  → Authorization: Bearer <RELAY_SECRET>
  → POST /v1/messages (Anthropic format)
      │
copilot-relay (Bun, localhost)
  ├── Verify shared secret (constant-time)
  ├── Read request body (for X-Initiator inference + audit)
  ├── Select healthy account (account pool + failover)
  ├── Get valid Copilot session token (auto-refresh)
  ├── Infer X-Initiator from message history
  ├── Inject Copilot headers + replace Authorization
  ├── Forward to Copilot API
  ├── Stream response through usage tap
  ├── Write audit log entry
  └── Stream response back to client
```

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript (strict) |
| HTTP Server | `node:http` (stdlib) |
| HTTP Client | `node:http` / `node:https` for proxy; `fetch` (Bun global) for auth flows |
| Dependencies | Zero runtime deps (only `bun-types` and `typescript` as devDeps) |

### Project Structure

```
copilot-relay/
├── bin/
│   └── relay.ts              # Main entry point (serve + CLI commands)
├── lib/
│   ├── config.ts             # Environment variable parsing → Config object
│   ├── types.ts              # TypeScript interfaces & RelayError class
│   ├── auth.ts               # Shared-secret bearer token verification
│   ├── copilot-auth.ts       # GitHub Device Flow login
│   ├── copilot-token.ts      # Copilot token exchange & background refresh
│   ├── account-pool.ts       # Multi-account pool + failover
│   ├── initiator.ts          # X-Initiator inference logic
│   ├── rewriter.ts           # Header injection (Copilot headers)
│   ├── upstream.ts           # HTTP forwarding to Copilot API
│   ├── audit.ts              # JSONL audit log writer
│   ├── usage-tap.ts          # SSE/JSON stream parser for token counting
│   ├── usage-poll.ts         # Background Copilot quota polling (per account)
│   ├── stats.ts              # Audit log aggregation engine (includes usage/quota)
│   └── logger.ts             # Structured JSON logger (stdout/stderr)
├── cli/
│   └── login.ts              # `copilot-relay login` Device Flow CLI
├── test/                     # Unit + integration tests
├── .claude/
│   └── skills/
│       ├── install-relay/SKILL.md
│       └── start-relay/SKILL.md
├── data/                     # Runtime data (accounts, audit log)
├── docs/
├── package.json
└── tsconfig.json
```

## Authentication & Token Lifecycle

### Client → Relay (Shared Secret)

Identical to claude-code-relay:

- Client sets `ANTHROPIC_AUTH_TOKEN=<shared-secret>`, Claude Code sends `Authorization: Bearer <secret>`
- `auth.ts` uses SHA-256 + `timingSafeEqual` for constant-time comparison
- Secret must be ≥32 characters, enforced at startup

### GitHub Device Flow Login (One-Time)

`copilot-auth.ts` + `cli/login.ts`:

1. `POST https://github.com/login/device/code` with `client_id: "Iv1.b507a08c87ecfe98"` → returns `device_code`, `user_code`, `verification_uri`, `interval`
2. Prompt user to visit `verification_uri` and enter `user_code`
3. Poll `POST https://github.com/login/oauth/access_token` with `client_id`, `device_code`, `grant_type: "urn:ietf:params:oauth:grant-type:device_code"`
   - `authorization_pending` → continue polling
   - `slow_down` → interval += 5s
   - Success → returns `access_token` (GitHub OAuth token)
4. `GET https://api.github.com/user` to fetch username
5. Save to `data/accounts/<username>.json`: `{ "username": "xxx", "github_token": "gho_xxx", "created_at": "..." }`

**CLI entry**: `bun run bin/relay.ts login`
**Skill entry**: skill calls `POST http://localhost:<port>/relay/login/start` which initiates Device Flow and returns `{ user_code, verification_uri, expires_in }`. Skill presents these to the user. Then skill polls `GET /relay/login/status?device_code=<code>` until it returns `{ status: "complete", username: "..." }` or `{ status: "pending" }` or `{ status: "expired" }`

### Copilot Token Exchange & Refresh

`copilot-token.ts` implements `TokenManager` per account:

**Exchange:**
```
GET https://api.github.com/copilot_internal/v2/token
Headers:
  Authorization: token <github_oauth_token>
  editor-version: vscode/1.110.1
  editor-plugin-version: copilot-chat/0.38.2
  user-agent: GitHubCopilotChat/0.38.2
  x-github-api-version: 2025-10-01
→ returns { token, refresh_in, endpoints }
```

**Refresh strategy:**
- `refresh_at = now + (refresh_in - 60s)`
- Background timer re-exchanges when due
- Failure retries after 30 seconds
- Concurrent requests share a single in-flight refresh promise (deduplication)
- Token updated atomically (single variable swap behind a promise lock)

**API base URL:**
- Primarily from `GET /copilot_internal/user` → `endpoints.api` (polled every 5 min, cached)
- Fallback from token exchange response `endpoints["api"]`
- Last resort: `https://api.individual.githubcopilot.com`

### Token Storage

```
data/
├── accounts/
│   ├── user1.json    # { username, github_token, created_at }
│   └── user2.json
└── relay.key         # Shared secret file (alternative to RELAY_SECRET env var)
```

- File permissions 0600
- GitHub tokens are long-lived; Copilot session tokens are not persisted (re-exchanged on startup)

## Account Pool & Failover

### AccountPool Structure

```typescript
interface Account {
  username: string;
  githubToken: string;
  tokenManager: TokenManager;
  failedAt: number | null;     // null = healthy
}

class AccountPool {
  accounts: Account[];
  currentIndex: number;        // sticky current account
  cooldownMs: number;          // default 5 minutes
}
```

### Failover Logic

1. Pick sticky current account
2. Check health: `failedAt === null` or past cooldown period
   - Past cooldown → auto-recover, clear `failedAt`
3. Forward request with that account
4. On 4xx/5xx or connection error:
   - Set `failedAt = Date.now()`
   - Advance to next healthy account, retry
5. All accounts exhausted → return 503
6. On success → update sticky index

### Account Management

- **Add**: `bun run bin/relay.ts login` completes Device Flow, auto-joins pool
- **Load on startup**: scan `data/accounts/*.json`, create `TokenManager` per account
- **Remove**: delete json file, restart relay (no hot-reload in MVP)
- **Minimum 1 account**: startup error if `data/accounts/` is empty

### Request Distribution

Sticky + failover (not round-robin):
- Always use the same account until it fails
- Switch on failure, original recovers after cooldown
- Avoids unnecessary request scattering, easier audit trail

## Request Forwarding & Header Injection

### Header Processing (rewriter.ts)

**Stripped headers** (from client, not forwarded to Copilot):
- `authorization` (replaced with Copilot token)
- `host`, `content-length`, `connection`, `keep-alive` (hop-by-hop)
- `accept-encoding` (ensure upstream returns uncompressed for usage-tap parsing)

**Injected headers** (impersonating VS Code Copilot Chat):
```
authorization: Bearer <copilot-session-token>
editor-version: vscode/1.110.1
editor-plugin-version: copilot-chat/0.38.2
user-agent: GitHubCopilotChat/0.38.2
x-github-api-version: 2025-10-01
copilot-integration-id: vscode-chat
openai-intent: conversation-agent
x-initiator: <user|agent>
x-request-id: <deterministic UUID from SHA-256(sessionId + lastUserContent)>
```

**Passed through**: remaining client headers (`accept`, `content-type`, etc.)

### X-Initiator Inference (initiator.ts)

Determines whether a request consumes premium Copilot quota. Only checks the **last message** in the `messages` array:

| Condition | Initiator | Rationale |
|-----------|-----------|-----------|
| No messages | `user` | Safe default |
| Last message `role=user`, content has non-`tool_result` blocks | `user` | User-initiated interaction |
| Last message `role=user`, content is ALL `tool_result` | `agent` | Tool continuation (free) |
| Last message `role=user` with `tool_result` + `text` mixed | `agent` | Tool follow-up |
| Compact/summarization request detected | `agent` | Internal context compression |
| Parse failure | `user` | Conservative fallback |

**Compact detection signals** (any one triggers):
1. System prompt starts with `"You are a helpful AI assistant tasked with summarizing conversations"`
2. Message contains `"CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."`
3. Message contains both `"Pending Tasks:"` and `"Current Work:"`

**Deterministic request ID**: SHA-256 hash of `sessionId + lastUserContent` → stable UUID for `x-request-id` header, enabling Copilot deduplication.

### Body Handling

Near-zero modification — Copilot natively supports Anthropic Messages format for Claude models.

Body is read for:
- X-Initiator inference (check messages array)
- Audit logging (extract model field)
- Body itself forwarded as-is, no rewriting

### Upstream Forwarding (upstream.ts)

- Target: `{api_base}/{original_path}` where `api_base` is dynamically obtained from `GET /copilot_internal/user` → `endpoints.api` (typically `https://api.githubcopilot.com`, may differ for enterprise users)
- Fallback: `https://api.individual.githubcopilot.com` if endpoint discovery fails
- Method: `node:http` / `node:https` native request
- Response: streamed back, no buffering
- Timeout: 300 seconds (configurable via `UPSTREAM_TIMEOUT_MS`)
- Response headers: hop-by-hop filtered, rest passed through

## Audit, Stats & Management Endpoints

### Audit Log (audit.ts)

JSONL format, one line per request, written to `data/audit.jsonl`:

```json
{
  "ts": "2026-04-15T10:30:00.000Z",
  "duration_ms": 1523,
  "method": "POST",
  "path": "/v1/messages",
  "status": 200,
  "model": "claude-sonnet-4-5-20250514",
  "account": "user1",
  "initiator": "agent",
  "message_id": "msg_xxx",
  "input_tokens": 1200,
  "output_tokens": 350,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 800,
  "stop_reason": "end_turn"
}
```

Never logs request/response bodies.

### Usage Tap (usage-tap.ts)

Transform stream that parses responses inline:
- **SSE mode** (`text/event-stream`): parse events on the fly. `message_start` → model, input_tokens. `message_delta` → output_tokens, stop_reason.
- **JSON mode** (`application/json`): buffer up to 1MB, parse at flush
- **Other content types**: pure passthrough

### Stats & Usage

#### Copilot Quota Polling (usage-poll.ts)

Copilot provides a real-time quota API:

**Endpoint**: `GET https://api.github.com/copilot_internal/user`
**Auth**: GitHub OAuth token (not Copilot JWT)
**Headers**: same VS Code Copilot Chat impersonation headers

Response structure:
```json
{
  "copilot_plan": "copilot_for_individual",
  "quota_reset_date": "2026-05-01",
  "quota_snapshots": {
    "chat": { "entitlement": 1000, "remaining": 800, "percent_remaining": 80.0, "unlimited": false },
    "completions": { "entitlement": 5000, "remaining": 4500, "percent_remaining": 90.0, "unlimited": false },
    "premium_interactions": { "entitlement": 300, "remaining": 250, "percent_remaining": 83.3, "unlimited": false }
  },
  "endpoints": { "api": "https://api.githubcopilot.com" }
}
```

- Background polling every 5 minutes per account
- Also used at startup to discover dynamic API base URL (`endpoints.api`)
- Cached result served at `GET /relay/usage`

`GET /relay/usage` returns:
```json
{
  "accounts": [
    {
      "username": "user1",
      "copilot_plan": "copilot_for_individual",
      "quota_reset_date": "2026-05-01",
      "premium_interactions": { "entitlement": 300, "remaining": 250, "percent_remaining": 83.3, "unlimited": false },
      "queried_at": "2026-04-15T10:30:00.000Z"
    }
  ]
}
```

#### Stats Aggregation (stats.ts)

`GET /relay/stats?since=24h&until=now`

Local audit log aggregation with premium/non-premium breakdown:

```json
{
  "period": { "since": "...", "until": "..." },
  "totals": {
    "requests": 120,
    "premium_requests": 15,
    "non_premium_requests": 105,
    "input_tokens": 50000,
    "output_tokens": 20000
  },
  "by_model": [
    { "model": "claude-sonnet-4-5-20250514", "requests": 100, "premium_requests": 10, "..." : "..." }
  ],
  "by_account": [
    { "account": "user1", "requests": 80, "premium_requests": 8, "..." : "..." }
  ],
  "by_initiator": {
    "user": 15,
    "agent": 105
  }
}
```

Supports relative time (`30m`, `1h`, `24h`, `7d`) and ISO 8601.

### Management Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/relay/stats` | Audit log aggregation (local) |
| `GET` | `/relay/usage` | Copilot quota per account (from upstream API) |
| `GET` | `/relay/health` | Health check (token status, pool state) |
| `POST` | `/relay/login/start` | Trigger Device Flow (for skill use) |
| `GET` | `/relay/login/status` | Poll Device Flow result |
| `*` | `/*` | Everything else proxied to Copilot API |

All management endpoints require `Authorization: Bearer <RELAY_SECRET>`.

## Configuration

### Environment Variables (config.ts)

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_SECRET` | (required) | Shared secret ≥32 chars |
| `RELAY_PORT` | `8787` | Listen port |
| `RELAY_BIND` | `127.0.0.1` | Listen address |
| `DATA_DIR` | `./data` | Data directory (accounts, audit log) |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `UPSTREAM_TIMEOUT_MS` | `300000` (5min) | Upstream request timeout |
| `ACCOUNT_COOLDOWN_MS` | `300000` (5min) | Account failure cooldown |
| `TOKEN_REFRESH_SKEW_S` | `60` | Token pre-refresh seconds |

### CLI Commands

Via `bin/relay.ts` as entry point:

```bash
bun run bin/relay.ts serve            # Start relay server
bun run bin/relay.ts login            # Login GitHub account (Device Flow)
bun run bin/relay.ts accounts         # List logged-in accounts
bun run bin/relay.ts generate-secret  # Generate shared secret
```

### Skills

#### `install-relay` Skill

Guides first-time setup:
1. Check prerequisites (Bun installed)
2. `bun install`
3. Guide login of at least one GitHub account
4. Generate `RELAY_SECRET`
5. Start relay service
6. End-to-end smoke test (`/relay/health`)
7. Output client config:
   ```
   ANTHROPIC_BASE_URL=http://127.0.0.1:8787
   ANTHROPIC_AUTH_TOKEN=<your-secret>
   ```

#### `start-relay` Skill

Day-to-day operations:
1. Start/restart relay
2. Check account token status
3. Smoke test
4. Report health

### Client Usage

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_AUTH_TOKEN=<relay-secret> \
claude
```
