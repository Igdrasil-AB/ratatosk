import type { HttpResponse, RequestSpec } from "./types";
import { render, renderHeaders } from "./template";
import { RateLimited } from "./errors";

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
) => Promise<HttpResponse> {
  return async (spec, vars) => {
    const url = render(spec.url, vars);
    const res = await fetch(url, {
      method: spec.method ?? "GET",
      headers: renderHeaders(spec.headers, vars),
      body: spec.body ? render(spec.body, vars) : undefined,
      credentials: "include",
      redirect: "follow",
    });

    console.info(`[collector] worker ${spec.method ?? "GET"} ${safeOrigin(url)} -> ${res.status}`);

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "");
      throw new RateLimited(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000);
    }

    return {
      status: res.status,
      ok: res.ok,
      json: () => res.json(),
      arrayBuffer: () => res.arrayBuffer(),
      headers: { get: (name: string) => res.headers.get(name) },
    };
  };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unknown-origin";
  }
}
