// lib/usage-tap.ts
import { Transform } from "node:stream";
import type { UsageTapResult } from "./types";

export type { UsageTapResult };

function emptyResult(): UsageTapResult {
  return { model: "", message_id: "", input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, stop_reason: "" };
}

function createSseTap(): { transform: Transform; getResult: () => UsageTapResult } {
  const result = emptyResult();
  let buffer = "";
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      const text = chunk.toString();
      this.push(chunk);
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine.slice(6));
          if (data.type === "message_start" && data.message) {
            const msg = data.message;
            result.model = msg.model ?? result.model;
            result.message_id = msg.id ?? result.message_id;
            if (msg.usage) {
              result.input_tokens = msg.usage.input_tokens ?? 0;
              result.cache_creation_input_tokens = msg.usage.cache_creation_input_tokens ?? 0;
              result.cache_read_input_tokens = msg.usage.cache_read_input_tokens ?? 0;
            }
          }
          if (data.type === "message_delta") {
            if (data.delta?.stop_reason) result.stop_reason = data.delta.stop_reason;
            if (data.usage?.output_tokens !== undefined) result.output_tokens = data.usage.output_tokens;
            if (data.usage?.input_tokens !== undefined && data.usage.input_tokens > 0) result.input_tokens = data.usage.input_tokens;
          }
        } catch { /* skip */ }
      }
      callback();
    },
  });
  return { transform, getResult: () => result };
}

const MAX_JSON_BUFFER = 1024 * 1024;

function createJsonTap(): { transform: Transform; getResult: () => UsageTapResult } {
  const result = emptyResult();
  const chunks: Buffer[] = [];
  let totalSize = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      this.push(chunk);
      if (totalSize < MAX_JSON_BUFFER) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); totalSize += chunk.length; }
      callback();
    },
    flush(callback) {
      try {
        const body = Buffer.concat(chunks).toString();
        const data = JSON.parse(body);
        result.model = data.model ?? "";
        result.message_id = data.id ?? "";
        result.stop_reason = data.stop_reason ?? "";
        if (data.usage) {
          result.input_tokens = data.usage.input_tokens ?? 0;
          result.output_tokens = data.usage.output_tokens ?? 0;
          result.cache_creation_input_tokens = data.usage.cache_creation_input_tokens ?? 0;
          result.cache_read_input_tokens = data.usage.cache_read_input_tokens ?? 0;
        }
      } catch { /* not JSON */ }
      callback();
    },
  });
  return { transform, getResult: () => result };
}

function createNoopTap(): { transform: Transform; getResult: () => UsageTapResult } {
  const result = emptyResult();
  const transform = new Transform({ transform(chunk, _encoding, callback) { this.push(chunk); callback(); } });
  return { transform, getResult: () => result };
}

export function createUsageTap(contentType: string): { transform: Transform; getResult: () => UsageTapResult } {
  if (contentType.includes("text/event-stream")) return createSseTap();
  if (contentType.includes("application/json")) return createJsonTap();
  return createNoopTap();
}
