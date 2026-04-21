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
import { inferInitiator, resolveInitiator } from "../lib/initiator";
import { extractSessionKey } from "../lib/session-extract";
import { SessionStore } from "../lib/session-store";
import { anthropicResponseHeaders, filterResponseHeaders, isRetryableUpstreamStatus, shouldMarkAccountFailed } from "../lib/rewriter";
import { forwardRequest } from "../lib/upstream";
import { createUsageTap } from "../lib/usage-tap";
import { AuditLog } from "../lib/audit";
import { aggregateStats, parseRelativeDuration } from "../lib/stats";
import { UsagePoller } from "../lib/usage-poll";
import { runLogin } from "../cli/login";
import { buildAnthropicErrorResponse, createCopilotResponseTransform } from "../lib/copilot-response";
import { planUpstreamRequest } from "../lib/request-plan";
import type { AccountFile, AuditEntry } from "../lib/types";

// --- CLI Router ---

const command = process.argv[2] ?? "serve";

async function main() {
  switch (command) {
    case "serve": return serve();
    case "login": return login();
    case "accounts": return listAccounts();
    case "generate-secret": return generateSecret();
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: bun run bin/relay.ts <serve|login|accounts|generate-secret>");
      process.exit(1);
  }
}

async function login() {
  const config = await parseConfig();
  await runLogin(config.dataDir);
}

async function listAccounts() {
  const config = await parseConfig();
  const accountsDir = join(config.dataDir, "accounts");
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
    accounts.push({ username: data.username, githubToken: data.github_token, tokenManager: tm, failedAt: null });
  }
  return accounts;
}

function generateRequestId(body: Buffer): string {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
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
  const config = await parseConfig();
  const log = createLogger(parseLogLevel(config.logLevel));
  const auditLog = new AuditLog(join(config.dataDir, "audit.jsonl"));

  log.info("Loading accounts...");
  const poolAccounts = await loadAccounts(config.dataDir, log, config.tokenRefreshSkewS);

  const usagePollers = new Map<string, UsagePoller>();

  for (const acc of poolAccounts) {
    log.info("Initializing token for account", { account: acc.username });
    await acc.tokenManager.initialize();

    const poller = new UsagePoller(acc.githubToken, acc.username);
    usagePollers.set(acc.username, poller);

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

  const sessionStore = new SessionStore(
    join(config.dataDir, "sessions.json"),
    config.sessionAffinityTtlMs,
  );
  await sessionStore.load();
  log.info("Session store loaded", {
    assignments: sessionStore.assignmentCount(),
    seen: sessionStore.seenSize(),
  });

  const pool = new AccountPool(poolAccounts, {
    cooldownMs: config.accountCooldownMs,
    sessionAffinityTtlMs: config.sessionAffinityTtlMs,
    store: sessionStore,
  });

  log.info("Starting relay server", { bind: config.bind, port: config.port, accounts: poolAccounts.length, forceAgentInitiator: config.forceAgentInitiator });

  const pendingLogins = new Map<string, {
    deviceCode: string; interval: number; expiresAt: number;
    result: { status: "pending" } | { status: "complete"; username: string } | { status: "expired" };
  }>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startTime = Date.now();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    try {
      if (!verifyBearer(req.headers.authorization, config.secret)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      // --- Management endpoints ---

      if (url === "/relay/health" && method === "GET") {
        const accounts = pool.getAll().map((a) => ({
          username: a.username, healthy: a.failedAt === null, hasToken: !!a.tokenManager.getToken(),
        }));
        sendJson(res, 200, { status: "ok", accounts });
        return;
      }

      if (url.startsWith("/relay/stats") && method === "GET") {
        const params = new URL(url, "http://localhost").searchParams;
        const now = new Date();
        let since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
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
            username: a.username, copilot_plan: cached?.copilot_plan ?? null,
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
          deviceCode: dc.device_code, interval: dc.interval, expiresAt: Date.now() + dc.expires_in * 1000,
          result: { status: "pending" },
        });
        (async () => {
          try {
            const { pollForToken, fetchUsername } = await import("../lib/copilot-auth");
            const token = await pollForToken(dc.device_code, dc.interval);
            const username = await fetchUsername(token);
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
          user_code: dc.user_code, verification_uri: dc.verification_uri,
          expires_in: dc.expires_in, device_code: dc.device_code,
        });
        return;
      }

      if (url.startsWith("/relay/login/status") && method === "GET") {
        const params = new URL(url, "http://localhost").searchParams;
        const deviceCode = params.get("device_code");
        if (!deviceCode) { sendJson(res, 400, { error: "device_code parameter required" }); return; }
        const entry = pendingLogins.get(deviceCode);
        if (!entry) { sendJson(res, 404, { error: "Unknown device_code" }); return; }
        if (entry.expiresAt < Date.now() && entry.result.status === "pending") {
          entry.result = { status: "expired" };
        }
        sendJson(res, 200, entry.result);
        if (entry.result.status !== "pending") pendingLogins.delete(deviceCode);
        return;
      }

      // --- Proxy endpoint ---

      const body = await readBody(req);
      let parsedBody: Record<string, unknown> | null = null;
      try { parsedBody = JSON.parse(body.toString()); } catch { /* not JSON */ }

      const initiator = parsedBody ? inferInitiator(parsedBody) : "user";
      const sessionKey = extractSessionKey(parsedBody);
      const firstTurnBySession = sessionKey ? sessionStore.touchSeen(sessionKey) : null;
      const effectiveInitiator = resolveInitiator(
        initiator,
        config.forceAgentInitiator,
        parsedBody,
        firstTurnBySession,
      );
      const requestId = generateRequestId(body);

      const tried = new Set<string>();

      while (true) {
        const account = tried.size === 0 ? pool.getForSession(sessionKey) : pool.getHealthy();
        if (!account || tried.has(account.username)) {
          sendJson(res, 503, { error: "All accounts unavailable" });
          return;
        }
        tried.add(account.username);

        let plan;
        try {
          plan = planUpstreamRequest({
            url,
            headers: req.headers as Record<string, string>,
            body,
            parsedBody,
            apiBase: account.tokenManager.getApiBase(),
            copilotToken: account.tokenManager.getToken(),
            initiator: effectiveInitiator,
            requestId,
          });
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          log.warn("Request transform failed", { path: url, error: error.message });
          sendJson(res, 400, { error: error.message });
          return;
        }

        // Debug logging for request details
        log.debug("Request planned", {
          path: url,
          upstream_path: plan.upstreamPath,
          upstream_mode: plan.upstreamMode,
          initiator: effectiveInitiator,
          mapped_model: plan.mappedModel,
          dropped_fields: plan.droppedFields,
          original_body: parsedBody,
          transformed_body_preview: plan.upstreamBody.toString().slice(0, 2000),
        });

        try {
          const result = await forwardRequest({
            method,
            path: plan.upstreamPath,
            headers: plan.upstreamHeaders,
            body: plan.upstreamBody,
            apiBase: account.tokenManager.getApiBase(),
            timeoutMs: config.upstreamTimeoutMs,
          });

          if (result.statusCode >= 400) {
            const shouldFail = shouldMarkAccountFailed(result.statusCode);
            if (shouldFail) {
              pool.markFailed(account.username);
            }
            let errorBody = "";
            for await (const chunk of result.body) {
              errorBody += chunk.toString();
            }
            // Log detailed request info for debugging upstream errors
            log.warn("Upstream error, trying next account", {
              account: account.username,
              status: result.statusCode,
              method,
              path: url,
              upstream_path: plan.upstreamPath,
              body: errorBody,
              markFailed: shouldFail,
              initiator: effectiveInitiator,
              upstream_mode: plan.upstreamMode,
              mapped_model: plan.mappedModel,
              request_body_size: plan.upstreamBody.length,
            });
            if (!isRetryableUpstreamStatus(result.statusCode)) {
              const errorJson = buildAnthropicErrorResponse(result.statusCode, errorBody);
              const responseHeaders = anthropicResponseHeaders("application/json");
              responseHeaders["content-length"] = String(Buffer.byteLength(errorJson));
              res.writeHead(result.statusCode, responseHeaders);
              res.end(errorJson);
              return;
            }
            continue;
          }

          pool.markSuccess(account.username);
          if (sessionKey) pool.bindSession(sessionKey, account.username);

          const upstreamContentType = result.headers["content-type"] ?? "";
          const responseStream = plan.upstreamMode === "copilot-transform"
            ? result.body.pipe(createCopilotResponseTransform({ contentType: upstreamContentType }))
            : result.body;
          const responseHeaders = plan.upstreamMode === "copilot-transform"
            ? anthropicResponseHeaders(plan.stream ? "text/event-stream" : "application/json")
            : filterResponseHeaders(result.headers);
          const contentType = responseHeaders["content-type"] ?? upstreamContentType;
          const { transform, getResult } = createUsageTap(contentType);

          res.writeHead(result.statusCode, responseHeaders);
          responseStream.pipe(transform).pipe(res);

          transform.on("end", () => {
            const usage = getResult();
            const entry: AuditEntry = {
              ts: new Date().toISOString(), duration_ms: Date.now() - startTime,
              method,
              path: url,
              upstream_path: plan.upstreamPath,
              upstream_mode: plan.upstreamMode,
              transform_applied: plan.upstreamMode === "copilot-transform",
              status: result.statusCode,
              model: usage.model || plan.mappedModel || (parsedBody?.model as string) || "",
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
              upstream_path: plan.upstreamPath,
              upstream_mode: plan.upstreamMode,
              status: result.statusCode,
              account: account.username,
              initiator,
              duration_ms: entry.duration_ms,
              dropped_fields: plan.droppedFields,
            });
          });

          return;
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          pool.markFailed(account.username);
          log.warn("Forward failed, trying next account", { account: account.username, error: error.message });
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

  const shutdown = async (signal: string) => {
    log.info("Shutting down", { signal });
    try {
      await sessionStore.flush();
    } catch (e) {
      log.warn("Session store flush failed", { error: String(e) });
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("Fatal:", e.message ?? e);
  process.exit(1);
});
