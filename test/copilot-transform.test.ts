import { describe, expect, test } from "bun:test";

import { buildAnthropicErrorResponse, transformCopilotJsonToAnthropic } from "../lib/copilot-response";
import { rewriteCopilotPath, transformAnthropicToCopilotChat } from "../lib/copilot-request";

function transform(body: Record<string, unknown>) {
  return transformAnthropicToCopilotChat("/v1/messages?beta=true", body);
}

describe("copilot request transform", () => {
  test("rewrites anthropic messages path to chat completions and strips beta query", () => {
    expect(rewriteCopilotPath("/v1/messages?beta=true&x-id=1")).toBe("/chat/completions?x-id=1");
  });

  test("maps anthropic request to chat completions payload", () => {
    const transformed = transform({
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "system prompt" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "tool_result", tool_use_id: "tool_1", content: "done" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "working" },
            { type: "tool_use", id: "tool_1", name: "read_file", input: { path: "a.ts" } },
          ],
        },
      ],
      max_tokens: 256,
      stream: true,
      stop_sequences: ["DONE"],
      context_management: { enabled: true },
    });

    expect(transformed.path).toBe("/chat/completions");
    expect(transformed.stream).toBe(true);
    expect(transformed.droppedFields).toContain("context_management");
    expect(transformed.mappedModel).toBe("claude-sonnet-4.5");
    expect(transformed.body.model).toBe("claude-sonnet-4.5");
    expect(transformed.body.max_tokens).toBe(256);
    expect(transformed.body.max_completion_tokens).toBeUndefined();
    expect(transformed.body.stream_options).toEqual({ include_usage: true });
    expect(transformed.body.stop).toEqual(["DONE"]);

    const messages = transformed.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "system prompt" });
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "tool_1", content: "done" });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: "working",
    });
    expect(messages[3]?.tool_calls).toBeArray();
  });
});

describe("copilot response transform", () => {
  test("maps chat completions json to anthropic json", () => {
    const anthropic = JSON.parse(transformCopilotJsonToAnthropic(JSON.stringify({
      id: "chatcmpl-1",
      model: "gpt-5.4",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "hello back",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "a.ts" }),
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 34,
      },
    })));

    expect(anthropic.id).toBe("chatcmpl-1");
    expect(anthropic.type).toBe("message");
    expect(anthropic.stop_reason).toBe("tool_use");
    expect(anthropic.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(anthropic.content[0]).toEqual({ type: "text", text: "hello back" });
    expect(anthropic.content[1]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { path: "a.ts" },
    });
  });

  test("maps upstream error to anthropic error envelope", () => {
    const error = JSON.parse(buildAnthropicErrorResponse(400, JSON.stringify({ message: "bad request" })));
    expect(error).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "bad request",
      },
    });
  });
});
