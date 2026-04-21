// lib/usage-poll.ts
import { COPILOT_HEADERS, type CopilotUsageResponse } from "./types";
import { RelayError } from "./types";

const USAGE_URL = "https://api.github.com/copilot_internal/user";
const POLL_INTERVAL_MS = 5 * 60 * 1000;

export class UsagePoller {
  private cached: CopilotUsageResponse | null = null;
  private queriedAt: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly githubToken: string, private readonly username: string) {}

  async poll(): Promise<CopilotUsageResponse> {
    const resp = await fetch(USAGE_URL, {
      headers: { authorization: `token ${this.githubToken}`, "content-type": "application/json", accept: "application/json", ...COPILOT_HEADERS },
    });
    if (!resp.ok) throw new RelayError(`Copilot usage fetch failed for ${this.username}: ${resp.status}`, resp.status);
    const data = (await resp.json()) as CopilotUsageResponse;
    this.cached = data;
    this.queriedAt = new Date();
    return data;
  }

  getCached(): CopilotUsageResponse | null { return this.cached; }
  getQueriedAt(): Date | null { return this.queriedAt; }
  getApiBase(): string | null { return this.cached?.endpoints?.api ?? null; }

  startBackground(): void {
    if (this.disposed || this.timer) return;
    this.timer = setInterval(async () => { try { await this.poll(); } catch { /* retry next interval */ } }, POLL_INTERVAL_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
