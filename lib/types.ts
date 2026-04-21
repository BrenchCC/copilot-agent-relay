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
  upstream_path?: string;
  upstream_mode?: string;
  transform_applied?: boolean;
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

export interface NormalizedErrorBody {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

export interface TransformUsage {
  model: string;
  message_id: string;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
}

export interface RelayConfigFile {
  relaySecret?: string;
  relayPort?: number;
  relayBind?: string;
  dataDir?: string;
  logLevel?: string;
  upstreamTimeoutMs?: number;
  accountCooldownMs?: number;
  tokenRefreshSkewS?: number;
  forceAgentInitiator?: "always" | "session" | "off";
  /**
   * How long (ms) to remember a session→account binding after the last
   * request from that session. Defaults to 1 hour.
   */
  sessionAffinityTtlMs?: number;
}

export const DEFAULT_RELAY_CONFIG_FILE = ".relay-config.json";

export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export interface UsageTapResult {
  model: string;
  message_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  stop_reason: string;
}

export const COPILOT_HEADERS = {
  "editor-version": "vscode/1.110.1",
  "editor-plugin-version": "copilot-chat/0.38.2",
  "user-agent": "GitHubCopilotChat/0.38.2",
  "x-github-api-version": "2025-10-01",
} as const;

export const DEFAULT_API_BASE = "https://api.individual.githubcopilot.com";
