// lib/upstream.ts
import * as http from "node:http";
import * as https from "node:https";
import type { Readable } from "node:stream";

const HOP_BY_HOP = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailers","transfer-encoding","upgrade"]);

export interface ForwardOptions {
  method: string; path: string; headers: Record<string, string>;
  body: Buffer; apiBase: string; timeoutMs: number;
}

export interface ForwardResult {
  statusCode: number; headers: Record<string, string>; body: Readable;
}

function filterHopByHop(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) {
      result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return result;
}

export function forwardRequest(opts: ForwardOptions): Promise<ForwardResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.path, opts.apiBase);
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request({
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search, method: opts.method,
      headers: { ...opts.headers, "content-length": String(opts.body.length) },
      timeout: opts.timeoutMs,
    }, (res) => {
      resolve({
        statusCode: res.statusCode ?? 502,
        headers: filterHopByHop(res.headers as Record<string, string | string[] | undefined>),
        body: res,
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("Upstream request timed out")); });
    req.end(opts.body);
  });
}
