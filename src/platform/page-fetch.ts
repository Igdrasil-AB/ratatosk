import type { HttpResponse, RequestSpec, VendorRecipe } from "../core/types";
import { createHttpFetch } from "../core/http";
import { render, renderHeaders } from "../core/template";

/**
 * First-party fetch transport.
 *
 * Some origins (e.g. claude.ai behind Cloudflare) reject a cross-origin fetch
 * from the extension service worker — the request lacks the first-party context
 * and bot-clearance the real page has. This transport runs the fetch *inside the
 * vendor's own page* (MAIN world of a tab on that origin) via
 * `chrome.scripting.executeScript`, so it is indistinguishable from the site
 * calling its own API.
 *
 * Only the recipe's PRIMARY origin is routed through the page; every other origin
 * (e.g. a Stripe PDF capability URL) uses the worker fetch, which reads
 * cross-origin fine thanks to host permissions. The engine is unaware of any of
 * this — it just receives an `HttpResponse`.
 *
 * SECURITY. The injected code runs in the page's MAIN world, which the page can
 * observe and tamper with. Two invariants keep that safe:
 *   1. We only inject for the recipe's PRIMARY origin, and any auth header we
 *      send (e.g. a bearer minted from the page's OWN session) already belongs to
 *      that origin — so exposing it to that origin's MAIN world is not an
 *      escalation. We never route another origin's request (or its token)
 *      through the page.
 *   2. The value returned across the executeScript boundary is UNTRUSTED input —
 *      the engine parses it as ordinary data (validated by the recipe/schema),
 *      never as code — and its size is capped so a hostile page can't return a
 *      giant body.
 */

type PageRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export interface PageFetchResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  /** Response body, base64-encoded (the executeScript boundary is JSON-only). */
  base64: string;
  error?: string;
}

/**
 * Injected into the MAIN world of the vendor tab. MUST be fully self-contained —
 * no imports, no closure references — because Chrome serializes it via
 * `Function.prototype.toString`. Uses only page globals.
 */
async function pageFetchInPage(req: PageRequest): Promise<PageFetchResult> {
  try {
    const res = await fetch(req.url, {
      method: req.method || "GET",
      headers: req.headers,
      body: req.body,
      credentials: "include",
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Invoices and JSON are small; cap a hostile/oversized body (32 MB).
    if (bytes.length > 33_554_432) {
      return { ok: false, status: res.status, contentType: null, base64: "", error: "response too large" };
    }
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type"),
      base64: btoa(binary),
    };
  } catch (e) {
    return { ok: false, status: 0, contentType: null, base64: "", error: String(e) };
  }
}

// ---- pure helpers (unit-tested) -------------------------------------------

export function isPrimaryOrigin(primaryOrigin: string, url: string): boolean {
  try {
    return new URL(url).origin === primaryOrigin;
  } catch {
    return false;
  }
}

export function decodePageResult(r: PageFetchResult): HttpResponse {
  const toBytes = (): ArrayBuffer => {
    const bin = atob(r.base64 || "");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  return {
    status: r.status,
    ok: r.ok,
    json: async () => JSON.parse(new TextDecoder().decode(toBytes())),
    arrayBuffer: async () => toBytes(),
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? r.contentType : null) },
  };
}

// ---- the transport --------------------------------------------------------

export class PageFetcher {
  private readonly primaryOrigin: string;
  private readonly workerFetch = createHttpFetch();
  private readonly tabs = new Map<string, { tabId: number; created: boolean }>();

  constructor(recipe: VendorRecipe) {
    this.primaryOrigin = originOf(recipe.homepage) ?? originOf(recipe.hosts[0]) ?? "";
  }

  /** Matches the `RunContext.fetch` signature the engine expects. */
  fetch = async (spec: RequestSpec, vars: Record<string, unknown>): Promise<HttpResponse> => {
    const url = render(spec.url, vars);

    if (!isPrimaryOrigin(this.primaryOrigin, url)) {
      return this.workerFetch(spec, vars); // createHttpFetch already logs the status
    }

    const req: PageRequest = {
      url,
      method: spec.method,
      headers: renderHeaders(spec.headers, vars),
      body: spec.body ? render(spec.body, vars) : undefined,
    };
    try {
      const tabId = await this.ensureTab(this.primaryOrigin);
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: pageFetchInPage,
        args: [req],
      });
      const result = injection?.result as PageFetchResult | undefined;
      if (!result) throw new Error("executeScript returned no result (page injection failed)");
      console.info(
        `[collector] page ${spec.method ?? "GET"} ${url} (tab ${tabId}) -> ${result.status}` +
          (result.error ? ` error=${result.error}` : ""),
      );
      return decodePageResult(result);
    } catch (e) {
      console.error(`[collector] page-fetch FAILED for ${url}:`, e);
      throw e;
    }
  };

  /** Close any tabs this fetcher opened (leaves pre-existing tabs alone). */
  async dispose(): Promise<void> {
    for (const { tabId, created } of this.tabs.values()) {
      if (created) await chrome.tabs.remove(tabId).catch(() => undefined);
    }
    this.tabs.clear();
  }

  private async ensureTab(origin: string): Promise<number> {
    const cached = this.tabs.get(origin);
    if (cached) return cached.tabId;

    const existing = await chrome.tabs.query({ url: `${origin}/*` });
    const reusable = existing.find((t) => typeof t.id === "number");
    if (reusable?.id != null) {
      this.tabs.set(origin, { tabId: reusable.id, created: false });
      return reusable.id;
    }

    const tab = await chrome.tabs.create({ url: origin, active: false });
    if (tab.id == null) throw new Error(`could not open a background tab for ${origin}`);
    await waitForTabComplete(tab.id);
    this.tabs.set(origin, { tabId: tab.id, created: true });
    return tab.id;
  }
}

function originOf(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

function waitForTabComplete(tabId: number, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => done(new Error(`tab ${tabId} load timed out`)), timeoutMs);
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === "complete") done();
      })
      .catch(() => undefined);
  });
}
