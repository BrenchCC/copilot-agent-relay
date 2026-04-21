interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface Message {
  role: string;
  content: ContentBlock[] | string;
}

interface RequestBody {
  system?: string | Array<{ type: string; text: string }>;
  messages?: Message[];
}

function getSystemText(system: RequestBody["system"]): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function getMessageText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b): b is ContentBlock & { text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function isCompact(body: RequestBody): boolean {
  const systemText = getSystemText(body.system);

  if (systemText.startsWith("You are a helpful AI assistant tasked with summarizing conversations")) {
    return true;
  }

  const messages = body.messages ?? [];
  for (const msg of messages) {
    const text = getMessageText(msg);

    if (text.includes("CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.")) {
      return true;
    }

    if (text.includes("Pending Tasks:") && text.includes("Current Work:")) {
      return true;
    }
  }

  return false;
}

/**
 * Infer the true initiator from the request body shape.
 * Used for audit logging regardless of the force mode.
 */
export function inferInitiator(body: unknown): "user" | "agent" {
  try {
    if (!body || typeof body !== "object") return "user";

    const parsed = body as RequestBody;

    if (isCompact(parsed)) return "agent";

    const messages = parsed.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) return "user";

    const last = messages[messages.length - 1];
    if (!last || last.role !== "user") return "user";

    const content = last.content;
    if (!Array.isArray(content) || content.length === 0) return "user";

    const hasToolResult = content.some((b) => b.type === "tool_result");
    if (hasToolResult) return "agent";

    return "user";
  } catch {
    return "user";
  }
}

/**
 * Determine the final x-initiator value based on mode:
 * - "off": use the inferred initiator as-is
 * - "always": always send "agent"
 * - "session": the first turn of a session → "user", rest → "agent"
 *
 * `firstTurnBySession` is the authoritative signal for session mode
 * when the caller can track sessions by id (e.g. via `metadata.user_id`).
 * When `undefined`/`null`, we fall back to a message-count heuristic:
 * a single `user` message is treated as the first turn.
 */
export function resolveInitiator(
  inferred: "user" | "agent",
  mode: "always" | "session" | "off",
  body: unknown,
  firstTurnBySession?: boolean | null,
): "user" | "agent" {
  if (mode === "off") return inferred;
  if (mode === "always") return "agent";

  // session mode: prefer the session-id-based signal when available
  if (firstTurnBySession === true) return "user";
  if (firstTurnBySession === false) return "agent";

  // fallback heuristic: only the first user message in a conversation is "user"
  if (body && typeof body === "object") {
    const messages = (body as { messages?: unknown[] }).messages;
    if (Array.isArray(messages) && messages.length === 1) {
      const first = messages[0] as { role?: string };
      if (first?.role === "user") return "user";
    }
  }
  return "agent";
}
