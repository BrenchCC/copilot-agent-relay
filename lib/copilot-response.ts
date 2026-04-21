import { Transform } from "node:stream";

interface UsageState {
  model: string;
  messageId: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

interface CopilotTransformOptions {
  contentType: string;
}

function createInitialUsageState(): UsageState {
  return {
    model: "",
    messageId: "",
    inputTokens: 0,
    outputTokens: 0,
    stopReason: "",
  };
}

export function buildAnthropicErrorResponse(status: number, bodyText: string): string {
  const parsed = safeJsonParse(bodyText);
  const message = readErrorMessage(parsed) || bodyText || "Upstream request failed";
  const type = mapErrorType(status);
  return JSON.stringify({
    type: "error",
    error: {
      type,
      message,
    },
  });
}

export function transformCopilotJsonToAnthropic(bodyText: string): string {
  const parsed = safeJsonParse(bodyText);
  if (!parsed || typeof parsed !== "object") return bodyText;

  const data = parsed as Record<string, unknown>;
  const usage = readUsage(data);
  const choice = Array.isArray(data.choices) ? data.choices[0] as Record<string, unknown> | undefined : undefined;
  const message = choice && typeof choice.message === "object" ? choice.message as Record<string, unknown> : undefined;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "end_turn";
  const content = transformAssistantMessage(message);

  return JSON.stringify({
    id: typeof data.id === "string" ? data.id : "msg_copilot_relay",
    type: "message",
    role: "assistant",
    model: typeof data.model === "string" ? data.model : "",
    content,
    stop_reason: mapStopReason(finishReason, content),
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
}

export function createCopilotResponseTransform(options: CopilotTransformOptions): Transform {
  if (options.contentType.includes("text/event-stream")) {
    return createCopilotSseTransform();
  }
  return createCopilotJsonTransform();
}

function createCopilotJsonTransform(): Transform {
  const chunks: Buffer[] = [];
  return new Transform({
    transform(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
    flush(callback) {
      try {
        const bodyText = Buffer.concat(chunks).toString();
        this.push(transformCopilotJsonToAnthropic(bodyText));
      } catch {
        this.push(Buffer.concat(chunks));
      }
      callback();
    },
  });
}

function createCopilotSseTransform(): Transform {
  let buffer = "";
  let hasSentMessageStart = false;
  let nextContentIndex = 0;
  let currentNonToolBlockType: "text" | "thinking" | null = null;
  let currentNonToolBlockIndex: number | null = null;
  const usageState = createInitialUsageState();
  const toolBlocksByIndex = new Map<number, {
    anthropicIndex: number;
    id: string;
    name: string;
    started: boolean;
    pendingArgs: string;
  }>();
  const openToolBlockIndices = new Set<number>();

  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data: ") || line.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.startsWith("data: ") ? dataLine.slice(6).trim() : dataLine.slice(5).trim();
        if (payload === "[DONE]") {
          pushTypedEvent(this, "message_stop", { type: "message_stop" });
          continue;
        }

        const parsed = safeJsonParse(payload);
        if (!parsed || typeof parsed !== "object") continue;
        const data = parsed as Record<string, unknown>;
        const choice = Array.isArray(data.choices)
          ? (data.choices as unknown[])[0] as Record<string, unknown> | undefined
          : undefined;
        const delta = choice && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {};

        if (typeof data.model === "string") {
          usageState.model = data.model as string;
        }
        if (typeof data.id === "string") {
          usageState.messageId = data.id as string;
        }
        const parsedUsage = readUsage(data);
        usageState.inputTokens = Math.max(usageState.inputTokens, parsedUsage.input_tokens);
        usageState.outputTokens = Math.max(usageState.outputTokens, parsedUsage.output_tokens);

        // Emit message_start once we have a choice
        if (!hasSentMessageStart && choice) {
          hasSentMessageStart = true;
          const startUsage: Record<string, number> = {
            input_tokens: usageState.inputTokens,
            output_tokens: 0,
          };
          pushTypedEvent(this, "message_start", {
            type: "message_start",
            message: {
              id: usageState.messageId || "msg_copilot_relay",
              type: "message",
              role: "assistant",
              model: usageState.model,
              usage: startUsage,
            },
          });
        }

        if (!choice) continue;

        // Handle text content
        if (typeof delta.content === "string" && delta.content.length > 0) {
          if (currentNonToolBlockType !== "text") {
            // Close previous non-tool block if any
            if (currentNonToolBlockIndex !== null) {
              pushTypedEvent(this, "content_block_stop", {
                type: "content_block_stop",
                index: currentNonToolBlockIndex,
              });
            }
            const blockIndex = nextContentIndex++;
            pushTypedEvent(this, "content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "text", text: "" },
            });
            currentNonToolBlockType = "text";
            currentNonToolBlockIndex = blockIndex;
          }

          if (currentNonToolBlockIndex !== null) {
            pushTypedEvent(this, "content_block_delta", {
              type: "content_block_delta",
              index: currentNonToolBlockIndex,
              delta: { type: "text_delta", text: delta.content },
            });
          }
        }

        // Handle tool calls
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls as Record<string, unknown>[] : [];
        if (toolCalls.length > 0) {
          // Close non-tool block before tool calls
          if (currentNonToolBlockIndex !== null) {
            pushTypedEvent(this, "content_block_stop", {
              type: "content_block_stop",
              index: currentNonToolBlockIndex,
            });
            currentNonToolBlockIndex = null;
            currentNonToolBlockType = null;
          }

          for (const rawToolCall of toolCalls) {
            const openaiIndex = typeof rawToolCall.index === "number" ? rawToolCall.index : toolBlocksByIndex.size;
            let state = toolBlocksByIndex.get(openaiIndex);
            if (!state) {
              state = {
                anthropicIndex: nextContentIndex++,
                id: "",
                name: "",
                started: false,
                pendingArgs: "",
              };
              toolBlocksByIndex.set(openaiIndex, state);
            }

            if (typeof rawToolCall.id === "string") state.id = rawToolCall.id;
            const func = typeof rawToolCall.function === "object" ? rawToolCall.function as Record<string, unknown> : {};
            if (typeof func.name === "string" && func.name.length > 0) state.name = func.name;

            // Only start when we have both id and name
            const shouldStart = !state.started && state.id.length > 0 && state.name.length > 0;
            if (shouldStart) {
              state.started = true;
              pushTypedEvent(this, "content_block_start", {
                type: "content_block_start",
                index: state.anthropicIndex,
                content_block: {
                  type: "tool_use",
                  id: state.id,
                  name: state.name,
                },
              });
              openToolBlockIndices.add(state.anthropicIndex);

              // Flush any pending args accumulated before start
              if (state.pendingArgs.length > 0) {
                pushTypedEvent(this, "content_block_delta", {
                  type: "content_block_delta",
                  index: state.anthropicIndex,
                  delta: { type: "input_json_delta", partial_json: state.pendingArgs },
                });
                state.pendingArgs = "";
              }
            }

            // Handle arguments delta
            if (typeof func.arguments === "string") {
              if (state.started) {
                pushTypedEvent(this, "content_block_delta", {
                  type: "content_block_delta",
                  index: state.anthropicIndex,
                  delta: { type: "input_json_delta", partial_json: func.arguments },
                });
              } else {
                // Buffer args until we can start the block
                state.pendingArgs += func.arguments;
              }
            }
          }
        }

        // Handle finish_reason
        if (typeof choice.finish_reason === "string") {
          usageState.stopReason = mapStopReason(choice.finish_reason, []);

          // Close current non-tool block
          if (currentNonToolBlockIndex !== null) {
            pushTypedEvent(this, "content_block_stop", {
              type: "content_block_stop",
              index: currentNonToolBlockIndex,
            });
            currentNonToolBlockIndex = null;
            currentNonToolBlockType = null;
          }

          // Late-start any tool blocks that never got id+name
          for (const [toolIdx, state] of toolBlocksByIndex.entries()) {
            if (state.started) continue;
            const hasPayload = state.pendingArgs.length > 0 || state.id.length > 0 || state.name.length > 0;
            if (!hasPayload) continue;

            state.started = true;
            const fallbackId = state.id || `tool_call_${toolIdx}`;
            const fallbackName = state.name || "unknown_tool";
            pushTypedEvent(this, "content_block_start", {
              type: "content_block_start",
              index: state.anthropicIndex,
              content_block: {
                type: "tool_use",
                id: fallbackId,
                name: fallbackName,
              },
            });
            openToolBlockIndices.add(state.anthropicIndex);
            if (state.pendingArgs.length > 0) {
              pushTypedEvent(this, "content_block_delta", {
                type: "content_block_delta",
                index: state.anthropicIndex,
                delta: { type: "input_json_delta", partial_json: state.pendingArgs },
              });
              state.pendingArgs = "";
            }
          }

          // Close all open tool blocks
          const sortedIndices = [...openToolBlockIndices].sort((a, b) => a - b);
          for (const blockIndex of sortedIndices) {
            pushTypedEvent(this, "content_block_stop", {
              type: "content_block_stop",
              index: blockIndex,
            });
          }
          openToolBlockIndices.clear();

          // Emit message_delta with stop reason and usage
          pushTypedEvent(this, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: usageState.stopReason || "end_turn", stop_sequence: null },
            usage: { input_tokens: usageState.inputTokens, output_tokens: usageState.outputTokens },
          });
        }
      }
      callback();
    },
  });
}

function transformAssistantMessage(message?: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!message) return [];

  const content: Array<Record<string, unknown>> = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as Record<string, unknown>[] : [];
  for (const rawToolCall of toolCalls) {
    const func = typeof rawToolCall.function === "object" ? rawToolCall.function as Record<string, unknown> : {};
    const input = typeof func.arguments === "string" ? safeJsonParse(func.arguments) ?? { raw: func.arguments } : {};
    content.push({
      type: "tool_use",
      id: typeof rawToolCall.id === "string" ? rawToolCall.id : "tool_call",
      name: typeof func.name === "string" ? func.name : "tool",
      input,
    });
  }

  return content;
}

function readUsage(data: Record<string, unknown>): { input_tokens: number; output_tokens: number } {
  const usage = typeof data.usage === "object" ? data.usage as Record<string, unknown> : {};
  return {
    input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
  };
}

function mapStopReason(finishReason: string, content: Array<Record<string, unknown>>): string {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls" || finishReason === "function_call") return "tool_use";
  if (content.some((block) => block.type === "tool_use")) return "tool_use";
  return "end_turn";
}

function readErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const error = typeof obj.error === "object" ? obj.error as Record<string, unknown> : null;
  if (error && typeof error.message === "string") return error.message;
  if (typeof obj.message === "string") return obj.message;
  return null;
}

function mapErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pushTypedEvent(stream: Transform, eventType: string, payload: unknown): void {
  stream.push(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
}
