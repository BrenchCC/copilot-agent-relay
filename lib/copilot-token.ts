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

  getToken(): string { return this.token; }
  getApiBase(): string { return this.apiBase; }
  setApiBase(base: string): void { this.apiBase = base; }

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
      if (!this.disposed) {
        this.refreshTimer = setTimeout(() => this.backgroundRefresh(), 30_000);
      }
    }
  }
}
