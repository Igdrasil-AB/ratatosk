import type { HttpResponse, RequestSpec } from "./types";
import { render, renderHeaders } from "./template";
import { RateLimited, ResponseTooLarge } from "./errors";

/** Shared ceiling for list pages and PDF materialization in extension memory. */
export const MAX_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RETRY_AFTER_MS = 30_000;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

/**
 * Build the credentialed fetch function the engine expects in its RunContext.
 *
 * This is the ONE place the session-replay trick lives: every request goes out
 * with `credentials: "include"`, so the browser attaches the user's existing
 * cookies for the target host (which the extension has host permission for).
 * To the vendor it is indistinguishable from their own billing page calling.
 *
 * It uses the global `fetch`, which exists in the extension service worker and
 * in Node 18+, so this module stays free of any `chrome.*` dependency.
 */
export function createHttpFetch(): (
  spec: RequestSpec,
  vars: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<HttpResponse> {
  return async (spec, vars, signal) => {
    const url = render(spec.url, vars);
    const res = await fetch(url, {
      method: spec.method ?? "GET",
      headers: renderHeaders(spec.headers, vars),
      body: spec.body ? render(spec.body, vars) : undefined,
      credentials: "include",
      redirect: "follow",
      signal,
    });

    console.info(`[collector] worker ${spec.method ?? "GET"} ${safeOrigin(url)} -> ${res.status}`);

    if (res.status === 429) {
      throw new RateLimited(parseRetryAfter(res.headers.get("retry-after")));
    }

    return {
      status: res.status,
      ok: res.ok,
      url: res.url,
      redirected: res.redirected,
      json: () => res.json(),
      arrayBuffer: (maximumBytes = MAX_HTTP_RESPONSE_BYTES) => readBoundedResponse(res, maximumBytes),
      headers: { get: (name: string) => res.headers.get(name) },
    };
  };
}

/** Parse both RFC-defined Retry-After forms: delay-seconds and HTTP-date.
 * Invalid headers use the conservative fallback; valid past dates mean a
 * retry is immediately eligible, never a negative duration. */
export function parseRetryAfter(
  value: string | null,
  nowMs = Date.now(),
  fallbackMs = DEFAULT_RETRY_AFTER_MS,
): number {
  if (typeof value !== "string") return fallbackMs;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1_000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return fallbackMs;
  return Math.max(0, Math.min(at - nowMs, MAX_RETRY_AFTER_MS));
}

/** Read a Fetch response incrementally so an absent or forged Content-Length
 * cannot make the extension buffer an unbounded response body. */
export async function readBoundedResponse(res: Response, maximumBytes: number): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("invalid response byte limit");
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maximumBytes) throw new ResponseTooLarge(maximumBytes);

  const reader = res.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLarge(maximumBytes);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unknown-origin";
  }
}
