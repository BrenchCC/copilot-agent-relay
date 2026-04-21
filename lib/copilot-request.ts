import { mapModelName } from "./config";
import { RelayError } from "./types";

interface AnthropicTextBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
}

interface AnthropicMessage {
  role?: string;
  content?: unknown;
}

interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CopilotRequestTransformResult {
  path: string;
  body: Record<string, unknown>;
  stream: boolean;
  droppedFields: string[];
  mappedModel: string;
}

const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "temperature",
  "top_p",
  "stop_sequences",
  "tools",
  "tool_choice",
]);

export function isAnthropicMessagesPath(path: string): boolean {
  const url = new URL(path, "http://localhost");
  return url.pathname === "/v1/messages" || url.pathname === "/claude/v1/messages";
}

export function rewriteCopilotPath(path: string): string {
  const url = new URL(path, "http://localhost");
  if (!isAnthropicMessagesPath(path)) return `${url.pathname}${url.search}`;

  url.pathname = "/chat/completions";
  url.searchParams.delete("beta");
  return `${url.pathname}${url.search}`;
}

export function transformAnthropicToCopilotChat(
  path: string,
  body: Record<string, unknown>,
): CopilotRequestTransformResult {
  const droppedFields = Object.keys(body).filter((key) => !ALLOWED_TOP_LEVEL_FIELDS.has(key));
  const stream = body.stream === true;
  const messages = transformMessages(body);
  if (messages.length === 0) {
    throw new RelayError("messages must contain at least one supported message", 400, "INVALID_REQUEST");
  }

  const originalModel = typeof body.model === "string" && body.model.length > 0 ? body.model : "";
  if (!originalModel) {
    throw new RelayError("model is required", 400, "INVALID_REQUEST");
  }
  const mappedModel = mapModelName(originalModel);
  const transformed: Record<string, unknown> = {
    messages,
    stream,
    model: mappedModel,
  };

  if (typeof body.max_tokens === "number") {
    if (requiresMaxCompletionTokens(mappedModel)) {
      transformed.max_completion_tokens = body.max_tokens;
    } else {
      transformed.max_tokens = body.max_tokens;
    }
  }

  if (typeof body.temperature === "number") {
    transformed.temperature = body.temperature;
  }

  if (typeof body.top_p === "number") {
    transformed.top_p = body.top_p;
  }

  if (Array.isArray(body.stop_sequences)) {
    const stop = body.stop_sequences.filter((value): value is string => typeof value === "string" && value.length > 0);
    if (stop.length > 0) transformed.stop = stop;
  }

  const tools = transformTools(body.tools);
  if (tools.length > 0) {
    transformed.tools = tools;
  }

  const toolChoice = transformToolChoice(body.tool_choice);
  if (toolChoice !== undefined) {
    transformed.tool_choice = toolChoice;
  }

  if (stream) {
    transformed.stream_options = { include_usage: true };
  }

  return {
    path: rewriteCopilotPath(path),
    body: transformed,
    stream,
    droppedFields,
    mappedModel,
  };
}

export function requiresMaxCompletionTokens(model: string): boolean {
  return isOpenAiOSeries(model) || isGptFiveFamily(model);
}

function isOpenAiOSeries(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.length > 1 && lower.startsWith("o") && /\d/.test(lower[1] ?? "");
}

function isGptFiveFamily(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith("gpt-5");
}

export function mapModel(model: string): string {
  return model;
}

function transformMessages(body: Record<string, unknown>): Record<string, unknown>[] {
  const raw: Record<string, unknown>[] = [];

  const systemText = readSystemText(body.system);
  if (systemText.length > 0) {
    raw.push({ role: "system", content: systemText });
  }

  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages)) return raw;

  for (const rawMessage of rawMessages) {
    if (!rawMessage || typeof rawMessage !== "object") continue;
    const message = rawMessage as AnthropicMessage;
    const role = message.role;
    if (role === "user") {
      raw.push(...transformUserMessage(message.content));
      continue;
    }
    if (role === "assistant") {
      const assistantMessage = transformAssistantMessage(message.content);
      if (assistantMessage) raw.push(assistantMessage);
      continue;
    }
    if (role === "system") {
      const content = blocksToText(message.content);
      if (content.length > 0) raw.push({ role: "system", content });
      continue;
    }
    if (role === "tool") {
      const content = blocksToText(message.content);
      const rawMsg = message as Record<string, unknown>;
      const toolCallId = typeof rawMsg.tool_call_id === "string" && (rawMsg.tool_call_id as string).length > 0
        ? sanitizeToolCallId(rawMsg.tool_call_id as string)
        : undefined;
      raw.push({ role: "tool", content, ...(toolCallId ? { tool_call_id: toolCallId } : {}) });
    }
  }

  return mergeConsecutiveSameRole(raw);
}

// OpenAI Chat API disallows consecutive messages with the same role (user, system).
// Merge them by joining their text content with newlines.
function mergeConsecutiveSameRole(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const MERGEABLE_ROLES = new Set(["user", "system"]);
  const output: Record<string, unknown>[] = [];

  for (const msg of messages) {
    const prev = output[output.length - 1];
    if (
      prev &&
      MERGEABLE_ROLES.has(msg.role as string) &&
      prev.role === msg.role &&
      typeof prev.content === "string" &&
      typeof msg.content === "string"
    ) {
      prev.content = prev.content + "\n" + msg.content;
    } else {
      output.push({ ...msg });
    }
  }

  return output;
}

function transformUserMessage(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const output: Record<string, unknown>[] = [];
  const textParts: string[] = [];

  const flushText = () => {
    const text = textParts.join("\n").trim();
    if (text.length > 0) {
      output.push({ role: "user", content: text });
      textParts.length = 0;
    }
  };

  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as Record<string, unknown>;
    switch (block.type) {
      case "text": {
        const text = typeof block.text === "string" ? block.text : "";
        if (text.length > 0) textParts.push(text);
        break;
      }
      case "tool_result": {
        flushText();
        output.push(transformToolResultBlock(block as unknown as AnthropicToolResultBlock));
        break;
      }
      case "thinking":
      case "redacted_thinking":
        break;
      default:
        throwUnsupportedContentBlock(block.type);
    }
  }

  flushText();
  return output;
}

function transformAssistantMessage(content: unknown): Record<string, unknown> | null {
  if (typeof content === "string") {
    return { role: "assistant", content };
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts: string[] = [];
  const toolCalls: OpenAiToolCall[] = [];

  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as Record<string, unknown>;
    switch (block.type) {
      case "text": {
        const text = typeof block.text === "string" ? block.text : "";
        if (text.length > 0) textParts.push(text);
        break;
      }
      case "tool_use":
        toolCalls.push(transformToolUseBlock(block as unknown as AnthropicToolUseBlock));
        break;
      case "thinking":
      case "redacted_thinking":
        break;
      default:
        throwUnsupportedContentBlock(block.type);
    }
  }

  if (textParts.length === 0 && toolCalls.length === 0) {
    return null;
  }

  return {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("\n") : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

// Copilot API rejects tool_call_ids that don't match expected formats
// (e.g. "functions.Bash:0"). Normalize to "call_" prefix using a
// deterministic hash so assistant→tool_result pairing is preserved.
const VALID_TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolCallId(id: string): string {
  if (VALID_TOOL_ID_RE.test(id)) return id;
  // Simple deterministic hash (FNV-1a 32-bit) encoded as base36
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `call_${(h >>> 0).toString(36)}_${id.length}`;
}

function transformToolUseBlock(block: AnthropicToolUseBlock): OpenAiToolCall {
  const name = typeof block.name === "string" && block.name.length > 0
    ? block.name
    : "tool";
  const rawId = typeof block.id === "string" && block.id.length > 0
    ? block.id
    : `tool_${Math.random().toString(36).slice(2, 10)}`;
  return {
    id: sanitizeToolCallId(rawId),
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(block.input ?? {}),
    },
  };
}

function transformToolResultBlock(block: AnthropicToolResultBlock): Record<string, unknown> {
  const rawId = typeof block.tool_use_id === "string" && block.tool_use_id.length > 0
    ? block.tool_use_id
    : "tool_result";
  return {
    role: "tool",
    tool_call_id: sanitizeToolCallId(rawId),
    content: toolResultContentToText(block.content),
  };
}

function transformTools(rawTools: unknown): OpenAiTool[] {
  if (!Array.isArray(rawTools)) return [];

  return rawTools.flatMap((rawTool) => {
    if (!rawTool || typeof rawTool !== "object") return [];
    const tool = rawTool as Record<string, unknown>;
    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name) return [];
    return [{
      type: "function" as const,
      function: {
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.input_schema !== undefined ? { parameters: tool.input_schema } : {}),
      },
    }];
  });
}

function transformToolChoice(rawToolChoice: unknown): unknown {
  if (!rawToolChoice) return undefined;
  if (typeof rawToolChoice === "string") return rawToolChoice;
  if (typeof rawToolChoice !== "object") return undefined;

  const toolChoice = rawToolChoice as Record<string, unknown>;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return {
      type: "function",
      function: {
        name: toolChoice.name,
      },
    };
  }
  return undefined;
}

function readSystemText(rawSystem: unknown): string {
  if (typeof rawSystem === "string") return rawSystem;
  if (!Array.isArray(rawSystem)) return "";
  return rawSystem
    .filter((block): block is AnthropicTextBlock => !!block && typeof block === "object" && (block as AnthropicTextBlock).type === "text")
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];
  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n");
}

function toolResultContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return blocksToText(content);
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

function throwUnsupportedContentBlock(type: unknown): never {
  const detail = typeof type === "string" && type.length > 0 ? type : "unknown";
  throw new RelayError(`unsupported content block for Copilot transform: ${detail}`, 400, "UNSUPPORTED_CONTENT_BLOCK");
}
