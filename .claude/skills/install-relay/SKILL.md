---
name: install-relay
description: First-time setup for copilot-relay
---

# Install Copilot Relay

Guide the user through first-time setup of copilot-relay.

## Prerequisites Check

1. Verify Bun is installed: `bun --version`
2. Verify we're in the copilot-relay project directory (check for `package.json` with `"name": "copilot-relay"`)

## Steps

### 1. Install Dependencies

```bash
bun install
```

### 2. Login GitHub Account

Check if any accounts already exist:
```bash
ls data/accounts/*.json 2>/dev/null
```

If accounts already exist, skip to Step 3.

If **no accounts** are found, **DO NOT run `bun run login` yourself**. Instead, stop and tell the user:

> No GitHub accounts found. Please run the following command manually (it requires interactive browser authorization):
>
> ```
> bun run login
> ```
>
> After login completes, ask me to continue the setup.

**Do not proceed** until the user confirms they have completed the login.

### 3. Choose Initiator Strategy

Ask the user to choose an initiator strategy for `FORCE_AGENT_INITIATOR`. This controls the `x-initiator` header sent to GitHub Copilot, which determines whether a request consumes **premium** quota:

| Mode | Behavior | Recommended for |
|------|----------|-----------------|
| `off` | Infer from request body (user-turn = `user`, tool-continuation/compact = `agent`) | Accurate accounting; you want real premium vs non-premium tracking |
| `session` | First turn of a conversation = `user`, all subsequent turns = `agent` | **Most users**: only the first message per session counts as premium, maximizing free quota |
| `always` | Every request sent as `agent` | Maximum quota savings; all requests treated as non-premium |

Default is `off` if not set. **Recommend `session`** for most users — it balances quota savings with natural usage patterns.

Save the user's choice — it will be passed as `FORCE_AGENT_INITIATOR` when starting the relay.

### 4. Generate Shared Secret

```bash
RELAY_SECRET=$(bun run generate-secret)
echo "Your RELAY_SECRET: $RELAY_SECRET"
```

Tell the user to save this secret — they'll need it for client configuration.

### 5. Configure and Start the Relay

The relay uses PM2 for process management (auto-restart on crash, log management). The PM2 config is in `ecosystem.config.cjs`.

Ensure the user's choices for `relaySecret` and `forceAgentInitiator` are saved in `.relay-config.json`, then start via PM2:

```bash
bun run start
```

Verify it launched:
```bash
bun run status
```

Available PM2 commands:
- `bun run start` — start the relay
- `bun run stop` — stop the relay
- `bun run restart` — restart the relay
- `bun run logs` — view recent logs
- `bun run status` — check process status

To persist across server reboots:
```bash
bunx pm2 save
bunx pm2 startup
```

### 6. Self-Test

Verify the relay is fully operational by running these checks in order:

#### 6a. Health Check

```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health | jq
```

Verify:
- `status` is `"ok"`
- At least one account has `"healthy": true` and `"hasToken": true`

If any account shows `"hasToken": false`, the Copilot token exchange may still be in progress — wait a few seconds and retry.

#### 6b. Inference Test

Run the real end-to-end Claude CLI test through the relay:

```bash
RELAY_SECRET="$RELAY_SECRET" bun run e2e
```

This test launches the local `claude` CLI and forces it to use the relay via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, then verifies the returned text exactly matches the expected value. If it fails, check the relay logs and Claude CLI output for details.

#### 6c. Usage Check

```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/usage | jq
```

Report each account's premium interactions remaining and quota reset date.

### 7. Report Summary

After all checks pass, output a summary for the user:

```
=== Copilot Relay Setup Complete ===

Relay URL:        http://127.0.0.1:8787
Accounts:         <list of usernames>
Initiator mode:   <chosen_mode>
RELAY_SECRET:     <the generated secret>

Client configuration (add to shell profile):

  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  export ANTHROPIC_AUTH_TOKEN=<RELAY_SECRET>

Then run: claude
```
