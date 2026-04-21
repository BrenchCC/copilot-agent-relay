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

interface ModelStats { model: string; requests: number; premium_requests: number; input_tokens: number; output_tokens: number; }
interface AccountStats { account: string; requests: number; premium_requests: number; input_tokens: number; output_tokens: number; }

export interface StatsResult {
  period: { since: string; until: string };
  totals: { requests: number; premium_requests: number; non_premium_requests: number; input_tokens: number; output_tokens: number; };
  by_model: ModelStats[];
  by_account: AccountStats[];
  by_initiator: { user: number; agent: number };
}

export async function aggregateStats(logPath: string, range: { since: Date; until: Date }): Promise<StatsResult> {
  const result: StatsResult = {
    period: { since: range.since.toISOString(), until: range.until.toISOString() },
    totals: { requests: 0, premium_requests: 0, non_premium_requests: 0, input_tokens: 0, output_tokens: 0 },
    by_model: [], by_account: [], by_initiator: { user: 0, agent: 0 },
  };
  try { await access(logPath, constants.R_OK); } catch { return result; }

  const modelMap = new Map<string, ModelStats>();
  const accountMap = new Map<string, AccountStats>();
  const rl = createInterface({ input: createReadStream(logPath, "utf-8"), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const ts = new Date(entry.ts);
      if (ts < range.since || ts >= range.until) continue;
      const isPremium = entry.initiator === "user";
      result.totals.requests++;
      if (isPremium) result.totals.premium_requests++; else result.totals.non_premium_requests++;
      result.totals.input_tokens += entry.input_tokens ?? 0;
      result.totals.output_tokens += entry.output_tokens ?? 0;
      if (isPremium) result.by_initiator.user++; else result.by_initiator.agent++;

      const model = entry.model ?? "unknown";
      let ms = modelMap.get(model);
      if (!ms) { ms = { model, requests: 0, premium_requests: 0, input_tokens: 0, output_tokens: 0 }; modelMap.set(model, ms); }
      ms.requests++; if (isPremium) ms.premium_requests++;
      ms.input_tokens += entry.input_tokens ?? 0; ms.output_tokens += entry.output_tokens ?? 0;

      const account = entry.account ?? "unknown";
      let as_ = accountMap.get(account);
      if (!as_) { as_ = { account, requests: 0, premium_requests: 0, input_tokens: 0, output_tokens: 0 }; accountMap.set(account, as_); }
      as_.requests++; if (isPremium) as_.premium_requests++;
      as_.input_tokens += entry.input_tokens ?? 0; as_.output_tokens += entry.output_tokens ?? 0;
    } catch { /* skip */ }
  }

  result.by_model = [...modelMap.values()].sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens));
  result.by_account = [...accountMap.values()].sort((a, b) => b.output_tokens - a.output_tokens);
  return result;
}
