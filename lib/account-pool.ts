import type { TokenManager } from "./copilot-token";
import type { SessionStore } from "./session-store";

export interface PoolAccount {
  username: string;
  githubToken: string;
  tokenManager: TokenManager;
  failedAt: number | null;
}

interface SessionAssignment {
  username: string;
  lastUsedAt: number;
}

export interface AccountPoolOptions {
  /** Cooldown before a failed account is reconsidered. */
  cooldownMs: number;
  /**
   * How long a session→account binding is kept after the session's last
   * request. After this, the session is treated as new.
   */
  sessionAffinityTtlMs?: number;
  /** Optional on-disk mirror of session assignments (for restart persistence). */
  store?: SessionStore;
}

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export class AccountPool {
  private currentIndex = 0;
  private readonly cooldownMs: number;
  private readonly sessionTtlMs: number;
  private readonly sessions = new Map<string, SessionAssignment>();
  private readonly store: SessionStore | null;

  constructor(
    private readonly accounts: PoolAccount[],
    cooldownMsOrOptions: number | AccountPoolOptions,
    sessionAffinityTtlMs?: number,
  ) {
    if (typeof cooldownMsOrOptions === "number") {
      this.cooldownMs = cooldownMsOrOptions;
      this.sessionTtlMs = sessionAffinityTtlMs ?? DEFAULT_SESSION_TTL_MS;
      this.store = null;
    } else {
      this.cooldownMs = cooldownMsOrOptions.cooldownMs;
      this.sessionTtlMs = cooldownMsOrOptions.sessionAffinityTtlMs ?? DEFAULT_SESSION_TTL_MS;
      this.store = cooldownMsOrOptions.store ?? null;
    }
    for (const acc of this.accounts) {
      if (acc.failedAt === undefined) acc.failedAt = null;
    }
  }

  /**
   * Pick a healthy account using round-robin. Used when no session
   * context is available (or as an affinity fallback).
   */
  getHealthy(): PoolAccount | null {
    const len = this.accounts.length;
    if (len === 0) return null;
    for (let i = 0; i < len; i++) {
      const idx = (this.currentIndex + i) % len;
      const acc = this.accounts[idx];
      if (this.isHealthy(acc)) {
        this.currentIndex = (idx + 1) % len;
        return acc;
      }
    }
    return null;
  }

  /**
   * Pick an account for a given session. Requests from the same session
   * are routed to the same account (if still healthy). New sessions are
   * spread across accounts by picking the one with the fewest currently
   * active session bindings.
   *
   * If `sessionKey` is null/empty, behaves like `getHealthy()`.
   */
  getForSession(sessionKey: string | null | undefined): PoolAccount | null {
    if (!sessionKey) return this.getHealthy();

    this.sweepExpiredSessions();

    // Consult persistent store first — it may have an assignment we haven't
    // seen in-memory yet (e.g. immediately after startup).
    if (this.store && !this.sessions.has(sessionKey)) {
      const persisted = this.store.getAssignment(sessionKey);
      if (persisted) {
        this.sessions.set(sessionKey, { username: persisted, lastUsedAt: Date.now() });
      }
    }

    const existing = this.sessions.get(sessionKey);
    if (existing) {
      const acc = this.findAccount(existing.username);
      if (acc && this.isHealthy(acc)) {
        existing.lastUsedAt = Date.now();
        this.store?.setAssignment(sessionKey, existing.username);
        return acc;
      }
      this.sessions.delete(sessionKey);
      this.store?.deleteAssignment(sessionKey);
    }

    const picked = this.pickLeastLoadedHealthy();
    if (!picked) return null;

    this.sessions.set(sessionKey, { username: picked.username, lastUsedAt: Date.now() });
    this.store?.setAssignment(sessionKey, picked.username);
    return picked;
  }

  bindSession(sessionKey: string | null | undefined, username: string): void {
    if (!sessionKey) return;
    this.sessions.set(sessionKey, { username, lastUsedAt: Date.now() });
    this.store?.setAssignment(sessionKey, username);
  }

  markFailed(username: string): void {
    const acc = this.findAccount(username);
    if (acc) acc.failedAt = Date.now();
  }

  markSuccess(username: string): void {
    const acc = this.findAccount(username);
    if (acc) acc.failedAt = null;
  }

  getAll(): readonly PoolAccount[] {
    return this.accounts;
  }

  /**
   * Number of currently-bound sessions for a given account. Exposed
   * primarily for tests/observability.
   */
  getSessionLoad(username: string): number {
    this.sweepExpiredSessions();
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.username === username) n++;
    }
    return n;
  }

  private isHealthy(acc: PoolAccount): boolean {
    if (acc.failedAt === null) return true;
    if (Date.now() - acc.failedAt >= this.cooldownMs) {
      acc.failedAt = null;
      return true;
    }
    return false;
  }

  private findAccount(username: string): PoolAccount | undefined {
    return this.accounts.find((a) => a.username === username);
  }

  private sweepExpiredSessions(): void {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now - s.lastUsedAt > this.sessionTtlMs) {
        this.sessions.delete(sid);
      }
    }
  }

  /**
   * Pick the healthy account with the fewest active session bindings.
   * Ties are broken by the round-robin cursor to further spread new
   * sessions across equally-loaded accounts.
   */
  private pickLeastLoadedHealthy(): PoolAccount | null {
    const len = this.accounts.length;
    if (len === 0) return null;

    const loads = new Map<string, number>();
    for (const acc of this.accounts) loads.set(acc.username, 0);
    for (const s of this.sessions.values()) {
      loads.set(s.username, (loads.get(s.username) ?? 0) + 1);
    }

    let best: PoolAccount | null = null;
    let bestLoad = Number.POSITIVE_INFINITY;

    for (let i = 0; i < len; i++) {
      const idx = (this.currentIndex + i) % len;
      const acc = this.accounts[idx];
      if (!this.isHealthy(acc)) continue;
      const load = loads.get(acc.username) ?? 0;
      if (load < bestLoad) {
        best = acc;
        bestLoad = load;
      }
    }

    if (best) {
      const bestIdx = this.accounts.indexOf(best);
      this.currentIndex = (bestIdx + 1) % len;
    }
    return best;
  }
}
