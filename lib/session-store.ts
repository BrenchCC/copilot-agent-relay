import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

interface Persisted {
  version: 1;
  /** session key → { account username, last-used epoch ms } */
  assignments: Record<string, { username: string; lastUsedAt: number }>;
  /** session key → first-seen epoch ms (used by initiator tracker) */
  seen: Record<string, number>;
}

/**
 * On-disk mirror of transient session state (account assignments + first-touch
 * tracking). Persists across relay restarts so we keep session affinity and
 * do not spuriously re-classify known sessions as "first turn".
 *
 * Writes are coalesced with a short debounce to avoid I/O on every request.
 */
export class SessionStore {
  private assignments = new Map<string, { username: string; lastUsedAt: number }>();
  private seen = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly ttlMs: number,
    private readonly flushDelayMs: number = 500,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const data = JSON.parse(raw) as Partial<Persisted>;
      const now = Date.now();
      for (const [k, v] of Object.entries(data.assignments ?? {})) {
        if (v && typeof v === "object" && typeof v.username === "string" && typeof v.lastUsedAt === "number") {
          if (now - v.lastUsedAt <= this.ttlMs) this.assignments.set(k, v);
        }
      }
      for (const [k, t] of Object.entries(data.seen ?? {})) {
        if (typeof t === "number" && now - t <= this.ttlMs) this.seen.set(k, t);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ENOENT")) throw err;
    }
  }

  getAssignment(key: string): string | null {
    const a = this.assignments.get(key);
    if (!a) return null;
    if (Date.now() - a.lastUsedAt > this.ttlMs) {
      this.assignments.delete(key);
      this.schedule();
      return null;
    }
    return a.username;
  }

  setAssignment(key: string, username: string): void {
    this.assignments.set(key, { username, lastUsedAt: Date.now() });
    this.schedule();
  }

  deleteAssignment(key: string): void {
    if (this.assignments.delete(key)) this.schedule();
  }

  touchSeen(key: string): boolean {
    const now = Date.now();
    const existing = this.seen.get(key);
    const isFirst = existing === undefined || now - existing > this.ttlMs;
    this.seen.set(key, now);
    this.schedule();
    return isFirst;
  }

  seenSize(): number {
    return this.seen.size;
  }

  assignmentCount(): number {
    return this.assignments.size;
  }

  /** Remove all entries whose last activity is older than the TTL. */
  sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [k, a] of this.assignments) {
      if (now - a.lastUsedAt > this.ttlMs) {
        this.assignments.delete(k);
        changed = true;
      }
    }
    for (const [k, t] of this.seen) {
      if (now - t > this.ttlMs) {
        this.seen.delete(k);
        changed = true;
      }
    }
    if (changed) this.schedule();
  }

  /** Force-flush pending writes. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.write();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.write();
    }, this.flushDelayMs);
  }

  private async write(): Promise<void> {
    if (this.writing) {
      await this.writing;
      if (!this.dirty) return;
    }
    this.dirty = false;
    const snapshot: Persisted = {
      version: 1,
      assignments: Object.fromEntries(this.assignments),
      seen: Object.fromEntries(this.seen),
    };
    const task = (async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(tmp, this.path);
    })();
    this.writing = task;
    try {
      await task;
    } finally {
      this.writing = null;
    }
  }
}
