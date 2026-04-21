import { transformAnthropicToCopilotChat, type CopilotRequestTransformResult, isAnthropicMessagesPath } from "./copilot-request";
import { rewriteHeaders } from "./rewriter";

export type UpstreamMode = "passthrough" | "copilot-transform";

export interface UpstreamRequestPlan {
  upstreamMode: UpstreamMode;
  upstreamPath: string;
  upstreamBody: Buffer;
  upstreamHeaders: Record<string, string>;
  droppedFields: string[];
  stream: boolean;
  mappedModel?: string;
}

export interface RequestPlanInput {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  parsedBody: Record<string, unknown> | null;
  apiBase: string;
  copilotToken: string;
  initiator: "user" | "agent";
  requestId: string;
}

export function planUpstreamRequest(input: RequestPlanInput): UpstreamRequestPlan {
  const upstreamMode = shouldUseCopilotTransform(input.url, input.apiBase, input.parsedBody)
    ? "copilot-transform"
    : "passthrough";

  if (upstreamMode === "copilot-transform") {
    const transformed = transformAnthropicToCopilotChat(
      input.url,
      input.parsedBody ?? {},
    );
    return {
      upstreamMode,
      upstreamPath: transformed.path,
      upstreamBody: Buffer.from(JSON.stringify(transformed.body)),
      upstreamHeaders: rewriteHeaders(input.headers, {
        copilotToken: input.copilotToken,
        initiator: input.initiator,
        requestId: input.requestId,
        mode: upstreamMode,
      }),
      droppedFields: transformed.droppedFields,
      stream: transformed.stream,
      mappedModel: transformed.mappedModel,
    };
  }

  return {
    upstreamMode,
    upstreamPath: input.url,
    upstreamBody: input.body,
    upstreamHeaders: rewriteHeaders(input.headers, {
      copilotToken: input.copilotToken,
      initiator: input.initiator,
      requestId: input.requestId,
      mode: upstreamMode,
    }),
    droppedFields: [],
    stream: false,
  };
}

function shouldUseCopilotTransform(
  url: string,
  apiBase: string,
  parsedBody: Record<string, unknown> | null,
): boolean {
  if (!apiBase.includes("githubcopilot.com")) return false;
  if (!parsedBody) return false;
  return isAnthropicMessagesPath(url);
}

export type { CopilotRequestTransformResult };
