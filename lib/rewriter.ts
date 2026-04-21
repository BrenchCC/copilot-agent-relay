import { COPILOT_HEADERS } from "./types";

const STRIPPED_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "accept-encoding",
  "transfer-encoding",
  "anthropic-beta",
  "anthropic-version",
  "x-api-key",
]);

export interface RewriteOptions {
  copilotToken: string;
  initiator: "user" | "agent";
  requestId: string;
  mode: "passthrough" | "copilot-transform";
}

export function rewriteHeaders(
  incoming: Record<string, string>,
  opts: RewriteOptions,
): Record<string, string> {
  const result: Record<string, string> = {};

  const accept = typeof incoming.accept === "string" && incoming.accept.length > 0
    ? incoming.accept
    : opts.mode === "copilot-transform"
      ? "application/json"
      : "*/*";

  result["accept"] = accept;
  result["content-type"] = "application/json";
  result["authorization"] = `Bearer ${opts.copilotToken}`;
  result["editor-version"] = COPILOT_HEADERS["editor-version"];
  result["editor-plugin-version"] = COPILOT_HEADERS["editor-plugin-version"];
  result["user-agent"] = COPILOT_HEADERS["user-agent"];
  result["x-github-api-version"] = COPILOT_HEADERS["x-github-api-version"];
  result["copilot-integration-id"] = "vscode-chat";
  result["openai-intent"] = "conversation-agent";
  result["x-initiator"] = opts.initiator;
  result["x-interaction-type"] = "conversation-agent";
  result["x-request-id"] = opts.requestId;
  result["x-agent-task-id"] = opts.requestId;

  if (opts.mode === "passthrough") {
    for (const [key, value] of Object.entries(incoming)) {
      if (!STRIPPED_HEADERS.has(key.toLowerCase()) && !(key.toLowerCase() in result)) {
        result[key.toLowerCase()] = value;
      }
    }
  }

  return result;
}

export function filterResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "content-encoding") continue;
    result[lower] = value;
  }
  return result;
}

export function anthropicResponseHeaders(contentType: string): Record<string, string> {
  return filterResponseHeaders({
    "content-type": contentType,
    connection: "keep-alive",
    "cache-control": "no-cache",
  });
}

export function shouldMarkAccountFailed(statusCode: number): boolean {
  return statusCode === 401
    || statusCode === 403
    || statusCode === 429
    || statusCode >= 500;
}

export function isRetryableUpstreamStatus(statusCode: number): boolean {
  return statusCode === 401
    || statusCode === 403
    || statusCode === 429
    || statusCode >= 500;
}

export function shouldTransformUpstreamError(statusCode: number): boolean {
  return statusCode >= 400;
}

export { STRIPPED_HEADERS };
