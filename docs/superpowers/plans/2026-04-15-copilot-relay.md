# Copilot Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Bun/TypeScript reverse proxy that lets Claude Code CLI use GitHub Copilot subscriptions, with multi-account failover, premium quota optimization, and audit logging.

**Architecture:** Zero-dependency relay using `node:http` stdlib. Requests from Claude Code arrive as Anthropic Messages API format, get Copilot headers injected (auth token, VS Code impersonation, X-Initiator), and forward to Copilot's native `/v1/messages` endpoint. Multiple GitHub accounts rotate via sticky failover. Background polling tracks Copilot quota.

**Tech Stack:** Bun runtime, TypeScript (strict), `node:http`/`node:https` for proxying, `fetch` for auth flows, `bun:test` for testing.

**Design spec:** `docs/superpowers/specs/2026-04-15-copilot-relay-design.md`

---

## File Map

| File | Responsibility |
|------|---------------|
| `package.json` | Project metadata, scripts, devDependencies |
| `tsconfig.json` | TypeScript strict config for Bun |
| `lib/logger.ts` | Structured JSON logger (stdout/stderr), log levels |
| `lib/types.ts` | All TypeScript interfaces, RelayError class |
| `lib/config.ts` | Environment variable parsing → Config object |
| `lib/auth.ts` | Shared-secret bearer token verification (constant-time) |
| `lib/copilot-auth.ts` | GitHub Device Flow login (request codes, poll for token) |
| `lib/copilot-token.ts` | Copilot JWT exchange & background refresh (TokenManager) |
| `lib/account-pool.ts` | Multi-account pool with sticky failover |
| `lib/initiator.ts` | X-Initiator inference from message history |
| `lib/rewriter.ts` | Header stripping + Copilot header injection |
| `lib/upstream.ts` | HTTP forwarding to Copilot API (streaming) |
| `lib/usage-tap.ts` | SSE/JSON transform stream for token counting |
| `lib/usage-poll.ts` | Background Copilot quota polling per account |
| `lib/audit.ts` | JSONL audit log writer |
| `lib/stats.ts` | Audit log aggregation engine |
| `cli/login.ts` | CLI Device Flow login command |
| `bin/relay.ts` | Main entry point (CLI router + HTTP server) |
| `.claude/skills/install-relay/SKILL.md` | First-time setup skill |
| `.claude/skills/start-relay/SKILL.md` | Day-to-day operations skill |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "copilot-relay",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "serve": "bun run bin/relay.ts serve",
    "login": "bun run bin/relay.ts login",
    "accounts": "bun run bin/relay.ts accounts",
    "generate-secret": "bun run bin/relay.ts generate-secret",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "bun-types": "latest",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["bin/**/*.ts", "lib/**/*.ts", "cli/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
data/accounts/
data/audit.jsonl
data/relay.key
*.tmp
```

- [ ] **Step 4: Install dependencies**

Run: `bun install`
Expected: `bun-types` and `typescript` installed, `bun.lockb` created.

- [ ] **Step 5: Remove stale .gitkeep files and create cli/ directory**

```bash
rm bin/.gitkeep lib/.gitkeep test/.gitkeep systemd/.gitkeep docs/.gitkeep .claude/skills/.gitkeep
mkdir -p cli data/accounts
```

- [ ] **Step 6: Verify typecheck**

Run: `bun run typecheck`
Expected: passes (no source files yet, no errors)

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore bun.lockb cli/ data/
git rm bin/.gitkeep lib/.gitkeep test/.gitkeep systemd/.gitkeep docs/.gitkeep .claude/skills/.gitkeep
git commit -m "chore: scaffold project with package.json, tsconfig, gitignore"
```

---

### Task 2: Logger

**Files:**
- Create: `lib/logger.ts`
- Create: `test/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/logger.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createLogger, LogLevel, type Logger } from "../lib/logger";

describe("logger", () => {
  let output: string[];
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;

  beforeEach(() => {
    output = [];
    originalStdout = process.stdout.write;
    originalStderr = process.stderr.write;
    process.stdout.write = (chunk: any) => {
      output.push(chunk.toString());
      return true;
    };
    process.stderr.write = (chunk: any) => {
      output.push(chunk.toString());
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  });

  test("logs at or above configured level", () => {
    const log = createLogger(LogLevel.INFO);
    log.info("hello", { key: "val" });
    expect(output.length).toBe(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.key).toBe("val");
    expect(typeof parsed.ts).toBe("string");
  });

  test("suppresses below configured level", () => {
    const log = createLogger(LogLevel.WARN);
    log.info("hidden");
    log.debug("also hidden");
    expect(output.length).toBe(0);
  });

  test("error logs to stderr", () => {
    const stderrOutput: string[] = [];
    process.stderr.write = (chunk: any) => {
      stderrOutput.push(chunk.toString());
      return true;
    };
    const log = createLogger(LogLevel.DEBUG);
    log.error("fail", { code: 500 });
    expect(stderrOutput.length).toBe(1);
    const parsed = JSON.parse(stderrOutput[0]);
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("fail");
    expect(parsed.code).toBe(500);
  });

  test("debug level outputs debug messages", () => {
    const log = createLogger(LogLevel.DEBUG);
    log.debug("trace info");
    expect(output.length).toBe(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.level).toBe("debug");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/logger.test.ts`
Expected: FAIL — cannot resolve `../lib/logger`

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/logger.ts
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "debug",
  [LogLevel.INFO]: "info",
  [LogLevel.WARN]: "warn",
  [LogLevel.ERROR]: "error",
};

export function parseLogLevel(s: string): LogLevel {
  switch (s.toLowerCase()) {
    case "debug": return LogLevel.DEBUG;
    case "info": return LogLevel.INFO;
    case "warn": return LogLevel.WARN;
    case "error": return LogLevel.ERROR;
    default: return LogLevel.INFO;
  }
}

export function createLogger(level: LogLevel): Logger {
  function emit(lvl: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (lvl < level) return;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level: LEVEL_NAMES[lvl],
      msg,
      ...data,
    });
    const out = lvl >= LogLevel.ERROR ? process.stderr : process.stdout;
    out.write(entry + "\n");
  }

  return {
    debug: (msg, data) => emit(LogLevel.DEBUG, msg, data),
    info: (msg, data) => emit(LogLevel.INFO, msg, data),
    warn: (msg, data) => emit(LogLevel.WARN, msg, data),
    error: (msg, data) => emit(LogLevel.ERROR, msg, data),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/logger.test.ts`
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/logger.ts test/logger.test.ts
git commit -m "feat: add structured JSON logger with level filtering"
```

---

### Task 3: Types & Config

**Files:**
- Create: `lib/types.ts`
- Create: `lib/config.ts`
- Create: `test/config.test.ts`

- [ ] **Step 1: Create types.ts**

```typescript
// lib/types.ts

export class RelayError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export interface AccountFile {
  username: string;
  github_token: string;
  created_at: string;
}

export interface CopilotTokenResponse {
  token: string;
  refresh_in: number;
  endpoints?: Record<string, string>;
}

export interface QuotaDetail {
  entitlement: number;
  remaining: number;
  percent_remaining: number;
  unlimited: boolean;
}

export interface CopilotUsageResponse {
  copilot_plan: string;
  quota_reset_date: string;
  quota_snapshots: {
    chat: QuotaDetail;
    completions: QuotaDetail;
    premium_interactions: QuotaDetail;
  };
  endpoints?: { api: string };
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface AuditEntry {
  ts: string;
  duration_ms: number;
  method: string;
  path: string;
  status: number;
  model: string;
  account: string;
  initiator: string;
  message_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  stop_reason: string;
}

export interface UsageTapResult {
  model: string;
  message_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  stop_reason: string;
}

export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export const COPILOT_HEADERS = {
  "editor-version": "vscode/1.110.1",
  "editor-plugin-version": "copilot-chat/0.38.2",
  "user-agent": "GitHubCopilotChat/0.38.2",
  "x-github-api-version": "2025-10-01",
} as const;

export const DEFAULT_API_BASE = "https://api.individual.githubcopilot.com";
```

- [ ] **Step 2: Write config test**

```typescript
// test/config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseConfig } from "../lib/config";

describe("config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all RELAY_ and related env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("RELAY_") || key === "DATA_DIR" || key === "LOG_LEVEL") {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  test("throws if RELAY_SECRET is missing", () => {
    expect(() => parseConfig()).toThrow("RELAY_SECRET");
  });

  test("throws if RELAY_SECRET is too short", () => {
    process.env.RELAY_SECRET = "short";
    expect(() => parseConfig()).toThrow("32");
  });

  test("parses valid config with defaults", () => {
    process.env.RELAY_SECRET = "a".repeat(32);
    const cfg = parseConfig();
    expect(cfg.secret).toBe("a".repeat(32));
    expect(cfg.port).toBe(8787);
    expect(cfg.bind).toBe("127.0.0.1");
    expect(cfg.dataDir).toBe("./data");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.upstreamTimeoutMs).toBe(300000);
    expect(cfg.accountCooldownMs).toBe(300000);
    expect(cfg.tokenRefreshSkewS).toBe(60);
  });

  test("parses overridden values", () => {
    process.env.RELAY_SECRET = "b".repeat(64);
    process.env.RELAY_PORT = "9000";
    process.env.RELAY_BIND = "0.0.0.0";
    process.env.DATA_DIR = "/tmp/data";
    process.env.LOG_LEVEL = "debug";
    process.env.UPSTREAM_TIMEOUT_MS = "60000";
    process.env.ACCOUNT_COOLDOWN_MS = "120000";
    process.env.TOKEN_REFRESH_SKEW_S = "30";
    const cfg = parseConfig();
    expect(cfg.port).toBe(9000);
    expect(cfg.bind).toBe("0.0.0.0");
    expect(cfg.dataDir).toBe("/tmp/data");
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.upstreamTimeoutMs).toBe(60000);
    expect(cfg.accountCooldownMs).toBe(120000);
    expect(cfg.tokenRefreshSkewS).toBe(30);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — cannot resolve `../lib/config`

- [ ] **Step 4: Write config implementation**

```typescript
// lib/config.ts
import { RelayError } from "./types";

export interface Config {
  secret: string;
  port: number;
  bind: string;
  dataDir: string;
  logLevel: string;
  upstreamTimeoutMs: number;
  accountCooldownMs: number;
  tokenRefreshSkewS: number;
}

export function parseConfig(): Config {
  const secret = process.env.RELAY_SECRET;
  if (!secret) {
    throw new RelayError("RELAY_SECRET environment variable is required", 500, "CONFIG_MISSING");
  }
  if (secret.length < 32) {
    throw new RelayError("RELAY_SECRET must be at least 32 characters", 500, "CONFIG_INVALID");
  }

  return {
    secret,
    port: parseInt(process.env.RELAY_PORT ?? "8787", 10),
    bind: process.env.RELAY_BIND ?? "127.0.0.1",
    dataDir: process.env.DATA_DIR ?? "./data",
    logLevel: (process.env.LOG_LEVEL ?? "info").toLowerCase(),
    upstreamTimeoutMs: parseInt(process.env.UPSTREAM_TIMEOUT_MS ?? "300000", 10),
    accountCooldownMs: parseInt(process.env.ACCOUNT_COOLDOWN_MS ?? "300000", 10),
    tokenRefreshSkewS: parseInt(process.env.TOKEN_REFRESH_SKEW_S ?? "60", 10),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/config.test.ts`
Expected: all 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/config.ts test/config.test.ts
git commit -m "feat: add types, constants, and config parser"
```

---

### Task 4: Shared-Secret Auth

**Files:**
- Create: `lib/auth.ts`
- Create: `test/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/auth.test.ts
import { describe, test, expect } from "bun:test";
import { verifyBearer } from "../lib/auth";

describe("verifyBearer", () => {
  const secret = "a]9f!2xK#mP7vR$wL4nQ8yT&hB6jE0cZ";

  test("accepts valid bearer token", () => {
    expect(verifyBearer(`Bearer ${secret}`, secret)).toBe(true);
  });

  test("rejects wrong token", () => {
    expect(verifyBearer("Bearer wrong-token-value-here-1234567890", secret)).toBe(false);
  });

  test("rejects missing Authorization header", () => {
    expect(verifyBearer(undefined, secret)).toBe(false);
  });

  test("rejects non-Bearer scheme", () => {
    expect(verifyBearer(`Basic ${secret}`, secret)).toBe(false);
  });

  test("rejects empty bearer value", () => {
    expect(verifyBearer("Bearer ", secret)).toBe(false);
  });

  test("is constant-time (different lengths don't short-circuit)", () => {
    // Both should return false; we just verify they don't throw
    expect(verifyBearer("Bearer x", secret)).toBe(false);
    expect(verifyBearer(`Bearer ${"z".repeat(1000)}`, secret)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/auth.test.ts`
Expected: FAIL — cannot resolve `../lib/auth`

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/auth.ts
import { createHash, timingSafeEqual } from "node:crypto";

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

export function verifyBearer(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (!token) return false;

  const provided = sha256(token);
  const expected = sha256(secret);
  return timingSafeEqual(provided, expected);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/auth.test.ts`
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/auth.ts test/auth.test.ts
git commit -m "feat: add constant-time shared-secret auth"
```

---

### Task 5: GitHub Device Flow Login

**Files:**
- Create: `lib/copilot-auth.ts`
- Create: `test/copilot-auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/copilot-auth.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { requestDeviceCode, pollForToken, fetchUsername } from "../lib/copilot-auth";

describe("copilot-auth", () => {
  describe("requestDeviceCode", () => {
    test("returns device code response on success", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              device_code: "dc_123",
              user_code: "ABCD-1234",
              verification_uri: "https://github.com/login/device",
              expires_in: 900,
              interval: 5,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      );
      globalThis.fetch = mockFetch as any;

      const result = await requestDeviceCode();
      expect(result.device_code).toBe("dc_123");
      expect(result.user_code).toBe("ABCD-1234");
      expect(result.verification_uri).toBe("https://github.com/login/device");
      expect(result.interval).toBe(5);

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://github.com/login/device/code");
      expect(opts.method).toBe("POST");
    });
  });

  describe("pollForToken", () => {
    test("returns token after authorization_pending then success", async () => {
      let callCount = 0;
      const mockFetch = mock(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "authorization_pending" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: "gho_abc123", token_type: "bearer" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      });
      globalThis.fetch = mockFetch as any;

      const token = await pollForToken("dc_123", 0.01); // 10ms interval for test speed
      expect(token).toBe("gho_abc123");
      expect(callCount).toBe(2);
    });
  });

  describe("fetchUsername", () => {
    test("returns username from GitHub API", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ login: "testuser" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as any;

      const username = await fetchUsername("gho_abc123");
      expect(username).toBe("testuser");

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/user");
      expect((opts.headers as Record<string, string>)["authorization"]).toBe("token gho_abc123");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/copilot-auth.test.ts`
Expected: FAIL — cannot resolve `../lib/copilot-auth`

- [ ] **Step 3: Write implementation**

```typescript
// lib/copilot-auth.ts
import { COPILOT_CLIENT_ID, COPILOT_HEADERS, type DeviceCodeResponse } from "./types";
import { RelayError } from "./types";

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const resp = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!resp.ok) {
    throw new RelayError(`Device code request failed: ${resp.status}`, resp.status);
  }

  return (await resp.json()) as DeviceCodeResponse;
}

export async function pollForToken(deviceCode: string, intervalS: number = 5): Promise<string> {
  let interval = intervalS;

  while (true) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = (await resp.json()) as Record<string, string>;

    if (data.error === "authorization_pending") {
      continue;
    }

    if (data.error === "slow_down") {
      interval += 5;
      continue;
    }

    if (data.error) {
      throw new RelayError(`OAuth polling error: ${data.error}`, 400, data.error);
    }

    if (data.access_token) {
      return data.access_token;
    }

    throw new RelayError("Unexpected OAuth response: no access_token and no error", 500);
  }
}

export async function fetchUsername(githubToken: string): Promise<string> {
  const resp = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `token ${githubToken}`,
      accept: "application/json",
      ...COPILOT_HEADERS,
    },
  });

  if (!resp.ok) {
    throw new RelayError(`Failed to fetch GitHub user: ${resp.status}`, resp.status);
  }

  const data = (await resp.json()) as { login: string };
  return data.login;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/copilot-auth.test.ts`
Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/copilot-auth.ts test/copilot-auth.test.ts
git commit -m "feat: add GitHub Device Flow login (copilot-auth)"
```

---

### Task 6: Copilot Token Manager

**Files:**
- Create: `lib/copilot-token.ts`
- Create: `test/copilot-token.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/copilot-token.test.ts
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { TokenManager } from "../lib/copilot-token";

describe("TokenManager", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("exchanges GitHub token for Copilot token", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            token: "cop_jwt_123",
            refresh_in: 1800,
            endpoints: { api: "https://api.githubcopilot.com" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ) as any;

    const tm = new TokenManager("gho_test123");
    await tm.initialize();

    expect(tm.getToken()).toBe("cop_jwt_123");
    expect(tm.getApiBase()).toBe("https://api.githubcopilot.com");

    tm.dispose();
  });

  test("uses fallback API base when endpoints missing", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ token: "cop_jwt_456", refresh_in: 1800 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ) as any;

    const tm = new TokenManager("gho_test456");
    await tm.initialize();

    expect(tm.getToken()).toBe("cop_jwt_456");
    expect(tm.getApiBase()).toBe("https://api.individual.githubcopilot.com");

    tm.dispose();
  });

  test("deduplicates concurrent refresh calls", async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({ token: `cop_jwt_${callCount}`, refresh_in: 1800 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as any;

    const tm = new TokenManager("gho_dedup");
    // Two concurrent initializations should only trigger one fetch
    await Promise.all([tm.initialize(), tm.initialize()]);

    expect(callCount).toBe(1);
    tm.dispose();
  });

  test("throws on exchange failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 })),
    ) as any;

    const tm = new TokenManager("gho_bad");
    await expect(tm.initialize()).rejects.toThrow();
    tm.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/copilot-token.test.ts`
Expected: FAIL — cannot resolve `../lib/copilot-token`

- [ ] **Step 3: Write implementation**

```typescript
// lib/copilot-token.ts
import { COPILOT_HEADERS, DEFAULT_API_BASE, type CopilotTokenResponse } from "./types";
import { RelayError } from "./types";

const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";

export class TokenManager {
  private token: string = "";
  private apiBase: string = DEFAULT_API_BASE;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private inflightRefresh: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly githubToken: string,
    private readonly refreshSkewS: number = 60,
  ) {}

  async initialize(): Promise<void> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }
    this.inflightRefresh = this.exchange();
    try {
      await this.inflightRefresh;
    } finally {
      this.inflightRefresh = null;
    }
  }

  getToken(): string {
    return this.token;
  }

  getApiBase(): string {
    return this.apiBase;
  }

  setApiBase(base: string): void {
    this.apiBase = base;
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async exchange(): Promise<void> {
    const resp = await fetch(TOKEN_EXCHANGE_URL, {
      headers: {
        authorization: `token ${this.githubToken}`,
        accept: "application/json",
        ...COPILOT_HEADERS,
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new RelayError(
        `Copilot token exchange failed: ${resp.status} ${body}`,
        resp.status,
        "TOKEN_EXCHANGE_FAILED",
      );
    }

    const data = (await resp.json()) as CopilotTokenResponse;
    this.token = data.token;

    if (data.endpoints?.api) {
      this.apiBase = data.endpoints.api;
    }

    this.scheduleRefresh(data.refresh_in);
  }

  private scheduleRefresh(refreshInS: number): void {
    if (this.disposed) return;

    const delayS = Math.max(1, refreshInS - this.refreshSkewS);
    this.refreshTimer = setTimeout(() => this.backgroundRefresh(), delayS * 1000);
  }

  private async backgroundRefresh(): Promise<void> {
    if (this.disposed) return;

    try {
      await this.exchange();
    } catch {
      // Retry after 30 seconds on failure
      if (!this.disposed) {
        this.refreshTimer = setTimeout(() => this.backgroundRefresh(), 30_000);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/copilot-token.test.ts`
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/copilot-token.ts test/copilot-token.test.ts
git commit -m "feat: add Copilot token exchange and background refresh"
```

---

### Task 7: X-Initiator Inference

**Files:**
- Create: `lib/initiator.ts`
- Create: `test/initiator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/initiator.test.ts
import { describe, test, expect } from "bun:test";
import { inferInitiator } from "../lib/initiator";

describe("inferInitiator", () => {
  test("returns 'user' for empty messages", () => {
    expect(inferInitiator({ messages: [] })).toBe("user");
  });

  test("returns 'user' when no messages field", () => {
    expect(inferInitiator({})).toBe("user");
  });

  test("returns 'user' for single user text message", () => {
    expect(
      inferInitiator({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }),
    ).toBe("user");
  });

  test("returns 'agent' when last user message is all tool_result", () => {
    expect(
      inferInitiator({
        messages: [
          { role: "user", content: [{ type: "text", text: "Hi" }] },
          { role: "assistant", content: [{ type: "text", text: "Let me check" }] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }],
          },
        ],
      }),
    ).toBe("agent");
  });

  test("returns 'agent' when last user message mixes tool_result and text", () => {
    expect(
      inferInitiator({
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "done" },
              { type: "text", text: "continue" },
            ],
          },
        ],
      }),
    ).toBe("agent");
  });

  test("returns 'agent' for compact summarization request", () => {
    expect(
      inferInitiator({
        system: "You are a helpful AI assistant tasked with summarizing conversations for context",
        messages: [{ role: "user", content: [{ type: "text", text: "Summarize this" }] }],
      }),
    ).toBe("agent");
  });

  test("returns 'agent' for compact with CRITICAL marker", () => {
    expect(
      inferInitiator({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Summarize." },
            ],
          },
        ],
      }),
    ).toBe("agent");
  });

  test("returns 'agent' for compact with Pending Tasks + Current Work", () => {
    expect(
      inferInitiator({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Pending Tasks:\n- Fix bug\n\nCurrent Work:\n- Reviewing code" },
            ],
          },
        ],
      }),
    ).toBe("agent");
  });

  test("returns 'user' on parse failure (non-object body)", () => {
    expect(inferInitiator(null as any)).toBe("user");
    expect(inferInitiator("bad" as any)).toBe("user");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/initiator.test.ts`
Expected: FAIL — cannot resolve `../lib/initiator`

- [ ] **Step 3: Write implementation**

```typescript
// lib/initiator.ts

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface Message {
  role: string;
  content: ContentBlock[] | string;
}

interface RequestBody {
  system?: string | Array<{ type: string; text: string }>;
  messages?: Message[];
}

function getSystemText(system: RequestBody["system"]): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function getMessageText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b): b is ContentBlock & { text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function isCompact(body: RequestBody): boolean {
  const systemText = getSystemText(body.system);

  // Signal 1: summarization system prompt
  if (systemText.startsWith("You are a helpful AI assistant tasked with summarizing conversations")) {
    return true;
  }

  // Check all messages for signals 2 and 3
  const messages = body.messages ?? [];
  for (const msg of messages) {
    const text = getMessageText(msg);

    // Signal 2: CRITICAL no-tools marker
    if (text.includes("CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.")) {
      return true;
    }

    // Signal 3: Pending Tasks + Current Work
    if (text.includes("Pending Tasks:") && text.includes("Current Work:")) {
      return true;
    }
  }

  return false;
}

export function inferInitiator(body: unknown): "user" | "agent" {
  try {
    if (!body || typeof body !== "object") return "user";

    const parsed = body as RequestBody;

    // Check compact first — always agent
    if (isCompact(parsed)) return "agent";

    const messages = parsed.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) return "user";

    // Only check the last message
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user") return "user";

    const content = last.content;
    if (!Array.isArray(content) || content.length === 0) return "user";

    const hasToolResult = content.some((b) => b.type === "tool_result");
    if (hasToolResult) return "agent";

    return "user";
  } catch {
    return "user";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/initiator.test.ts`
Expected: all 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/initiator.ts test/initiator.test.ts
git commit -m "feat: add X-Initiator inference for premium quota optimization"
```

---

### Task 8: Header Rewriter

**Files:**
- Create: `lib/rewriter.ts`
- Create: `test/rewriter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/rewriter.test.ts
import { describe, test, expect } from "bun:test";
import { rewriteHeaders } from "../lib/rewriter";

describe("rewriteHeaders", () => {
  test("strips forbidden headers and injects Copilot headers", () => {
    const input: Record<string, string> = {
      authorization: "Bearer my-relay-secret-value",
      host: "localhost:8787",
      "content-type": "application/json",
      "accept-encoding": "gzip",
      "user-agent": "claude-code/1.0",
      connection: "keep-alive",
      accept: "text/event-stream",
    };

    const result = rewriteHeaders(input, {
      copilotToken: "cop_jwt_test",
      initiator: "agent",
      requestId: "req-uuid-123",
    });

    // Stripped
    expect(result["accept-encoding"]).toBeUndefined();
    expect(result["connection"]).toBeUndefined();
    expect(result["host"]).toBeUndefined();

    // Injected
    expect(result["authorization"]).toBe("Bearer cop_jwt_test");
    expect(result["editor-version"]).toBe("vscode/1.110.1");
    expect(result["editor-plugin-version"]).toBe("copilot-chat/0.38.2");
    expect(result["user-agent"]).toBe("GitHubCopilotChat/0.38.2");
    expect(result["x-github-api-version"]).toBe("2025-10-01");
    expect(result["copilot-integration-id"]).toBe("vscode-chat");
    expect(result["openai-intent"]).toBe("conversation-agent");
    expect(result["x-initiator"]).toBe("agent");
    expect(result["x-request-id"]).toBe("req-uuid-123");

    // Passed through
    expect(result["content-type"]).toBe("application/json");
    expect(result["accept"]).toBe("text/event-stream");
  });

  test("handles missing optional headers gracefully", () => {
    const result = rewriteHeaders({}, {
      copilotToken: "tok",
      initiator: "user",
      requestId: "id",
    });
    expect(result["authorization"]).toBe("Bearer tok");
    expect(result["x-initiator"]).toBe("user");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/rewriter.test.ts`
Expected: FAIL — cannot resolve `../lib/rewriter`

- [ ] **Step 3: Write implementation**

```typescript
// lib/rewriter.ts
import { COPILOT_HEADERS } from "./types";

const STRIPPED_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "accept-encoding",
  "transfer-encoding",
]);

export interface RewriteOptions {
  copilotToken: string;
  initiator: "user" | "agent";
  requestId: string;
}

export function rewriteHeaders(
  incoming: Record<string, string>,
  opts: RewriteOptions,
): Record<string, string> {
  const result: Record<string, string> = {};

  // Pass through non-stripped headers
  for (const [key, value] of Object.entries(incoming)) {
    if (!STRIPPED_HEADERS.has(key.toLowerCase())) {
      result[key.toLowerCase()] = value;
    }
  }

  // Inject Copilot headers
  result["authorization"] = `Bearer ${opts.copilotToken}`;
  result["editor-version"] = COPILOT_HEADERS["editor-version"];
  result["editor-plugin-version"] = COPILOT_HEADERS["editor-plugin-version"];
  result["user-agent"] = COPILOT_HEADERS["user-agent"];
  result["x-github-api-version"] = COPILOT_HEADERS["x-github-api-version"];
  result["copilot-integration-id"] = "vscode-chat";
  result["openai-intent"] = "conversation-agent";
  result["x-initiator"] = opts.initiator;
  result["x-request-id"] = opts.requestId;

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/rewriter.test.ts`
Expected: all 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/rewriter.ts test/rewriter.test.ts
git commit -m "feat: add header rewriter with Copilot header injection"
```

---

### Task 9: Upstream Forwarder

**Files:**
- Create: `lib/upstream.ts`
- Create: `test/upstream.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/upstream.test.ts
import { describe, test, expect } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { forwardRequest } from "../lib/upstream";

function startMockUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

describe("forwardRequest", () => {
  test("forwards request and streams response back", async () => {
    const upstream = await startMockUpstream((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "x-custom": "yes" });
        res.end(JSON.stringify({ echo: body, method: req.method, path: req.url }));
      });
    });

    try {
      const result = await forwardRequest({
        method: "POST",
        path: "/v1/messages",
        headers: { "content-type": "application/json", "x-test": "1" },
        body: Buffer.from('{"hello":"world"}'),
        apiBase: `http://127.0.0.1:${upstream.port}`,
        timeoutMs: 5000,
      });

      expect(result.statusCode).toBe(200);
      expect(result.headers["x-custom"]).toBe("yes");
      // Connection/hop-by-hop headers should be filtered
      expect(result.headers["connection"]).toBeUndefined();

      const chunks: Buffer[] = [];
      for await (const chunk of result.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      expect(body.method).toBe("POST");
      expect(body.path).toBe("/v1/messages");
      expect(body.echo).toBe('{"hello":"world"}');
    } finally {
      upstream.close();
    }
  });

  test("handles upstream errors", async () => {
    await expect(
      forwardRequest({
        method: "GET",
        path: "/test",
        headers: {},
        body: Buffer.alloc(0),
        apiBase: "http://127.0.0.1:1", // closed port
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/upstream.test.ts`
Expected: FAIL — cannot resolve `../lib/upstream`

- [ ] **Step 3: Write implementation**

```typescript
// lib/upstream.ts
import * as http from "node:http";
import * as https from "node:https";
import type { Readable } from "node:stream";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export interface ForwardOptions {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  apiBase: string;
  timeoutMs: number;
}

export interface ForwardResult {
  statusCode: number;
  headers: Record<string, string>;
  body: Readable;
}

function filterHopByHop(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) {
      result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return result;
}

export function forwardRequest(opts: ForwardOptions): Promise<ForwardResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.path, opts.apiBase);
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: opts.method,
        headers: {
          ...opts.headers,
          "content-length": String(opts.body.length),
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        resolve({
          statusCode: res.statusCode ?? 502,
          headers: filterHopByHop(res.headers as Record<string, string | string[] | undefined>),
          body: res,
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Upstream request timed out"));
    });

    req.end(opts.body);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/upstream.test.ts`
Expected: all 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/upstream.ts test/upstream.test.ts
git commit -m "feat: add streaming upstream forwarder with hop-by-hop filtering"
```

---

### Task 10: Usage Tap (SSE/JSON Stream Parser)

**Files:**
- Create: `lib/usage-tap.ts`
- Create: `test/usage-tap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/usage-tap.test.ts
import { describe, test, expect } from "bun:test";
import { Transform, PassThrough } from "node:stream";
import { createUsageTap, type UsageTapResult } from "../lib/usage-tap";

function streamToBuffer(stream: Transform): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

describe("usage-tap", () => {
  test("parses SSE stream and extracts usage from message_start and message_delta", async () => {
    const { transform, getResult } = createUsageTap("text/event-stream");

    const sseData = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-5-20250514","usage":{"input_tokens":100,"output_tokens":0,"cache_creation_input_tokens":10,"cache_read_input_tokens":50}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const source = new PassThrough();
    source.pipe(transform);
    source.end(sseData);

    const output = await streamToBuffer(transform);
    // Data should pass through unchanged
    expect(output.toString()).toBe(sseData);

    const result = getResult();
    expect(result.model).toBe("claude-sonnet-4-5-20250514");
    expect(result.message_id).toBe("msg_01");
    expect(result.input_tokens).toBe(100);
    expect(result.output_tokens).toBe(25);
    expect(result.cache_creation_input_tokens).toBe(10);
    expect(result.cache_read_input_tokens).toBe(50);
    expect(result.stop_reason).toBe("end_turn");
  });

  test("parses JSON response", async () => {
    const { transform, getResult } = createUsageTap("application/json");

    const jsonBody = JSON.stringify({
      id: "msg_02",
      model: "claude-sonnet-4-5-20250514",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
      },
    });

    const source = new PassThrough();
    source.pipe(transform);
    source.end(jsonBody);

    const output = await streamToBuffer(transform);
    expect(output.toString()).toBe(jsonBody);

    const result = getResult();
    expect(result.model).toBe("claude-sonnet-4-5-20250514");
    expect(result.message_id).toBe("msg_02");
    expect(result.input_tokens).toBe(200);
    expect(result.output_tokens).toBe(50);
    expect(result.stop_reason).toBe("end_turn");
  });

  test("passes through unknown content types", async () => {
    const { transform, getResult } = createUsageTap("text/plain");

    const source = new PassThrough();
    source.pipe(transform);
    source.end("plain text body");

    const output = await streamToBuffer(transform);
    expect(output.toString()).toBe("plain text body");

    const result = getResult();
    expect(result.model).toBe("");
    expect(result.input_tokens).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/usage-tap.test.ts`
Expected: FAIL — cannot resolve `../lib/usage-tap`

- [ ] **Step 3: Write implementation**

```typescript
// lib/usage-tap.ts
import { Transform } from "node:stream";
import type { UsageTapResult } from "./types";

export type { UsageTapResult };

function emptyResult(): UsageTapResult {
  return {
    model: "",
    message_id: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    stop_reason: "",
  };
}

function createSseTap(): { transform: Transform; getResult: () => UsageTapResult } {
  const result = emptyResult();
  let buffer = "";

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      const text = chunk.toString();
      this.push(chunk);

      buffer += text;

      // Process complete SSE blocks (separated by double newline)
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataLine = block
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (!dataLine) continue;

        try {
          const data = JSON.parse(dataLine.slice(6));

          if (data.type === "message_start" && data.message) {
            const msg = data.message;
            result.model = msg.model ?? result.model;
            result.message_id = msg.id ?? result.message_id;
            if (msg.usage) {
              result.input_tokens = msg.usage.input_tokens ?? 0;
              result.cache_creation_input_tokens = msg.usage.cache_creation_input_tokens ?? 0;
              result.cache_read_input_tokens = msg.usage.cache_read_input_tokens ?? 0;
            }
          }

          if (data.type === "message_delta") {
            if (data.delta?.stop_reason) {
              result.stop_reason = data.delta.stop_reason;
            }
            if (data.usage?.output_tokens !== undefined) {
              result.output_tokens = data.usage.output_tokens;
            }
          }
        } catch {
          // Skip unparseable SSE data
        }
      }

      callback();
    },
  });

  return { transform, getResult: () => result };
}

const MAX_JSON_BUFFER = 1024 * 1024; // 1MB

function createJsonTap(): { transform: Transform; getResult: () => UsageTapResult } {
  const result = emptyResult();
  const chunks: Buffer[] = [];
  let totalSize = 0;

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      this.push(chunk);
      if (totalSize < MAX_JSON_BUFFER) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        totalSize += chunk.length;
      }
      callback();
    },
    flush(callback) {
      try {
        const body = Buffer.concat(chunks).toString();
        const data = JSON.parse(body);
        result.model = data.model ?? "";
        result.message_id = data.id ?? "";
        result.stop_reason = data.stop_reason ?? "";
        if (data.usage) {
          result.input_tokens = data.usage.input_tokens ?? 0;
          result.output_tokens = data.usage.output_tokens ?? 0;
          result.cache_creation_input_tokens = data.usage.cache_creation_input_tokens ?? 0;
          result.cache_read_input_tokens = data.usage.cache_read_input_tokens ?? 0;
        }
      } catch {
        // Not valid JSON; leave result empty
      }
      callback();
    },
  });

  return { transform, getResult: () => result };
}

function createNoopTap(): { transform: Transform; getResult: () => UsageTapResult } {
  const result = emptyResult();
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      this.push(chunk);
      callback();
    },
  });
  return { transform, getResult: () => result };
}

export function createUsageTap(contentType: string): {
  transform: Transform;
  getResult: () => UsageTapResult;
} {
  if (contentType.includes("text/event-stream")) {
    return createSseTap();
  }
  if (contentType.includes("application/json")) {
    return createJsonTap();
  }
  return createNoopTap();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/usage-tap.test.ts`
Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/usage-tap.ts test/usage-tap.test.ts
git commit -m "feat: add SSE/JSON usage tap for streaming token extraction"
```

---

### Task 11: Audit Log Writer

**Files:**
- Create: `lib/audit.ts`
- Create: `test/audit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/audit.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLog } from "../lib/audit";
import type { AuditEntry } from "../lib/types";

describe("AuditLog", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
    return {
      ts: "2026-04-15T10:00:00.000Z",
      duration_ms: 100,
      method: "POST",
      path: "/v1/messages",
      status: 200,
      model: "claude-sonnet-4-5-20250514",
      account: "user1",
      initiator: "agent",
      message_id: "msg_01",
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      stop_reason: "end_turn",
      ...overrides,
    };
  }

  test("writes JSONL entries to file", async () => {
    const logPath = join(dir, "audit.jsonl");
    const audit = new AuditLog(logPath);

    await audit.write(makeEntry());
    await audit.write(makeEntry({ account: "user2", status: 500 }));

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]);
    expect(first.account).toBe("user1");
    expect(first.status).toBe(200);

    const second = JSON.parse(lines[1]);
    expect(second.account).toBe("user2");
    expect(second.status).toBe(500);
  });

  test("creates file on first write", async () => {
    const logPath = join(dir, "subdir", "audit.jsonl");
    const audit = new AuditLog(logPath);

    await audit.write(makeEntry());

    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("msg_01");
  });

  test("sequential writes don't interleave", async () => {
    const logPath = join(dir, "audit.jsonl");
    const audit = new AuditLog(logPath);

    // Fire multiple writes concurrently
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        audit.write(makeEntry({ message_id: `msg_${i}` })),
      ),
    );

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(10);
    // Each line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/audit.test.ts`
Expected: FAIL — cannot resolve `../lib/audit`

- [ ] **Step 3: Write implementation**

```typescript
// lib/audit.ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry } from "./types";

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  async write(entry: AuditEntry): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (!this.dirEnsured) {
        await mkdir(dirname(this.path), { recursive: true });
        this.dirEnsured = true;
      }
      const line = JSON.stringify(entry) + "\n";
      await appendFile(this.path, line, "utf-8");
    });
    return this.chain;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/audit.test.ts`
Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/audit.ts test/audit.test.ts
git commit -m "feat: add JSONL audit log writer with sequential write guarantee"
```

---

### Task 12: Stats Aggregation

**Files:**
- Create: `lib/stats.ts`
- Create: `test/stats.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/stats.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateStats, parseRelativeDuration } from "../lib/stats";

describe("parseRelativeDuration", () => {
  test("parses minutes", () => {
    expect(parseRelativeDuration("30m")).toBe(30 * 60 * 1000);
  });

  test("parses hours", () => {
    expect(parseRelativeDuration("24h")).toBe(24 * 60 * 60 * 1000);
  });

  test("parses days", () => {
    expect(parseRelativeDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("returns null for invalid input", () => {
    expect(parseRelativeDuration("abc")).toBeNull();
  });
});

describe("aggregateStats", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stats-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("aggregates entries within time range", async () => {
    const logPath = join(dir, "audit.jsonl");
    const entries = [
      { ts: "2026-04-15T10:00:00.000Z", method: "POST", path: "/v1/messages", status: 200, model: "claude-sonnet-4-5-20250514", account: "user1", initiator: "user", message_id: "m1", input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, stop_reason: "end_turn", duration_ms: 100 },
      { ts: "2026-04-15T11:00:00.000Z", method: "POST", path: "/v1/messages", status: 200, model: "claude-sonnet-4-5-20250514", account: "user1", initiator: "agent", message_id: "m2", input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, stop_reason: "end_turn", duration_ms: 200 },
      { ts: "2026-04-15T12:00:00.000Z", method: "POST", path: "/v1/messages", status: 200, model: "claude-haiku-3-5-20241022", account: "user2", initiator: "agent", message_id: "m3", input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, stop_reason: "end_turn", duration_ms: 50 },
    ];
    writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = await aggregateStats(logPath, {
      since: new Date("2026-04-15T00:00:00.000Z"),
      until: new Date("2026-04-16T00:00:00.000Z"),
    });

    expect(result.totals.requests).toBe(3);
    expect(result.totals.premium_requests).toBe(1);
    expect(result.totals.non_premium_requests).toBe(2);
    expect(result.totals.input_tokens).toBe(350);
    expect(result.totals.output_tokens).toBe(175);

    expect(result.by_model.length).toBe(2);
    expect(result.by_account.length).toBe(2);
    expect(result.by_initiator.user).toBe(1);
    expect(result.by_initiator.agent).toBe(2);
  });

  test("returns empty stats for nonexistent file", async () => {
    const result = await aggregateStats(join(dir, "missing.jsonl"), {
      since: new Date("2026-04-15T00:00:00.000Z"),
      until: new Date("2026-04-16T00:00:00.000Z"),
    });

    expect(result.totals.requests).toBe(0);
  });

  test("filters by time range", async () => {
    const logPath = join(dir, "audit.jsonl");
    const entries = [
      { ts: "2026-04-15T08:00:00.000Z", method: "POST", path: "/v1/messages", status: 200, model: "m", account: "u", initiator: "user", message_id: "m1", input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, stop_reason: "end_turn", duration_ms: 100 },
      { ts: "2026-04-15T12:00:00.000Z", method: "POST", path: "/v1/messages", status: 200, model: "m", account: "u", initiator: "agent", message_id: "m2", input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, stop_reason: "end_turn", duration_ms: 200 },
    ];
    writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = await aggregateStats(logPath, {
      since: new Date("2026-04-15T10:00:00.000Z"),
      until: new Date("2026-04-15T14:00:00.000Z"),
    });

    expect(result.totals.requests).toBe(1);
    expect(result.totals.input_tokens).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/stats.test.ts`
Expected: FAIL — cannot resolve `../lib/stats`

- [ ] **Step 3: Write implementation**

```typescript
// lib/stats.ts
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { access, constants } from "node:fs/promises";

export function parseRelativeDuration(s: string): number | null {
  const match = s.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

interface ModelStats {
  model: string;
  requests: number;
  premium_requests: number;
  input_tokens: number;
  output_tokens: number;
}

interface AccountStats {
  account: string;
  requests: number;
  premium_requests: number;
  input_tokens: number;
  output_tokens: number;
}

export interface StatsResult {
  period: { since: string; until: string };
  totals: {
    requests: number;
    premium_requests: number;
    non_premium_requests: number;
    input_tokens: number;
    output_tokens: number;
  };
  by_model: ModelStats[];
  by_account: AccountStats[];
  by_initiator: { user: number; agent: number };
}

export async function aggregateStats(
  logPath: string,
  range: { since: Date; until: Date },
): Promise<StatsResult> {
  const result: StatsResult = {
    period: { since: range.since.toISOString(), until: range.until.toISOString() },
    totals: { requests: 0, premium_requests: 0, non_premium_requests: 0, input_tokens: 0, output_tokens: 0 },
    by_model: [],
    by_account: [],
    by_initiator: { user: 0, agent: 0 },
  };

  try {
    await access(logPath, constants.R_OK);
  } catch {
    return result;
  }

  const modelMap = new Map<string, ModelStats>();
  const accountMap = new Map<string, AccountStats>();

  const rl = createInterface({
    input: createReadStream(logPath, "utf-8"),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const ts = new Date(entry.ts);
      if (ts < range.since || ts >= range.until) continue;

      const isPremium = entry.initiator === "user";

      result.totals.requests++;
      if (isPremium) result.totals.premium_requests++;
      else result.totals.non_premium_requests++;
      result.totals.input_tokens += entry.input_tokens ?? 0;
      result.totals.output_tokens += entry.output_tokens ?? 0;

      if (isPremium) result.by_initiator.user++;
      else result.by_initiator.agent++;

      // By model
      const model = entry.model ?? "unknown";
      let ms = modelMap.get(model);
      if (!ms) {
        ms = { model, requests: 0, premium_requests: 0, input_tokens: 0, output_tokens: 0 };
        modelMap.set(model, ms);
      }
      ms.requests++;
      if (isPremium) ms.premium_requests++;
      ms.input_tokens += entry.input_tokens ?? 0;
      ms.output_tokens += entry.output_tokens ?? 0;

      // By account
      const account = entry.account ?? "unknown";
      let as_ = accountMap.get(account);
      if (!as_) {
        as_ = { account, requests: 0, premium_requests: 0, input_tokens: 0, output_tokens: 0 };
        accountMap.set(account, as_);
      }
      as_.requests++;
      if (isPremium) as_.premium_requests++;
      as_.input_tokens += entry.input_tokens ?? 0;
      as_.output_tokens += entry.output_tokens ?? 0;
    } catch {
      // Skip malformed lines
    }
  }

  result.by_model = [...modelMap.values()].sort(
    (a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens),
  );
  result.by_account = [...accountMap.values()].sort(
    (a, b) => b.output_tokens - a.output_tokens,
  );

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/stats.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/stats.ts test/stats.test.ts
git commit -m "feat: add audit log stats aggregation with time range filtering"
```

---

### Task 13: Account Pool with Failover

**Files:**
- Create: `lib/account-pool.ts`
- Create: `test/account-pool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/account-pool.test.ts
import { describe, test, expect } from "bun:test";
import { AccountPool } from "../lib/account-pool";

// Minimal mock TokenManager for testing pool logic
class MockTokenManager {
  token: string;
  apiBase: string;
  disposed = false;
  constructor(
    public username: string,
    opts: { token?: string; apiBase?: string } = {},
  ) {
    this.token = opts.token ?? `tok_${username}`;
    this.apiBase = opts.apiBase ?? "https://api.githubcopilot.com";
  }
  getToken() { return this.token; }
  getApiBase() { return this.apiBase; }
  setApiBase(base: string) { this.apiBase = base; }
  async initialize() {}
  dispose() { this.disposed = true; }
}

describe("AccountPool", () => {
  test("returns sticky account on repeated calls", () => {
    const pool = new AccountPool(
      [
        { username: "u1", githubToken: "g1", tokenManager: new MockTokenManager("u1") as any },
        { username: "u2", githubToken: "g2", tokenManager: new MockTokenManager("u2") as any },
      ],
      300_000,
    );

    const a1 = pool.getHealthy();
    const a2 = pool.getHealthy();
    expect(a1?.username).toBe("u1");
    expect(a2?.username).toBe("u1");
  });

  test("advances to next account on failure", () => {
    const pool = new AccountPool(
      [
        { username: "u1", githubToken: "g1", tokenManager: new MockTokenManager("u1") as any },
        { username: "u2", githubToken: "g2", tokenManager: new MockTokenManager("u2") as any },
      ],
      300_000,
    );

    pool.markFailed("u1");
    const next = pool.getHealthy();
    expect(next?.username).toBe("u2");
  });

  test("returns null when all accounts failed", () => {
    const pool = new AccountPool(
      [
        { username: "u1", githubToken: "g1", tokenManager: new MockTokenManager("u1") as any },
        { username: "u2", githubToken: "g2", tokenManager: new MockTokenManager("u2") as any },
      ],
      300_000,
    );

    pool.markFailed("u1");
    pool.markFailed("u2");
    expect(pool.getHealthy()).toBeNull();
  });

  test("recovers account after cooldown", () => {
    const pool = new AccountPool(
      [
        { username: "u1", githubToken: "g1", tokenManager: new MockTokenManager("u1") as any },
      ],
      100, // 100ms cooldown for testing
    );

    pool.markFailed("u1");
    expect(pool.getHealthy()).toBeNull();

    // Manually advance the failedAt timestamp
    (pool as any).accounts[0].failedAt = Date.now() - 200;
    const recovered = pool.getHealthy();
    expect(recovered?.username).toBe("u1");
  });

  test("getAll returns all accounts", () => {
    const pool = new AccountPool(
      [
        { username: "u1", githubToken: "g1", tokenManager: new MockTokenManager("u1") as any },
        { username: "u2", githubToken: "g2", tokenManager: new MockTokenManager("u2") as any },
      ],
      300_000,
    );
    expect(pool.getAll().length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/account-pool.test.ts`
Expected: FAIL — cannot resolve `../lib/account-pool`

- [ ] **Step 3: Write implementation**

```typescript
// lib/account-pool.ts
import type { TokenManager } from "./copilot-token";

export interface PoolAccount {
  username: string;
  githubToken: string;
  tokenManager: TokenManager;
  failedAt: number | null;
}

export class AccountPool {
  private currentIndex = 0;

  constructor(
    private readonly accounts: PoolAccount[],
    private readonly cooldownMs: number,
  ) {
    // Initialize failedAt for all accounts
    for (const acc of this.accounts) {
      if (acc.failedAt === undefined) acc.failedAt = null;
    }
  }

  getHealthy(): PoolAccount | null {
    const len = this.accounts.length;
    if (len === 0) return null;

    // Try starting from current sticky index
    for (let i = 0; i < len; i++) {
      const idx = (this.currentIndex + i) % len;
      const acc = this.accounts[idx];

      if (acc.failedAt === null) {
        this.currentIndex = idx;
        return acc;
      }

      // Check if cooldown has passed
      if (Date.now() - acc.failedAt >= this.cooldownMs) {
        acc.failedAt = null;
        this.currentIndex = idx;
        return acc;
      }
    }

    return null;
  }

  markFailed(username: string): void {
    const acc = this.accounts.find((a) => a.username === username);
    if (acc) {
      acc.failedAt = Date.now();
    }

    // Advance sticky index past the failed account
    const failedIdx = this.accounts.findIndex((a) => a.username === username);
    if (failedIdx === this.currentIndex) {
      this.currentIndex = (this.currentIndex + 1) % this.accounts.length;
    }
  }

  markSuccess(username: string): void {
    const acc = this.accounts.find((a) => a.username === username);
    if (acc) {
      acc.failedAt = null;
    }
    const idx = this.accounts.findIndex((a) => a.username === username);
    if (idx !== -1) {
      this.currentIndex = idx;
    }
  }

  getAll(): readonly PoolAccount[] {
    return this.accounts;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/account-pool.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/account-pool.ts test/account-pool.test.ts
git commit -m "feat: add multi-account pool with sticky failover"
```

---

### Task 14: Usage Poller

**Files:**
- Create: `lib/usage-poll.ts`
- Create: `test/usage-poll.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/usage-poll.test.ts
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { UsagePoller } from "../lib/usage-poll";

describe("UsagePoller", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetches and caches usage data", async () => {
    const mockResponse = {
      copilot_plan: "copilot_for_individual",
      quota_reset_date: "2026-05-01",
      quota_snapshots: {
        chat: { entitlement: 1000, remaining: 800, percent_remaining: 80, unlimited: false },
        completions: { entitlement: 5000, remaining: 4500, percent_remaining: 90, unlimited: false },
        premium_interactions: { entitlement: 300, remaining: 250, percent_remaining: 83.3, unlimited: false },
      },
      endpoints: { api: "https://api.githubcopilot.com" },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as any;

    const poller = new UsagePoller("gho_test", "testuser");
    const result = await poller.poll();

    expect(result.copilot_plan).toBe("copilot_for_individual");
    expect(result.quota_snapshots.premium_interactions.remaining).toBe(250);
    expect(result.endpoints?.api).toBe("https://api.githubcopilot.com");

    // Cached result should be available
    const cached = poller.getCached();
    expect(cached).not.toBeNull();
    expect(cached!.copilot_plan).toBe("copilot_for_individual");

    poller.dispose();
  });

  test("returns api base from cached data", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            copilot_plan: "copilot_for_business",
            quota_reset_date: "2026-05-01",
            quota_snapshots: {
              chat: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: true },
              completions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: true },
              premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: true },
            },
            endpoints: { api: "https://copilot.enterprise.example.com" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ) as any;

    const poller = new UsagePoller("gho_biz", "bizuser");
    await poller.poll();

    expect(poller.getApiBase()).toBe("https://copilot.enterprise.example.com");

    poller.dispose();
  });

  test("handles fetch failure gracefully", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Server Error", { status: 500 })),
    ) as any;

    const poller = new UsagePoller("gho_bad", "baduser");
    await expect(poller.poll()).rejects.toThrow();
    expect(poller.getCached()).toBeNull();

    poller.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/usage-poll.test.ts`
Expected: FAIL — cannot resolve `../lib/usage-poll`

- [ ] **Step 3: Write implementation**

```typescript
// lib/usage-poll.ts
import { COPILOT_HEADERS, type CopilotUsageResponse } from "./types";
import { RelayError } from "./types";

const USAGE_URL = "https://api.github.com/copilot_internal/user";
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class UsagePoller {
  private cached: CopilotUsageResponse | null = null;
  private queriedAt: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly githubToken: string,
    private readonly username: string,
  ) {}

  async poll(): Promise<CopilotUsageResponse> {
    const resp = await fetch(USAGE_URL, {
      headers: {
        authorization: `token ${this.githubToken}`,
        "content-type": "application/json",
        accept: "application/json",
        ...COPILOT_HEADERS,
      },
    });

    if (!resp.ok) {
      throw new RelayError(
        `Copilot usage fetch failed for ${this.username}: ${resp.status}`,
        resp.status,
      );
    }

    const data = (await resp.json()) as CopilotUsageResponse;
    this.cached = data;
    this.queriedAt = new Date();
    return data;
  }

  getCached(): CopilotUsageResponse | null {
    return this.cached;
  }

  getQueriedAt(): Date | null {
    return this.queriedAt;
  }

  getApiBase(): string | null {
    return this.cached?.endpoints?.api ?? null;
  }

  startBackground(): void {
    if (this.disposed || this.timer) return;
    this.timer = setInterval(async () => {
      try {
        await this.poll();
      } catch {
        // Silently retry on next interval
      }
    }, POLL_INTERVAL_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/usage-poll.test.ts`
Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/usage-poll.ts test/usage-poll.test.ts
git commit -m "feat: add Copilot quota poller with background refresh"
```

---

### Task 15: CLI Login Command

**Files:**
- Create: `cli/login.ts`

- [ ] **Step 1: Write the CLI login implementation**

```typescript
// cli/login.ts
import { requestDeviceCode, pollForToken, fetchUsername } from "../lib/copilot-auth";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AccountFile } from "../lib/types";

export async function runLogin(dataDir: string): Promise<void> {
  console.log("Starting GitHub Device Flow login...\n");

  const deviceCode = await requestDeviceCode();

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Open:  ${deviceCode.verification_uri}`);
  console.log(`  Code:  ${deviceCode.user_code}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("\nWaiting for authorization...");

  const githubToken = await pollForToken(deviceCode.device_code, deviceCode.interval);

  console.log("Authorization successful! Fetching username...");
  const username = await fetchUsername(githubToken);

  const accountsDir = join(dataDir, "accounts");
  await mkdir(accountsDir, { recursive: true });

  const accountFile: AccountFile = {
    username,
    github_token: githubToken,
    created_at: new Date().toISOString(),
  };

  const filePath = join(accountsDir, `${username}.json`);
  await writeFile(filePath, JSON.stringify(accountFile, null, 2), { mode: 0o600 });

  console.log(`\n✓ Account "${username}" saved to ${filePath}`);
  console.log("You can now start the relay with: bun run serve");
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: passes with no errors

- [ ] **Step 3: Commit**

```bash
git add cli/login.ts
git commit -m "feat: add CLI login command for GitHub Device Flow"
```

---

### Task 16: Main Entry Point (bin/relay.ts)

**Files:**
- Create: `bin/relay.ts`

- [ ] **Step 1: Write the main entry point**

```typescript
#!/usr/bin/env bun
// bin/relay.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

import { parseConfig, type Config } from "../lib/config";
import { createLogger, parseLogLevel, type Logger } from "../lib/logger";
import { verifyBearer } from "../lib/auth";
import { TokenManager } from "../lib/copilot-token";
import { AccountPool, type PoolAccount } from "../lib/account-pool";
import { inferInitiator } from "../lib/initiator";
import { rewriteHeaders } from "../lib/rewriter";
import { forwardRequest } from "../lib/upstream";
import { createUsageTap } from "../lib/usage-tap";
import { AuditLog } from "../lib/audit";
import { aggregateStats, parseRelativeDuration } from "../lib/stats";
import { UsagePoller } from "../lib/usage-poll";
import { runLogin } from "../cli/login";
import type { AccountFile, AuditEntry } from "../lib/types";

// --- CLI Router ---

const command = process.argv[2] ?? "serve";

async function main() {
  switch (command) {
    case "serve":
      return serve();
    case "login":
      return login();
    case "accounts":
      return listAccounts();
    case "generate-secret":
      return generateSecret();
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: bun run bin/relay.ts <serve|login|accounts|generate-secret>");
      process.exit(1);
  }
}

async function login() {
  const dataDir = process.env.DATA_DIR ?? "./data";
  await runLogin(dataDir);
}

async function listAccounts() {
  const dataDir = process.env.DATA_DIR ?? "./data";
  const accountsDir = join(dataDir, "accounts");
  try {
    const files = await readdir(accountsDir);
    const accounts = files.filter((f) => f.endsWith(".json"));
    if (accounts.length === 0) {
      console.log("No accounts found. Run: bun run login");
      return;
    }
    console.log(`Found ${accounts.length} account(s):\n`);
    for (const file of accounts) {
      const data = JSON.parse(await readFile(join(accountsDir, file), "utf-8")) as AccountFile;
      console.log(`  • ${data.username} (added ${data.created_at})`);
    }
  } catch {
    console.log("No accounts found. Run: bun run login");
  }
}

async function generateSecret() {
  const secret = randomBytes(32).toString("hex");
  console.log(secret);
}

// --- Server ---

async function loadAccounts(dataDir: string, log: Logger, refreshSkewS: number): Promise<PoolAccount[]> {
  const accountsDir = join(dataDir, "accounts");
  let files: string[];
  try {
    files = (await readdir(accountsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    throw new Error(`No accounts directory at ${accountsDir}. Run: bun run login`);
  }

  if (files.length === 0) {
    throw new Error("No accounts found. Run: bun run login");
  }

  const accounts: PoolAccount[] = [];
  for (const file of files) {
    const data = JSON.parse(await readFile(join(accountsDir, file), "utf-8")) as AccountFile;
    const tm = new TokenManager(data.github_token, refreshSkewS);
    accounts.push({
      username: data.username,
      githubToken: data.github_token,
      tokenManager: tm,
      failedAt: null,
    });
  }
  return accounts;
}

function generateRequestId(body: Buffer): string {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  // Format as UUID-like
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join("-");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

async function serve() {
  const config = parseConfig();
  const log = createLogger(parseLogLevel(config.logLevel));
  const auditLog = new AuditLog(join(config.dataDir, "audit.jsonl"));

  log.info("Loading accounts...");
  const poolAccounts = await loadAccounts(config.dataDir, log, config.tokenRefreshSkewS);

  // Initialize token managers and usage pollers
  const usagePollers = new Map<string, UsagePoller>();

  for (const acc of poolAccounts) {
    log.info("Initializing token for account", { account: acc.username });
    await acc.tokenManager.initialize();

    const poller = new UsagePoller(acc.githubToken, acc.username);
    usagePollers.set(acc.username, poller);

    // Initial poll to discover API base URL
    try {
      const usage = await poller.poll();
      if (usage.endpoints?.api) {
        acc.tokenManager.setApiBase(usage.endpoints.api);
        log.info("Discovered API base", { account: acc.username, apiBase: usage.endpoints.api });
      }
    } catch (e) {
      log.warn("Failed initial usage poll", { account: acc.username, error: String(e) });
    }

    poller.startBackground();
  }

  const pool = new AccountPool(poolAccounts, config.accountCooldownMs);

  log.info("Starting relay server", { bind: config.bind, port: config.port, accounts: poolAccounts.length });

  // --- Device Flow state for skill-driven login ---
  const pendingLogins = new Map<string, {
    deviceCode: string;
    interval: number;
    expiresAt: number;
    result: { status: "pending" } | { status: "complete"; username: string } | { status: "expired" };
  }>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startTime = Date.now();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    try {
      // Auth check for all endpoints
      if (!verifyBearer(req.headers.authorization, config.secret)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      // --- Management endpoints ---

      if (url === "/relay/health" && method === "GET") {
        const accounts = pool.getAll().map((a) => ({
          username: a.username,
          healthy: a.failedAt === null,
          hasToken: !!a.tokenManager.getToken(),
        }));
        sendJson(res, 200, { status: "ok", accounts });
        return;
      }

      if (url.startsWith("/relay/stats") && method === "GET") {
        const params = new URL(url, "http://localhost").searchParams;
        const now = new Date();
        let since = new Date(now.getTime() - 24 * 60 * 60 * 1000); // default 24h
        let until = now;

        const sinceParam = params.get("since");
        if (sinceParam) {
          const dur = parseRelativeDuration(sinceParam);
          if (dur) since = new Date(now.getTime() - dur);
          else since = new Date(sinceParam);
        }

        const untilParam = params.get("until");
        if (untilParam && untilParam !== "now") {
          const dur = parseRelativeDuration(untilParam);
          if (dur) until = new Date(now.getTime() - dur);
          else until = new Date(untilParam);
        }

        const stats = await aggregateStats(join(config.dataDir, "audit.jsonl"), { since, until });
        sendJson(res, 200, stats);
        return;
      }

      if (url === "/relay/usage" && method === "GET") {
        const accounts = pool.getAll().map((a) => {
          const poller = usagePollers.get(a.username);
          const cached = poller?.getCached();
          return {
            username: a.username,
            copilot_plan: cached?.copilot_plan ?? null,
            quota_reset_date: cached?.quota_reset_date ?? null,
            premium_interactions: cached?.quota_snapshots?.premium_interactions ?? null,
            queried_at: poller?.getQueriedAt()?.toISOString() ?? null,
          };
        });
        sendJson(res, 200, { accounts });
        return;
      }

      if (url === "/relay/login/start" && method === "POST") {
        const { requestDeviceCode } = await import("../lib/copilot-auth");
        const dc = await requestDeviceCode();
        const key = dc.device_code;
        pendingLogins.set(key, {
          deviceCode: dc.device_code,
          interval: dc.interval,
          expiresAt: Date.now() + dc.expires_in * 1000,
          result: { status: "pending" },
        });

        // Start background polling
        (async () => {
          try {
            const { pollForToken, fetchUsername } = await import("../lib/copilot-auth");
            const token = await pollForToken(dc.device_code, dc.interval);
            const username = await fetchUsername(token);

            // Save account file
            const accountsDir = join(config.dataDir, "accounts");
            await mkdir(accountsDir, { recursive: true });
            const accountFile: AccountFile = { username, github_token: token, created_at: new Date().toISOString() };
            const { writeFile } = await import("node:fs/promises");
            await writeFile(join(accountsDir, `${username}.json`), JSON.stringify(accountFile, null, 2), { mode: 0o600 });

            const entry = pendingLogins.get(key);
            if (entry) entry.result = { status: "complete", username };
          } catch {
            const entry = pendingLogins.get(key);
            if (entry) entry.result = { status: "expired" };
          }
        })();

        sendJson(res, 200, {
          user_code: dc.user_code,
          verification_uri: dc.verification_uri,
          expires_in: dc.expires_in,
          device_code: dc.device_code,
        });
        return;
      }

      if (url.startsWith("/relay/login/status") && method === "GET") {
        const params = new URL(url, "http://localhost").searchParams;
        const deviceCode = params.get("device_code");
        if (!deviceCode) {
          sendJson(res, 400, { error: "device_code parameter required" });
          return;
        }
        const entry = pendingLogins.get(deviceCode);
        if (!entry) {
          sendJson(res, 404, { error: "Unknown device_code" });
          return;
        }
        if (entry.expiresAt < Date.now() && entry.result.status === "pending") {
          entry.result = { status: "expired" };
        }
        sendJson(res, 200, entry.result);
        // Cleanup completed/expired entries
        if (entry.result.status !== "pending") {
          pendingLogins.delete(deviceCode);
        }
        return;
      }

      // --- Proxy endpoint ---

      const body = await readBody(req);
      let parsedBody: Record<string, unknown> | null = null;
      try {
        parsedBody = JSON.parse(body.toString());
      } catch {
        // Not JSON; proceed without parsing
      }

      const initiator = parsedBody ? inferInitiator(parsedBody) : "user";
      const requestId = generateRequestId(body);

      // Try accounts with failover
      let lastError: Error | null = null;
      const tried = new Set<string>();

      while (true) {
        const account = pool.getHealthy();
        if (!account || tried.has(account.username)) {
          // All exhausted
          sendJson(res, 503, { error: "All accounts unavailable" });
          return;
        }
        tried.add(account.username);

        const headers = rewriteHeaders(
          req.headers as Record<string, string>,
          {
            copilotToken: account.tokenManager.getToken(),
            initiator,
            requestId,
          },
        );

        try {
          const result = await forwardRequest({
            method,
            path: url,
            headers,
            body,
            apiBase: account.tokenManager.getApiBase(),
            timeoutMs: config.upstreamTimeoutMs,
          });

          if (result.statusCode >= 400) {
            pool.markFailed(account.username);
            log.warn("Upstream error, trying next account", {
              account: account.username,
              status: result.statusCode,
            });
            // Consume the error response body
            for await (const _ of result.body) { /* drain */ }
            continue;
          }

          pool.markSuccess(account.username);

          // Set up usage tap
          const contentType = result.headers["content-type"] ?? "";
          const { transform, getResult } = createUsageTap(contentType);

          // Write response headers
          res.writeHead(result.statusCode, result.headers);

          // Pipe through usage tap
          result.body.pipe(transform).pipe(res);

          // Write audit log when response completes
          transform.on("end", () => {
            const usage = getResult();
            const entry: AuditEntry = {
              ts: new Date().toISOString(),
              duration_ms: Date.now() - startTime,
              method,
              path: url,
              status: result.statusCode,
              model: usage.model || (parsedBody?.model as string) || "",
              account: account.username,
              initiator,
              message_id: usage.message_id,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
              stop_reason: usage.stop_reason,
            };
            auditLog.write(entry).catch((e) => log.error("Audit write failed", { error: String(e) }));
            log.info("Request completed", {
              method,
              path: url,
              status: result.statusCode,
              account: account.username,
              initiator,
              duration_ms: entry.duration_ms,
            });
          });

          return; // Success — done
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          pool.markFailed(account.username);
          log.warn("Forward failed, trying next account", {
            account: account.username,
            error: lastError.message,
          });
          continue;
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      log.error("Request handler error", { error: error.message, method, path: url });
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  });

  server.listen(config.port, config.bind, () => {
    log.info("Relay server listening", { url: `http://${config.bind}:${config.port}` });
    log.info("Client config:", {
      ANTHROPIC_BASE_URL: `http://${config.bind}:${config.port}`,
      ANTHROPIC_AUTH_TOKEN: "<your RELAY_SECRET>",
    });
  });
}

main().catch((e) => {
  console.error("Fatal:", e.message ?? e);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: passes with no errors

- [ ] **Step 3: Commit**

```bash
git add bin/relay.ts
git commit -m "feat: add main entry point with CLI router and HTTP server"
```

---

### Task 17: Integration Test

**Files:**
- Create: `test/integration.test.ts`

- [ ] **Step 1: Write the integration test**

This test starts a mock Copilot upstream, starts the relay, and makes a full round-trip request.

```typescript
// test/integration.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("integration", () => {
  let mockUpstreamPort: number;
  let mockUpstream: ReturnType<typeof createServer>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "relay-integration-"));

    // Create mock upstream that responds like Copilot
    mockUpstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/v1/messages" && req.method === "POST") {
        // Verify Copilot headers are present
        const editorVersion = req.headers["editor-version"];
        const initiator = req.headers["x-initiator"];

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_test",
            model: "claude-sonnet-4-5-20250514",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            content: [{ type: "text", text: "Hello from mock!" }],
            _debug: { editor_version: editorVersion, initiator },
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, "127.0.0.1", () => {
        mockUpstreamPort = (mockUpstream.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    mockUpstream.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("full round-trip: client → relay → mock upstream", async () => {
    // This test validates the individual components work together.
    // We test the request flow manually without starting the full server.
    const { verifyBearer } = await import("../lib/auth");
    const { inferInitiator } = await import("../lib/initiator");
    const { rewriteHeaders } = await import("../lib/rewriter");
    const { forwardRequest } = await import("../lib/upstream");
    const { createUsageTap } = await import("../lib/usage-tap");

    const secret = "a".repeat(32);
    const body = JSON.stringify({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });

    // Step 1: Auth
    expect(verifyBearer(`Bearer ${secret}`, secret)).toBe(true);

    // Step 2: Initiator
    const parsedBody = JSON.parse(body);
    const initiator = inferInitiator(parsedBody);
    expect(initiator).toBe("user"); // Single user message → user

    // Step 3: Rewrite headers
    const headers = rewriteHeaders(
      { authorization: `Bearer ${secret}`, "content-type": "application/json", host: "localhost" },
      { copilotToken: "cop_jwt_test", initiator, requestId: "test-req-id" },
    );
    expect(headers["authorization"]).toBe("Bearer cop_jwt_test");
    expect(headers["x-initiator"]).toBe("user");
    expect(headers["host"]).toBeUndefined();

    // Step 4: Forward
    const result = await forwardRequest({
      method: "POST",
      path: "/v1/messages",
      headers,
      body: Buffer.from(body),
      apiBase: `http://127.0.0.1:${mockUpstreamPort}`,
      timeoutMs: 5000,
    });
    expect(result.statusCode).toBe(200);

    // Step 5: Usage tap
    const { transform, getResult } = createUsageTap(result.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result.body.pipe(transform);
      transform.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      transform.on("end", resolve);
      transform.on("error", reject);
    });

    const responseBody = JSON.parse(Buffer.concat(chunks).toString());
    expect(responseBody.content[0].text).toBe("Hello from mock!");
    expect(responseBody._debug.editor_version).toBe("vscode/1.110.1");
    expect(responseBody._debug.initiator).toBe("user");

    const usage = getResult();
    expect(usage.model).toBe("claude-sonnet-4-5-20250514");
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test test/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add test/integration.test.ts
git commit -m "test: add integration test for full request flow"
```

---

### Task 18: Skills

**Files:**
- Create: `.claude/skills/install-relay/SKILL.md`
- Create: `.claude/skills/start-relay/SKILL.md`

- [ ] **Step 1: Write install-relay skill**

```markdown
<!-- .claude/skills/install-relay/SKILL.md -->
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

Run the login command:
```bash
bun run login
```

This starts the GitHub Device Flow:
- A URL and code will be displayed
- Tell the user to open the URL and enter the code
- Wait for authorization to complete
- The account will be saved to `data/accounts/<username>.json`

Ask the user if they want to add more accounts. Repeat if yes.

### 3. Generate Shared Secret

```bash
RELAY_SECRET=$(bun run generate-secret)
echo "Your RELAY_SECRET: $RELAY_SECRET"
```

Tell the user to save this secret — they'll need it for client configuration.

### 4. Start the Relay

```bash
RELAY_SECRET="$RELAY_SECRET" bun run serve
```

### 5. Smoke Test

In a separate terminal, verify the relay is working:

```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health | jq
```

Expected: `{"status":"ok","accounts":[...]}` with at least one account showing `"healthy": true` and `"hasToken": true`.

### 6. Report Client Configuration

Tell the user to configure Claude Code:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_AUTH_TOKEN=<RELAY_SECRET> \
claude
```

Or set these in their shell profile for persistence.
```

- [ ] **Step 2: Write start-relay skill**

```markdown
<!-- .claude/skills/start-relay/SKILL.md -->
---
name: start-relay
description: Start or restart copilot-relay and verify health
---

# Start Copilot Relay

Day-to-day operations for copilot-relay.

## Steps

### 1. Check if relay is already running

```bash
curl -s -H "Authorization: Bearer $RELAY_SECRET" http://127.0.0.1:8787/relay/health 2>/dev/null | jq
```

If it responds, the relay is already running.

### 2. Start the relay

If RELAY_SECRET is set in the environment:
```bash
bun run serve
```

If not, ask the user for their RELAY_SECRET or check if `data/relay.key` exists.

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
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/install-relay/SKILL.md .claude/skills/start-relay/SKILL.md
git commit -m "feat: add install-relay and start-relay skills"
```

---

### Task 19: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: all tests pass

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: passes with no errors

- [ ] **Step 3: Verify project structure**

Run: `find . -type f -not -path './.git/*' -not -path './node_modules/*' | sort`

Expected files:
```
./.claude/skills/install-relay/SKILL.md
./.claude/skills/start-relay/SKILL.md
./.gitignore
./bin/relay.ts
./bun.lockb
./cli/login.ts
./docs/superpowers/plans/2026-04-15-copilot-relay.md
./docs/superpowers/specs/2026-04-15-copilot-relay-design.md
./lib/account-pool.ts
./lib/audit.ts
./lib/auth.ts
./lib/config.ts
./lib/copilot-auth.ts
./lib/copilot-token.ts
./lib/initiator.ts
./lib/logger.ts
./lib/rewriter.ts
./lib/stats.ts
./lib/types.ts
./lib/upstream.ts
./lib/usage-poll.ts
./lib/usage-tap.ts
./package.json
./test/account-pool.test.ts
./test/audit.test.ts
./test/auth.test.ts
./test/config.test.ts
./test/copilot-auth.test.ts
./test/copilot-token.test.ts
./test/initiator.test.ts
./test/integration.test.ts
./test/logger.test.ts
./test/rewriter.test.ts
./test/stats.test.ts
./test/upstream.test.ts
./test/usage-poll.test.ts
./tsconfig.json
```

- [ ] **Step 4: Final commit (if any remaining changes)**

```bash
git status
# If clean, nothing to do. If not, commit remaining files.
```
