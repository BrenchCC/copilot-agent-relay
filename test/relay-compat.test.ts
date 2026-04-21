import { describe, expect, test } from "bun:test";

import { AccountPool, type PoolAccount } from "../lib/account-pool";
import { rewriteHeaders } from "../lib/rewriter";
import { extractSessionKey } from "../lib/session-extract";
import { SessionStore } from "../lib/session-store";
import { resolveInitiator } from "../lib/initiator";

function makeAccount(username: string, failedAt: number | null = null): PoolAccount {
  return {
    username,
    githubToken: `${username}-token`,
    tokenManager: {
      getToken: () => `${username}-copilot-token`,
      getApiBase: () => "https://api.individual.githubcopilot.com",
    },
    failedAt,
  } as PoolAccount;
}

describe("rewriteHeaders", () => {
  test("strips anthropic-specific headers before forwarding upstream", () => {
    const rewritten = rewriteHeaders({
      "anthropic-beta": "context-1m-2025-08-07",
      "anthropic-version": "2023-06-01",
      "x-api-key": "local-key",
      "content-type": "application/json",
      "x-custom-header": "keep-me",
    }, {
      copilotToken: "copilot-token",
      initiator: "user",
      requestId: "req-1",
    });

    expect(rewritten["anthropic-beta"]).toBeUndefined();
    expect(rewritten["anthropic-version"]).toBeUndefined();
    expect(rewritten["x-api-key"]).toBeUndefined();
    expect(rewritten["content-type"]).toBe("application/json");
    expect(rewritten["x-custom-header"]).toBeUndefined();
    expect(rewritten.authorization).toBe("Bearer copilot-token");
    expect(rewritten["x-interaction-type"]).toBe("conversation-agent");
    expect(rewritten["x-agent-task-id"]).toBe("req-1");
  });
});

describe("AccountPool", () => {
  test("does not treat untouched account as failed", () => {
    const pool = new AccountPool([makeAccount("myWsq")], 300000);

    const healthy = pool.getHealthy();

    expect(healthy?.username).toBe("myWsq");
    expect(pool.getAll()[0]?.failedAt).toBeNull();
  });

  test("keeps account healthy when request-side 400 is not marked failed", () => {
    const pool = new AccountPool([makeAccount("myWsq")], 300000);

    const healthyBefore = pool.getHealthy();
    expect(healthyBefore?.username).toBe("myWsq");

    const healthyAfter = pool.getHealthy();
    expect(healthyAfter?.username).toBe("myWsq");
    expect(pool.getAll()[0]?.failedAt).toBeNull();
  });

  test("marks account failed when explicitly told to fail", () => {
    const pool = new AccountPool([makeAccount("myWsq")], 300000);

    pool.markFailed("myWsq");

    expect(pool.getAll()[0]?.failedAt).not.toBeNull();
    expect(pool.getHealthy()).toBeNull();
  });

  test("getHealthy round-robins across healthy accounts", () => {
    const pool = new AccountPool([makeAccount("a"), makeAccount("b")], 300000);
    const first = pool.getHealthy()?.username;
    const second = pool.getHealthy()?.username;
    const third = pool.getHealthy()?.username;
    expect(new Set([first, second]).size).toBe(2);
    expect(third).toBe(first);
  });

  test("getForSession keeps the same session on the same account", () => {
    const pool = new AccountPool([makeAccount("a"), makeAccount("b")], 300000);
    const s1a = pool.getForSession("sess-1")?.username;
    const s1b = pool.getForSession("sess-1")?.username;
    const s1c = pool.getForSession("sess-1")?.username;
    expect(s1b).toBe(s1a);
    expect(s1c).toBe(s1a);
  });

  test("getForSession spreads different sessions across accounts", () => {
    const pool = new AccountPool([makeAccount("a"), makeAccount("b")], 300000);
    const s1 = pool.getForSession("sess-1")?.username;
    const s2 = pool.getForSession("sess-2")?.username;
    expect(s1).not.toBe(s2);
  });

  test("getForSession reassigns when bound account is unhealthy", () => {
    const pool = new AccountPool([makeAccount("a"), makeAccount("b")], 300000);
    const first = pool.getForSession("sess-1")?.username;
    expect(first).toBeDefined();
    pool.markFailed(first!);
    const second = pool.getForSession("sess-1")?.username;
    expect(second).not.toBe(first);
  });

  test("bindSession records the assignment for future requests", () => {
    const pool = new AccountPool([makeAccount("a"), makeAccount("b")], 300000);
    pool.bindSession("sess-x", "b");
    expect(pool.getForSession("sess-x")?.username).toBe("b");
    expect(pool.getSessionLoad("b")).toBe(1);
  });

  test("expired session bindings are cleared", async () => {
    const pool = new AccountPool(
      [makeAccount("a"), makeAccount("b")],
      { cooldownMs: 300000, sessionAffinityTtlMs: 10 },
    );
    pool.getForSession("sess-1");
    await new Promise((r) => setTimeout(r, 20));
    // sweep happens on next call
    expect(pool.getSessionLoad("a") + pool.getSessionLoad("b")).toBe(0);
  });
});

describe("extractSessionKey", () => {
  test("returns metadata.user_id when present", () => {
    const body = {
      messages: [],
      metadata: { user_id: "device-abc" },
    };
    expect(extractSessionKey(body)).toBe("device-abc");
  });

  test("handles JSON-string user_id (Claude Code style)", () => {
    const body = {
      metadata: { user_id: '{"device_id":"d","session_id":"s1"}' },
    };
    expect(extractSessionKey(body)).toBe('{"device_id":"d","session_id":"s1"}');
  });

  test("returns null when no metadata", () => {
    expect(extractSessionKey({ messages: [] })).toBeNull();
    expect(extractSessionKey(null)).toBeNull();
    expect(extractSessionKey({ metadata: {} })).toBeNull();
  });
});

describe("SessionStore", () => {
  const tmpPath = () => `/tmp/relay-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;

  test("touchSeen reports first-time then seen", async () => {
    const s = new SessionStore(tmpPath(), 60_000, 0);
    await s.load();
    expect(s.touchSeen("a")).toBe(true);
    expect(s.touchSeen("a")).toBe(false);
    expect(s.touchSeen("b")).toBe(true);
  });

  test("assignments round-trip through disk", async () => {
    const path = tmpPath();
    const a = new SessionStore(path, 60_000, 0);
    await a.load();
    a.setAssignment("sess-1", "acct-a");
    a.touchSeen("sess-1");
    await a.flush();

    const b = new SessionStore(path, 60_000, 0);
    await b.load();
    expect(b.getAssignment("sess-1")).toBe("acct-a");
    expect(b.touchSeen("sess-1")).toBe(false); // seen survives restart
  });

  test("expired entries are not loaded from disk", async () => {
    const path = tmpPath();
    const a = new SessionStore(path, 10, 0);
    await a.load();
    a.setAssignment("sess-1", "acct-a");
    a.touchSeen("sess-1");
    await a.flush();
    await new Promise((r) => setTimeout(r, 20));

    const b = new SessionStore(path, 10, 0);
    await b.load();
    expect(b.getAssignment("sess-1")).toBeNull();
    expect(b.touchSeen("sess-1")).toBe(true);
  });
});

describe("resolveInitiator (session mode)", () => {
  test("uses firstTurnBySession when provided: true → user", () => {
    expect(resolveInitiator("agent", "session", { messages: [{ role: "user" }, { role: "assistant" }] }, true))
      .toBe("user");
  });

  test("uses firstTurnBySession when provided: false → agent", () => {
    expect(resolveInitiator("user", "session", { messages: [{ role: "user" }] }, false))
      .toBe("agent");
  });

  test("falls back to message-count heuristic when no session signal", () => {
    expect(resolveInitiator("user", "session", { messages: [{ role: "user" }] }))
      .toBe("user");
    expect(resolveInitiator("user", "session", { messages: [{ role: "user" }, { role: "assistant" }] }))
      .toBe("agent");
  });

  test("off mode ignores session signal and returns inferred", () => {
    expect(resolveInitiator("user", "off", {}, false)).toBe("user");
    expect(resolveInitiator("agent", "off", {}, true)).toBe("agent");
  });

  test("always mode ignores session signal", () => {
    expect(resolveInitiator("user", "always", {}, true)).toBe("agent");
  });
});
