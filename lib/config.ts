// lib/config.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_RELAY_CONFIG_FILE,
  RelayError,
  type RelayConfigFile,
} from "./types";

export interface Config {
  secret: string;
  port: number;
  bind: string;
  dataDir: string;
  logLevel: string;
  upstreamTimeoutMs: number;
  accountCooldownMs: number;
  tokenRefreshSkewS: number;
  forceAgentInitiator: "always" | "session" | "off";
  sessionAffinityTtlMs: number;
  configFilePath: string;
}

export async function parseConfig(configFileOverride?: string): Promise<Config> {
  const configFilePath = configFileOverride ?? process.env.RELAY_CONFIG_FILE ?? DEFAULT_RELAY_CONFIG_FILE;
  const fileConfig = await readConfigFile(configFilePath);

  const dataDir = String(fileConfig.dataDir ?? "./data");
  const secret = await resolveSecret(fileConfig, dataDir);

  if (!secret) {
    throw new RelayError("relaySecret in config file or data/relay.key is required", 500, "CONFIG_MISSING");
  }
  if (secret.length < 32) {
    throw new RelayError("relaySecret must be at least 32 characters", 500, "CONFIG_INVALID");
  }

  return {
    secret,
    port: fileConfig.relayPort ?? 8787,
    bind: fileConfig.relayBind ?? "127.0.0.1",
    dataDir,
    logLevel: (fileConfig.logLevel ?? "info").toLowerCase(),
    upstreamTimeoutMs: fileConfig.upstreamTimeoutMs ?? 300000,
    accountCooldownMs: fileConfig.accountCooldownMs ?? 300000,
    tokenRefreshSkewS: fileConfig.tokenRefreshSkewS ?? 60,
    forceAgentInitiator: parseInitiatorMode(fileConfig.forceAgentInitiator ?? "session"),
    sessionAffinityTtlMs: fileConfig.sessionAffinityTtlMs ?? 60 * 60 * 1000,
    configFilePath,
  };
}

async function readConfigFile(filePath: string): Promise<RelayConfigFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as RelayConfigFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      throw new RelayError(
        `Config file not found: ${filePath}\nRun "bun run relay generate-secret" and create a config file first.\nSee: formatRelayConfigFile() for the default template.`,
        500,
        "CONFIG_MISSING",
      );
    }
    throw new RelayError(`Failed to read config file ${filePath}: ${message}`, 500, "CONFIG_INVALID");
  }
}

async function resolveSecret(fileConfig: RelayConfigFile, dataDir: string): Promise<string | null> {
  const fileSecret = fileConfig.relaySecret?.trim();
  if (fileSecret) return fileSecret;

  try {
    return (await readFile(join(dataDir, "relay.key"), "utf-8")).trim();
  } catch {
    return null;
  }
}

function parseInitiatorMode(value: string): "always" | "session" | "off" {
  const v = value.toLowerCase();
  if (v === "always" || v === "true") return "always";
  if (v === "session") return "session";
  if (v === "off" || v === "false") return "off";
  return "session";
}

export function hasThinkingEnabled(body: Record<string, unknown>): boolean {
  const thinking = body.thinking;
  if (!thinking || typeof thinking !== "object") return false;
  const type = (thinking as Record<string, unknown>).type;
  return type === "enabled" || type === "adaptive";
}

export function mapModelName(originalModel: string): string {
  if (!originalModel) return originalModel;
  const match = originalModel.match(/^claude-(haiku|sonnet|opus)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (!match) return originalModel;
  const [, family, major, minor] = match;
  return `claude-${family}-${major}.${minor}`;
}

export function createDefaultRelayConfig(secret = ""): RelayConfigFile {
  return {
    relaySecret: secret || undefined,
    relayPort: 8787,
    relayBind: "127.0.0.1",
    dataDir: "./data",
    logLevel: "info",
    upstreamTimeoutMs: 300000,
    accountCooldownMs: 300000,
    tokenRefreshSkewS: 60,
    forceAgentInitiator: "session",
  };
}

export function formatRelayConfigFile(secret = ""): string {
  return `${JSON.stringify(createDefaultRelayConfig(secret), null, 2)}\n`;
}

export { DEFAULT_RELAY_CONFIG_FILE };
