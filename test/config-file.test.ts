import { describe, expect, test } from "bun:test";

import { createDefaultRelayConfig, formatRelayConfigFile, mapModelName } from "../lib/config";

describe("relay config file", () => {
  test("creates default config without model mapping", () => {
    const config = createDefaultRelayConfig("x".repeat(64));
    expect(config.relaySecret).toBe("x".repeat(64));
    expect((config as Record<string, unknown>).modelMapping).toBeUndefined();
  });

  test("formats config file as json", () => {
    const content = formatRelayConfigFile("y".repeat(64));
    const parsed = JSON.parse(content);
    expect(parsed.relaySecret).toBe("y".repeat(64));
    expect(parsed.modelMapping).toBeUndefined();
  });

  test("mapModelName normalizes dashed version numbers", () => {
    expect(mapModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4.5");
    expect(mapModelName("claude-opus-4-7")).toBe("claude-opus-4.7");
  });
});
