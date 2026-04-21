---
name: start-relay
description: Start or restart copilot-relay and verify health
---

# Start Copilot Relay

Day-to-day operations for copilot-relay.

## Steps

### 0. Check if accounts exist

```bash
ls data/accounts/*.json 2>/dev/null
```

If **no accounts** are found, **DO NOT run `bun run login` yourself**. Instead, stop and tell the user:

> No GitHub accounts found. Please run the following command manually first (it requires interactive browser authorization):
>
> ```
> bun run login
> ```
>
> After login completes, ask me to start the relay.

**Do not proceed** until accounts exist.

### 1. Check if relay is already running

```bash
bun run status
```

Also check the health endpoint:
```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health 2>/dev/null | jq
```

If health responds with `"status": "ok"`, the relay is already running — skip to Step 3.

### 2. Start or restart the relay

The relay uses PM2 for process management (config in `ecosystem.config.cjs`).

To start:
```bash
bun run start
```

To restart (if already running but unhealthy):
```bash
bun run restart
```

To view logs if something looks wrong:
```bash
bun run logs
```

### 3. Verify Health

```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health | jq
```

Check:
- `status` is `"ok"`
- At least one account is `"healthy": true`
- At least one account has `"hasToken": true`

### 4. Check Usage

```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/usage | jq
```

Report the premium interactions remaining for each account.

### 5. Check Recent Stats

```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" "http://127.0.0.1:8787/relay/stats?since=24h" | jq
```

Report request counts, premium vs non-premium breakdown, and per-model/per-account stats.
