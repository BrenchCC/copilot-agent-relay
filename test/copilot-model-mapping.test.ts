import { describe, expect, test } from "bun:test";

import { mapModelName } from "../lib/config";
import { requiresMaxCompletionTokens, transformAnthropicToCopilotChat } from "../lib/copilot-request";

describe("copilot model mapping", () => {
  test("converts dashed version suffixes to dotted form for claude haiku/sonnet/opus", () => {
    expect(mapModelName("claude-opus-4-7")).toBe("claude-opus-4.7");
    expect(mapModelName("claude-sonnet-4-6")).toBe("claude-sonnet-4.6");
    expect(mapModelName("claude-haiku-4-5")).toBe("claude-haiku-4.5");
  });

  test("strips trailing YYYYMMDD date suffix", () => {
    expect(mapModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4.5");
    expect(mapModelName("claude-opus-4-7-20260101")).toBe("claude-opus-4.7");
  });

  test("leaves other model names unchanged", () => {
    expect(mapModelName("claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
    expect(mapModelName("gpt-5.4")).toBe("gpt-5.4");
    expect(mapModelName("o4-mini")).toBe("o4-mini");
    expect(mapModelName("claude-opus-4.7")).toBe("claude-opus-4.7");
  });

  test("uses max_completion_tokens for gpt-5 and o-series", () => {
    expect(requiresMaxCompletionTokens("gpt-5.4")).toBe(true);
    expect(requiresMaxCompletionTokens("o4-mini")).toBe(true);
    expect(requiresMaxCompletionTokens("gpt-4.1")).toBe(false);
  });

  test("emits mapped model for transformed claude request", () => {
    const transformed = transformAnthropicToCopilotChat("/v1/messages", {
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
    });

    expect(transformed.body.model).toBe("claude-sonnet-4.5");
    expect(transformed.body.max_tokens).toBe(128);
    expect(transformed.body.max_completion_tokens).toBeUndefined();
  });
});
