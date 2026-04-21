# Install-Relay Auth: Quick Reference

## 3-Tier Auth Model

```
┌─────────────────────────────────────────────────────────────┐
│ Client (Claude Code)                                        │
│ Authorization: Bearer <RELAY_SECRET>                        │
│ ↓ (verified by verifyBearer in lib/auth.ts)               │
├─────────────────────────────────────────────────────────────┤
│ Relay Server (localhost:8787)                              │
│ - Holds RELAY_SECRET                                       │
│ - Holds GitHub OAuth token in data/accounts/*.json         │
│ ↓ (exchanges GitHub token for Copilot JWT)               │
├─────────────────────────────────────────────────────────────┤
│ GitHub API + Copilot API                                   │
│ - oauth: github.com/login/device/code                      │
│ - token: api.github.com/copilot_internal/v2/token         │
│ - usage: api.github.com/copilot_internal/user             │
└─────────────────────────────────────────────────────────────┘
```

---

## Auth Step Flowchart

```
install-relay skill invoked
    ↓
[Prerequisites: Bun installed?]
    ↓ YES
[Run: bun install]
    ↓
┌─ [Step 2: Auth] ────────────────────────────────────┐
│ $ bun run login                                     │
│   ↓                                                 │
│   POST /github.com/login/device/code               │
│   ↓ Get device_code + user_code                    │
│   ↓ Display: "Open: ... Code: ..."                 │
│   ↓                                                 │
│   ⏳ POLLING: POST /github/oauth/access_token      │
│   └─ Repeat every 5s until:                         │
│      ✓ authorization_pending → continue             │
│      ✓ slow_down → slow down (extend interval +5s) │
│      ✓ access_token → return token                 │
│      ✗ error/timeout → throw error                 │
│   ↓ Save token to data/accounts/<username>.json    │
└─────────────────────────────────────────────────────┘
    ↓
[Step 3: Generate RELAY_SECRET]
    ↓
[Step 4: Start relay]
    ├─ BLOCKING POINTS:
    │  • Load accounts: scan data/accounts/
    │  • Initialize TokenManager for each account
    │    ├─ exchange(): GET /copilot_internal/v2/token
    │    └─ On error: throw + exit (no fallback)
    │  • Poll usage: GET /copilot_internal/user
    │    └─ On error: warn + continue (retry in background)
    ↓
[Step 5: Smoke test]
    ├─ curl /relay/health
    └─ Verify: "healthy": true, "hasToken": true
```

---

## File Locations & Key Functions

### Authentication Code

| File | Function | Purpose |
|------|----------|---------|
| `lib/auth.ts` | `verifyBearer()` | Client → Relay bearer token validation |
| `lib/copilot-auth.ts` | `requestDeviceCode()` | GET GitHub device code |
| `lib/copilot-auth.ts` | `pollForToken()` | Poll for GitHub OAuth token |
| `lib/copilot-auth.ts` | `fetchUsername()` | GET GitHub username |
| `lib/copilot-token.ts` | `TokenManager.initialize()` | Exchange GitHub token for Copilot JWT |
| `lib/copilot-token.ts` | `TokenManager.exchange()` | POST to GitHub for Copilot token |
| `lib/copilot-token.ts` | `backgroundRefresh()` | Refresh token every ~30 min |
| `cli/login.ts` | `runLogin()` | CLI entry for `bun run login` |
| `bin/relay.ts` | `loadAccounts()` | Load accounts from data/accounts/ |
| `bin/relay.ts` | `serve()` | Startup: initialize accounts, start server |

### Data Storage

| Path | Contains | Format |
|------|----------|--------|
| `data/accounts/<username>.json` | GitHub OAuth token | `{ username, github_token, created_at }` |
| `data/relay.key` | Alternative RELAY_SECRET | Raw hex string (optional) |
| `data/audit.jsonl` | Request audit log | JSONL (token counts, status, etc.) |

---

## Error Messages & Causes

### During `bun run login`

```
error: authorization_pending
→ Normal, polling continues

error: slow_down
→ GitHub throttling, interval += 5s

error: device_code_expired
→ User took >15 min, code expired. Re-run `bun run login`

error: invalid_grant
→ Device code or code expired. Re-run `bun run login`

error: access_denied
→ User denied on GitHub. Re-run `bun run login`
```

### During `bun run serve`

```
RELAY_SECRET must be at least 32 characters
→ Set RELAY_SECRET env var to 64-char hex string

No accounts found. Run: bun run login
→ No files in data/accounts/. Run `bun run login` first

Copilot token exchange failed: 401 Unauthorized
→ GitHub OAuth token revoked or invalid. Re-run `bun run login`

Copilot token exchange failed: 4xx
→ GitHub API issue or Copilot endpoint changed. Check GitHub status

Copilot token exchange failed: 5xx
→ GitHub/Copilot down. Check status pages

Failed initial usage poll
→ Warning only; relay continues (retries in background)

All accounts unavailable
→ All GitHub tokens invalid/revoked. Add new account with `bun run login`
```

---

## Common Scenarios

### Scenario 1: First Time Setup

```bash
# 1. Generate secret
RELAY_SECRET=$(bun run generate-secret)
echo $RELAY_SECRET  # Save this!

# 2. Login
bun run login
# → Opens browser, user enters code, token saved

# 3. Start relay
RELAY_SECRET="$RELAY_SECRET" bun run serve
# → Should print "Relay server listening"

# 4. Test in new terminal
curl -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health | jq
```

### Scenario 2: Add Second Account

```bash
# On relay machine (assuming relay already running)
bun run login
# → Follow same flow, saves to data/accounts/<new_username>.json

# Relay automatically discovers and uses new account on restart
# or hot-reload (if implemented)
```

### Scenario 3: Token Revoked

```bash
# Client gets 503: All accounts unavailable
# → Fix: Re-run `bun run login` on relay machine
bun run login
# This replaces old token with new one
# Relay discovers on next refresh cycle or restart
```

### Scenario 4: Relay Stops Responding

```bash
# Client hangs on request (no 503)
# → Likely blocking on token exchange at startup
# Restart with debug logs:
LOG_LEVEL=debug RELAY_SECRET="$RELAY_SECRET" bun run serve

# If still blocks >30s, network issue likely
# Verify: curl https://api.github.com/user
```

---

## Timeout Behavior

| Operation | Timeout | Where | Failure Mode |
|-----------|---------|-------|---|
| Device code polling | 15 min (expires_in) | `pollForToken()` | Throws "device_code_expired" |
| Fetch username | 30s (fetch default) | `fetchUsername()` | Throws RelayError |
| GitHub OAuth token POST | 30s (fetch default) | `pollForToken()` | Retry loop, then error |
| Copilot token exchange | 30s (fetch default) | `TokenManager.exchange()` | Startup error or retry |
| Usage poll | 30s (fetch default) | `UsagePoller.poll()` | Warning, retry in 5 min |
| Upstream request | 300s (configurable) | `upstream.ts` | 504 after timeout |

---

## Environment Variables

```bash
# Required
RELAY_SECRET=<64-char-hex>          # Bearer token for clients

# Optional (defaults shown)
RELAY_PORT=8787                     # Server port
RELAY_BIND=127.0.0.1               # Server listen address
DATA_DIR=./data                     # Account & audit storage
LOG_LEVEL=info                      # debug|info|warn|error
TOKEN_REFRESH_SKEW_S=60             # Pre-refresh buffer
ACCOUNT_COOLDOWN_MS=300000          # Failure recovery timeout
UPSTREAM_TIMEOUT_MS=300000          # Upstream request timeout
FORCE_AGENT_INITIATOR=off           # off|session|always
```

---

## Testing Auth

### Unit Tests
```bash
bun test test/copilot-auth.test.ts
bun test test/copilot-token.test.ts
```

### Manual Test: Device Flow
```bash
$ bun run login
[follow prompts]
$ cat data/accounts/*.json  # Verify token saved
```

### Manual Test: Token Exchange
```bash
$ RELAY_SECRET="$RELAY_SECRET" bun run serve &
$ sleep 2
$ curl -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health | jq
{
  "status": "ok",
  "accounts": [{"username": "...", "healthy": true, "hasToken": true}]
}
```

### Manual Test: Bearer Verification
```bash
# Wrong secret
$ curl -H "Authorization: Bearer wrongsecret" http://127.0.0.1:8787/relay/health
{"error":"Unauthorized"}

# Missing header
$ curl http://127.0.0.1:8787/relay/health
{"error":"Unauthorized"}

# Valid secret
$ curl -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health
{"status":"ok","accounts":[...]}
```

---

## Debugging Auth Issues

### Enable debug logs
```bash
LOG_LEVEL=debug RELAY_SECRET="..." bun run serve
```

### Check GitHub token validity
```bash
TOKEN=$(cat data/accounts/*.json | jq -r .github_token)
curl -H "Authorization: token $TOKEN" https://api.github.com/user
```

### Check token exchange
```bash
TOKEN=$(cat data/accounts/*.json | jq -r .github_token)
curl -H "Authorization: token $TOKEN" \
  -H "editor-version: vscode/1.110.1" \
  -H "editor-plugin-version: copilot-chat/0.38.2" \
  -H "user-agent: GitHubCopilotChat/0.38.2" \
  -H "x-github-api-version: 2025-10-01" \
  https://api.github.com/copilot_internal/v2/token
```

### Check GitHub status
```bash
curl https://www.githubstatus.com/api/v2/status.json
```

### Monitor polling during login
```bash
# Terminal 1: Start relay with debug
LOG_LEVEL=debug RELAY_SECRET="$RELAY_SECRET" bun run serve

# Terminal 2: Run login
bun run login

# Watch Terminal 1 for polling messages
```

---

## Security Notes

1. **RELAY_SECRET:** Store safely, ≥32 chars, unique per relay
2. **GitHub tokens:** 0600 permissions on `data/accounts/` files
3. **Copilot JWTs:** Not persisted, re-exchanged on startup
4. **Bearer verification:** Constant-time comparison (SHA-256)
5. **Token rotation:** Automatic via background refresh
6. **Audit log:** Logs token counts, not full requests/responses
