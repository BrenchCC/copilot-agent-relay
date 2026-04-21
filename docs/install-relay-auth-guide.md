# Install-Relay Skill: Authentication Deep Dive

## Overview

The `install-relay` skill guides first-time setup of copilot-relay, a self-hosted reverse proxy that allows Claude Code CLI to use GitHub Copilot's native Claude endpoint via a shared secret authentication model.

---

## Skill Architecture

### Entry Point
**Location:** `.claude/skills/install-relay/SKILL.md`

The skill is a **guided workflow** for users, consisting of 6 main steps:

1. **Dependency Check** - Verify Bun installation
2. **Install Dependencies** - `bun install`
3. **GitHub Device Flow Login** - Interactive user authentication
4. **Generate Shared Secret** - Create `RELAY_SECRET`
5. **Start the Relay Server** - Launch the proxy
6. **Smoke Test** - Verify health and report client config

---

## Authentication Layers

### Layer 1: Client → Relay (Shared Secret Bearer Token)

**File:** `lib/auth.ts`

```typescript
export function verifyBearer(header: string | undefined, secret: string): boolean
```

- Client sends: `Authorization: Bearer <shared-secret>`
- Relay validates using **SHA-256 + constant-time comparison** (`timingSafeEqual`)
- Secret requirement: **≥32 characters**
- Verification: `sha256(provided_token) === sha256(stored_secret)`

**In install-relay workflow:**
```bash
RELAY_SECRET=$(bun run generate-secret)
# Returns: 64-char hex string (256 bits) via randomBytes(32).toString('hex')
```

**Smoke test (step 5):**
```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health | jq
```

---

### Layer 2: GitHub Device Flow (User Authentication)

**Files:** 
- `lib/copilot-auth.ts` - Core OAuth implementation
- `cli/login.ts` - CLI wrapper
- `bin/relay.ts` - Server integration (REST endpoints)

#### Flow Diagram
```
User → "bun run login"
  ↓
POST https://github.com/login/device/code
  ├─ client_id: "Iv1.b507a08c87ecfe98"
  ├─ scope: "read:user"
  ↓
Response: { device_code, user_code, verification_uri, interval, expires_in }
  ↓
Display to user:
  • Open: https://github.com/login/device
  • Code: XXXX-XXXX
  ↓
User visits URL, enters code on GitHub.com
  ↓
Relay polls: POST https://github.com/login/oauth/access_token
  ├─ Repeat every `interval` seconds (typically 5s)
  ├─ Stops on: success, error (non-pending), or timeout (15 min default)
  ├─ Handles: "authorization_pending", "slow_down" (extends interval by 5s)
  ↓
Returns: { access_token } (GitHub OAuth token)
  ↓
Fetch username: GET https://api.github.com/user
  ├─ Authorization: token <access_token>
  ↓
Save: data/accounts/<username>.json with:
  {
    "username": "...",
    "github_token": "gho_xxx...",
    "created_at": "2026-04-15T..."
  }
```

#### Implementation Details

**RequestDeviceCode** (`lib/copilot-auth.ts:4`)
- POST to GitHub device flow endpoint
- No authentication required
- Response includes: `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in`

**PollForToken** (`lib/copilot-auth.ts:24`)
```typescript
export async function pollForToken(deviceCode: string, intervalS: number = 5): Promise<string>
```

**Key Logic:**
1. Wait `intervalS` seconds before each poll
2. Check response for:
   - `error: "authorization_pending"` → continue polling
   - `error: "slow_down"` → increase interval by 5s, continue polling
   - `error: <other>` → throw RelayError
   - `access_token` → success (return token)
3. Retries indefinitely until token or error

**⚠️ Potential Blocking Issue:**
- If user **never completes** GitHub authorization, polling loops forever
- No client-side timeout in CLI version; relies on `expires_in` (typically 900s / 15 min)
- After expiry, poll returns `error: "device_code_expired"` → RelayError thrown

**FetchUsername** (`lib/copilot-auth.ts:66`)
- GET `https://api.github.com/user`
- Authorization: `token <github_oauth_token>`
- Extracts: `.login` field
- Can fail if: token invalid, GitHub API down, network issue

---

### Layer 3: Copilot Token Exchange & Refresh

**File:** `lib/copilot-token.ts` - `TokenManager` class

#### Token Lifecycle

```
On Relay Startup:
  ↓
account.tokenManager.initialize()
  ├─ exchange() [blocking]
  │  ├─ GET https://api.github.com/copilot_internal/v2/token
  │  ├─ Authorization: token <github_oauth_token>
  │  ├─ Headers: VS Code Copilot Chat impersonation
  │  ↓
  │  Response: { token: "copilot_jwt_...", refresh_in: 1800, endpoints: { api: "..." } }
  │  ├─ token = Copilot session JWT (short-lived, typically 30 min)
  │  ├─ refresh_in = seconds until token needs refresh
  │  ├─ endpoints.api = dynamic API base URL (e.g., https://api.githubcopilot.com)
  │  ↓
  ├─ scheduleRefresh(refresh_in - 60s)
  │  └─ Background timer: refresh before expiry (60s skew)
  ↓
On Token Expiry (scheduled):
  └─ backgroundRefresh()
     ├─ exchange() again
     ├─ On failure: retry in 30s (no exponential backoff)
```

**⚠️ Critical Auth Dependency:**
- Copilot token exchange **requires valid GitHub OAuth token**
- If GitHub token invalid/revoked: **ALL requests fail** (503 Service Unavailable)
- If GitHub API unreachable: **startup blocks** in `loadAccounts()` → `initialize()`

#### Configuration

From `lib/copilot-token.ts:72`:
```typescript
const delayS = Math.max(1, refreshInS - this.refreshSkewS);
```
- `TOKEN_REFRESH_SKEW_S` default: 60 seconds (refresh 60s before expiry)
- Prevents token from expiring mid-request

---

## Auth Step in Relay Installation Flow

### From `install-relay` SKILL.md

#### **Step 2: Login GitHub Account** (THE AUTH STEP)

```bash
bun run login
```

**What happens:**
1. CLI calls `runLogin()` from `cli/login.ts`
2. Requests device code from GitHub
3. **Displays to user:**
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Open:  https://github.com/login/device
     Code:  XXXX-XXXX
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   
   Waiting for authorization...
   ```
4. **Polls GitHub** for user completion
5. **On success:**
   ```
   Authorization successful! Fetching username...
   ✓ Account "username" saved to data/accounts/username.json
   You can now start the relay with: bun run serve
   ```

**User experience:**
- Opens device code URL in browser
- Enters code on GitHub.com
- Completes GitHub 2FA if enabled
- Returns to terminal

#### **Step 3: Generate Shared Secret**

```bash
RELAY_SECRET=$(bun run generate-secret)
echo "Your RELAY_SECRET: $RELAY_SECRET"
```

- No auth required
- Generates 32 random bytes → 64 hex chars
- User must **save this value** for client config

#### **Step 4: Start the Relay**

```bash
RELAY_SECRET="$RELAY_SECRET" bun run serve
```

**At startup, relay performs auth initialization:**
1. Parse config: verify `RELAY_SECRET` ≥32 chars
2. Load accounts: scan `data/accounts/*.json`
3. For each account:
   - Create `TokenManager(github_token)`
   - **Call `initialize()`** → exchange GitHub token for Copilot JWT
   - Start usage polling background task

**⚠️ Critical: Blocking occurs here if:**
- No accounts found → Error: "No accounts found. Run: bun run login"
- GitHub API unreachable → timeout on token exchange
- GitHub token invalid → 401 from GitHub API

#### **Step 5: Smoke Test**

```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health | jq
```

**Endpoint:** `bin/relay.ts:164` - `GET /relay/health`

Response:
```json
{
  "status": "ok",
  "accounts": [
    {
      "username": "user1",
      "healthy": true,
      "hasToken": true
    }
  ]
}
```

**Success criteria:**
- Status: `"ok"`
- At least one account with `healthy: true` AND `hasToken: true`

---

## Common Issues & Troubleshooting

### Issue 1: Auth Polling Hangs on Device Code

**Symptom:** Terminal shows "Waiting for authorization..." but never completes

**Causes:**
1. **User didn't complete GitHub flow** - code expires after 15 minutes
2. **GitHub API latency** - normal polling interval is 5 seconds
3. **Network/firewall block** - can't reach github.com or api.github.com

**Resolution:**
- Verify user opened the URL and saw GitHub's device code entry
- Check internet connectivity
- Try again; device code expires and triggers error after 15 min

### Issue 2: Token Exchange Fails on Relay Startup

**Symptom:** `bun run serve` exits with:
```
Copilot token exchange failed: 401 Unauthorized
```

**Causes:**
1. **GitHub OAuth token revoked** - check GitHub settings → Developer settings → Personal access tokens
2. **GitHub API changes** - try updating headers/scope
3. **GitHub down** - check github.com status

**Resolution:**
- Re-run `bun run login` to get fresh GitHub token
- Verify token hasn't been revoked: `curl -H "Authorization: token <token>" https://api.github.com/user`

### Issue 3: Relay Initialization Blocks Forever

**Symptom:** `bun run serve` starts but never prints "Relay server listening"

**Causes:**
1. **Token exchange takes too long** - GitHub API slow
2. **Usage polling blocks** - `poller.poll()` hangs
3. **Infinite retry loop** - token refresh fails silently, retries forever

**Current Timeout Config:**
- No explicit startup timeout in code
- Token exchange: fetch timeout (browser-dependent, typically 30s)
- Usage poll: fetch timeout (same)

**Potential blocking points (from `bin/relay.ts:112`):**
```typescript
for (const acc of poolAccounts) {
  log.info("Initializing token for account", { account: acc.username });
  await acc.tokenManager.initialize();  // ← Can block here if GitHub API slow
  
  const poller = new UsagePoller(...);
  try {
    const usage = await poller.poll();  // ← Can block here if GitHub API slow
  } catch (e) {
    log.warn("Failed initial usage poll", ...);
  }
  
  poller.startBackground();  // ← Non-blocking
}
```

**Resolution:**
- Check GitHub status: https://www.githubstatus.com
- Run with `LOG_LEVEL=debug` for detailed logs
- Consider timeout of 30s reasonable; if >30s, network issue likely

### Issue 4: Smoke Test Shows `"hasToken": false`

**Symptom:** Health check returns account with `"hasToken": false`

**Cause:** Token exchange failed silently (retry loop, no token yet)

**Resolution:**
- Wait a few seconds (background retry in 30s intervals)
- Check logs for exchange errors
- Try restarting relay

### Issue 5: Multiple Accounts & Account Selection

**Scenario:** You added 2 accounts, but relay picks wrong one

**Current behavior:**
- AccountPool uses **sticky selection** (same account until failure)
- On failover, moves to next account
- After `ACCOUNT_COOLDOWN_MS` (default 5 min), failed account becomes healthy again

**No round-robin or preference system** - fixed order from `data/accounts/` filesystem listing.

---

## Auth Header Injection

**File:** `lib/rewriter.ts` - Copilot-specific headers injected on every request

```
Host: <removed>
Authorization: Bearer <copilot_session_jwt>          ← From TokenManager
editor-version: vscode/1.110.1
editor-plugin-version: copilot-chat/0.38.2
user-agent: GitHubCopilotChat/0.38.2
x-github-api-version: 2025-10-01
copilot-integration-id: vscode-chat
openai-intent: conversation-agent
x-initiator: user|agent                             ← Inferred from request
x-request-id: <deterministic-sha256-uuid>
```

**Key:** `Authorization: Bearer <copilot_session_jwt>` changes every `refresh_in` seconds.

---

## Test Coverage

### Auth-specific tests

**File:** `test/copilot-auth.test.ts`

- ✅ `requestDeviceCode()` - success case
- ✅ `pollForToken()` - authorization_pending → success
- ✅ `fetchUsername()` - returns GitHub login

**File:** `test/copilot-token.test.ts`

- ✅ `TokenManager.initialize()` - exchanges GitHub token for Copilot JWT
- ✅ Fallback API base when endpoints missing
- ✅ Deduplication of concurrent refresh calls
- ✅ Throws on exchange failure (401)

**No explicit test for:**
- Device code expiration
- Slow polling (slow_down error)
- Token refresh scheduling
- Background refresh retry loop

---

## Configuration for Auth

**File:** `lib/config.ts`

| Env Var | Default | Impact on Auth |
|---------|---------|---|
| `RELAY_SECRET` | **required** | Client → Relay verification |
| `TOKEN_REFRESH_SKEW_S` | 60 | Pre-refresh buffer (prevent expiry mid-request) |
| `ACCOUNT_COOLDOWN_MS` | 300000 (5m) | How long account marked failed before recovery |
| `DATA_DIR` | `./data` | Where to store GitHub OAuth tokens (`accounts/*.json`) |
| `LOG_LEVEL` | `info` | Set to `debug` to see auth details |

---

## Relay as Skill Entry Point

**Server also supports REST device flow** (for integration with Claude Code UI):

**Endpoint:** `POST /relay/login/start` (from `bin/relay.ts:209`)

**Purpose:** Allow skill to trigger device flow without running CLI command

**Response:**
```json
{
  "user_code": "XXXX-XXXX",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "device_code": "dc_xxx"
}
```

**Then skill polls:** `GET /relay/login/status?device_code=<code>` until:
- `{ "status": "complete", "username": "..." }`
- `{ "status": "expired" }`
- `{ "status": "pending" }`

---

## Summary: Auth Flow Execution Path

```
User runs: bun run login
    ↓
requestDeviceCode() 
    → POST https://github.com/login/device/code
    ← { device_code, user_code, verification_uri, interval }
    ↓
Display prompt (user opens browser, enters code)
    ↓
pollForToken(device_code, interval)
    → Loop: POST https://github.com/login/oauth/access_token
    ← Poll every `interval` seconds (5s default)
    ← Handle "authorization_pending", "slow_down"
    ← Return when user completes GitHub flow
    ↓
fetchUsername(access_token)
    → GET https://api.github.com/user
    ← { "login": "username" }
    ↓
Save: data/accounts/username.json
    { "username": "...", "github_token": "gho_xxx", "created_at": "..." }
    
---

User starts relay: bun run serve
    ↓
parseConfig()
    ├─ Verify RELAY_SECRET ≥32 chars
    ↓
loadAccounts()
    ├─ Scan data/accounts/*.json
    ├─ Create TokenManager(github_token) for each
    ↓
For each account:
    ├─ tokenManager.initialize()
    │  ├─ exchange()
    │  │  → GET https://api.github.com/copilot_internal/v2/token
    │  │  ← { token: "cop_jwt_...", refresh_in: 1800, endpoints }
    │  ├─ scheduleRefresh(refresh_in - 60s)
    │  └─ Background refresh every 30 min ± skew
    │
    ├─ UsagePoller.poll()
    │  → GET https://api.github.com/copilot_internal/user
    │  ← { copilot_plan, quota_snapshots, endpoints }
    │
    └─ poller.startBackground()
       └─ Poll every 5 minutes
       
---

Client connects: curl -H "Authorization: Bearer <RELAY_SECRET>" http://localhost:8787/v1/messages
    ↓
verifyBearer(header, RELAY_SECRET)
    ├─ Extract token from "Bearer <token>"
    ├─ SHA-256 comparison (constant-time)
    ├─ On failure: 401 Unauthorized
    ↓
Select healthy account (AccountPool)
    ├─ Get current account's TokenManager
    ├─ Check token freshness, refresh if needed
    ↓
Inject headers (rewriter.ts)
    ├─ Replace Authorization with Copilot JWT
    ├─ Add VS Code impersonation headers
    ↓
Forward to Copilot API
    ├─ POST {api_base}/v1/messages
    ├─ Stream response back
    ↓
Log audit entry (token counts, status, etc.)
```

---

## Key Takeaways for Auth Implementation

1. **Two-tier auth:** Shared secret (client ↔ relay) + GitHub OAuth (relay ↔ GitHub)
2. **Blocking risk:** Device code polling & token exchange both require network I/O
3. **Failure modes:** Invalid GitHub token, GitHub API down, expired device code
4. **Token management:** TokenManager handles refresh automatically; no persistence of Copilot JWT
5. **Audit trail:** All requests logged with account, initiator, and token counts
6. **Multi-account:** Sticky failover, 5-min cooldown, no round-robin
