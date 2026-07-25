import type { HttpResponse, RequestSpec, VendorRecipe } from "../../../src/core/types";
import { UnexpectedResponse } from "../../../src/core/errors";
import { createHttpFetch } from "../../../src/core/http";
import { render, renderHeaders } from "../../../src/core/template";
import { createDocumentProviderFetch } from "./document-provider-fetch";
import { createSemanticDocumentFetch } from "./semantic-document-fetch";

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
  linkHeader?: string | null;
  finalUrl?: string;
  redirected?: boolean;
  /** Response body, base64-encoded (the executeScript boundary is JSON-only). */
  base64: string;
  error?: string;
}

const MAX_PAGE_RESPONSE_BYTES = 33_554_432;
const MAX_PAGE_BASE64_LENGTH = Math.ceil(MAX_PAGE_RESPONSE_BYTES / 3) * 4;
type PageFetchStage = "tab" | "injection" | "result" | "redirect" | "decode";

/** Closed, privacy-safe detail for extension diagnostics and error logs. */
export function pageFetchFailureLabel(stage: PageFetchStage, error: unknown): string {
  return `${stage} (${error instanceof Error ? error.name || "Error" : "non-error"})`;
}

/**
 * Injected into the MAIN world of the vendor tab. MUST be fully self-contained —
 * no imports, no closure references — because Chrome serializes it via
 * `Function.prototype.toString`. Uses only page globals.
 */
export async function pageFetchInPage(req: PageRequest): Promise<PageFetchResult> {
  try {
    const res = await fetch(req.url, {
      method: req.method || "GET",
      headers: req.headers,
      body: req.body,
      credentials: "include",
      // Page-mode is confined to the recipe's primary origin. Secondary
      // origins use the worker transport and its independent permission checks.
      redirect: "error",
    });
    const contentType = res.headers.get("content-type");
    const rawLink = res.headers.get("link");
    const metadata = {
      finalUrl: res.url,
      redirected: res.redirected,
      linkHeader: rawLink && rawLink.length <= 4_096 ? rawLink : null,
    };
    const declared = Number(res.headers.get("content-length") ?? "0");
    const MAX_BYTES = 33_554_432;
    if (declared > MAX_BYTES) {
      return { ok: false, status: res.status, contentType, ...metadata, base64: "", error: "response too large" };
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > MAX_BYTES) {
          await reader.cancel();
          return { ok: false, status: res.status, contentType, ...metadata, base64: "", error: "response too large" };
        }
        chunks.push(next.value);
      }
    }
    const bytes = new Uint8Array(length);
    let byteOffset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, byteOffset);
      byteOffset += chunk.length;
    }
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return {
      ok: res.ok,
      status: res.status,
      contentType,
      ...metadata,
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

export function parsePageFetchResult(value: unknown): PageFetchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid page fetch result");
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.ok !== "boolean" || !Number.isInteger(raw.status) || Number(raw.status) < 0 || Number(raw.status) > 599 ||
    (raw.contentType !== null && raw.contentType !== undefined && (typeof raw.contentType !== "string" || raw.contentType.length > 256)) ||
    typeof raw.base64 !== "string"
  ) throw new Error("invalid page fetch result");
  if (raw.base64.length > MAX_PAGE_BASE64_LENGTH) throw new Error("page fetch result is too large");
  if (raw.base64 && (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw.base64) || raw.base64.length % 4 !== 0)) {
    throw new Error("page fetch result has invalid base64");
  }
  if (raw.linkHeader !== undefined && raw.linkHeader !== null && (typeof raw.linkHeader !== "string" || raw.linkHeader.length > 4_096)) {
    throw new Error("invalid page fetch result");
  }
  if (raw.finalUrl !== undefined) {
    if (typeof raw.finalUrl !== "string" || raw.finalUrl.length > 2_048) throw new Error("invalid page fetch result");
    const url = new URL(raw.finalUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid page fetch result");
  }
  if (raw.redirected !== undefined && typeof raw.redirected !== "boolean") throw new Error("invalid page fetch result");
  if (raw.error !== undefined && (typeof raw.error !== "string" || raw.error.length > 256)) throw new Error("invalid page fetch result");
  return {
    ok: raw.ok,
    status: Number(raw.status),
    contentType: typeof raw.contentType === "string" ? raw.contentType : null,
    linkHeader: typeof raw.linkHeader === "string" ? raw.linkHeader : null,
    finalUrl: typeof raw.finalUrl === "string" ? raw.finalUrl : undefined,
    redirected: typeof raw.redirected === "boolean" ? raw.redirected : undefined,
    base64: raw.base64,
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

export function decodePageResult(value: PageFetchResult): HttpResponse {
  const r = parsePageFetchResult(value);
  const toBytes = (): ArrayBuffer => {
    const bin = atob(r.base64 || "");
    if (bin.length > MAX_PAGE_RESPONSE_BYTES) throw new Error("page fetch result is too large");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  return {
    status: r.status,
    ok: r.ok,
    url: r.finalUrl,
    redirected: r.redirected,
    json: async () => JSON.parse(new TextDecoder().decode(toBytes())),
    arrayBuffer: async () => toBytes(),
    headers: {
      get: (name) => {
        const normalized = name.toLowerCase();
        if (normalized === "content-type") return r.contentType;
        if (normalized === "link") return r.linkHeader ?? null;
        return null;
      },
    },
  };
}

// ---- the transport --------------------------------------------------------

export class PageFetcher {
  private readonly primaryOrigin: string;
  private readonly preferredPageUrl: string;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly vendorId: string;
  private readonly workerFetch;
  private readonly tabs = new Map<string, { tabId: number; created: boolean }>();
  private readonly tabAcquisitions = new Map<string, Promise<number>>();

  constructor(recipe: VendorRecipe, options: { semanticActionDocuments?: boolean } = {}) {
    this.vendorId = recipe.id;
    this.primaryOrigin = originOf(recipe.homepage) ?? originOf(recipe.hosts[0]) ?? "";
    const recipePage = recipe.invoices.strategy === "dom"
      ? recipe.invoices.list.open
      : recipe.auth.check.request.url;
    this.preferredPageUrl = isPrimaryOrigin(this.primaryOrigin, recipePage) ? recipePage : this.primaryOrigin;
    this.allowedOrigins = new Set(recipe.hosts.flatMap((host) => {
      const origin = originOf(host.endsWith("/*") ? host.slice(0, -2) : host);
      return origin ? [origin] : [];
    }));
    const providerFetch = createDocumentProviderFetch(createHttpFetch());
    this.workerFetch = options.semanticActionDocuments
      ? createSemanticDocumentFetch(providerFetch, this.allowedOrigins, this.vendorId)
      : providerFetch;
  }

  /** Matches the `RunContext.fetch` signature the engine expects. */
  fetch = async (spec: RequestSpec, vars: Record<string, unknown>): Promise<HttpResponse> => {
    const url = render(spec.url, vars);
    const targetOrigin = originOf(url);
    if (!targetOrigin || !this.allowedOrigins.has(targetOrigin)) {
      throw new Error("request targets an origin outside the supplier permission set");
    }

    if (targetOrigin !== this.primaryOrigin) {
      return this.workerFetch(spec, vars); // createHttpFetch already logs the status
    }

    const req: PageRequest = {
      url,
      method: spec.method,
      headers: renderHeaders(spec.headers, vars),
      body: spec.body ? render(spec.body, vars) : undefined,
    };
    let stage: PageFetchStage = "tab";
    try {
      const tabId = await this.ensureTab(this.primaryOrigin);
      stage = "injection";
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: pageFetchInPage,
        args: [req],
      });
      stage = "result";
      const result = parsePageFetchResult(injection?.result);
      stage = "redirect";
      if (result.finalUrl && new URL(result.finalUrl).origin !== this.primaryOrigin) {
        throw new Error("page fetch redirected outside the primary supplier origin");
      }
      console.info(
        `[collector] page ${spec.method ?? "GET"} ${this.primaryOrigin} (tab ${tabId}) -> ${result.status}`,
      );
      stage = "decode";
      return decodePageResult(result);
    } catch (error) {
      const detail = pageFetchFailureLabel(stage, error);
      console.error(`[collector] page-fetch failed for ${this.primaryOrigin} at ${detail}`);
      if (error instanceof UnexpectedResponse) throw error;
      throw new UnexpectedResponse(0, `page fetch failed during ${stage}`, this.vendorId);
    }
  };

  /** Close any tabs this fetcher opened (leaves pre-existing tabs alone). */
  async dispose(): Promise<void> {
    await Promise.allSettled(this.tabAcquisitions.values());
    for (const { tabId, created } of this.tabs.values()) {
      if (created) await chrome.tabs.remove(tabId).catch(() => undefined);
    }
    this.tabs.clear();
    this.tabAcquisitions.clear();
  }

  private async ensureTab(origin: string): Promise<number> {
    const cached = this.tabs.get(origin);
    if (cached) return cached.tabId;
    const pending = this.tabAcquisitions.get(origin);
    if (pending) return pending;

    const acquisition = this.acquireTab(origin);
    this.tabAcquisitions.set(origin, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.tabAcquisitions.get(origin) === acquisition) this.tabAcquisitions.delete(origin);
    }
  }

  private async acquireTab(origin: string): Promise<number> {
    const existing = await chrome.tabs.query({ url: `${origin}/*` });
    const reusable = selectReusablePageTab(existing, this.preferredPageUrl);
    if (reusable?.id != null) {
      this.tabs.set(origin, { tabId: reusable.id, created: false });
      return reusable.id;
    }

    const tab = await chrome.tabs.create({ url: this.preferredPageUrl, active: false });
    if (tab.id == null) throw new Error(`could not open a background tab for ${origin}`);
    this.tabs.set(origin, { tabId: tab.id, created: true });
    try {
      await waitForTabComplete(tab.id);
      return tab.id;
    } catch (error) {
      if (this.tabs.get(origin)?.tabId === tab.id) this.tabs.delete(origin);
      await chrome.tabs.remove(tab.id).catch(() => undefined);
      throw error;
    }
  }
}

type ReusablePageTab = Pick<chrome.tabs.Tab, "active" | "discarded" | "id" | "status" | "url">;

/**
 * Select only the fully loaded exact page that supplied the recipe. Origin-only
 * selection can accidentally choose a PDF viewer or a Memory Saver tab when the
 * user has several supplier tabs.
 */
export function selectReusablePageTab(
  tabs: readonly ReusablePageTab[],
  preferredPageUrl: string,
): ReusablePageTab | undefined {
  const preferred = pageIdentity(preferredPageUrl);
  const usable = tabs.filter((tab): tab is ReusablePageTab & { id: number; url: string } =>
    typeof tab.id === "number" && typeof tab.url === "string" &&
    tab.status === "complete" && tab.discarded !== true);
  return usable.find((tab) => pageIdentity(tab.url) === preferred);
}

function pageIdentity(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return undefined;
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
