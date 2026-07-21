import { buildEntry, isJsonContentType, normalizeContentType } from "../../../src/core/recorder/cdp";
import type { CapturedEntry } from "../../../src/core/recorder/types";
import { restoreSafeStaticQueryValues } from "../../../src/core/discovery-query";

const OBSERVER_KEY = "__ratatoskDiscoveryObserverV1" as const;
const MAX_ENTRIES = 12;
const MAX_BODY_CHARS = 256_000;
const MAX_REQUEST_BODY_CHARS = 65_536;
const MAX_TOTAL_BODY_CHARS = 768_000;
const MAX_OBSERVER_LIFETIME_MS = 45_000;

interface DiscoveryPageObserver {
  snapshot(): Promise<CapturedEntry[]>;
  stop(): void;
}

declare global {
  interface Window {
    __ratatoskDiscoveryObserverV1?: DiscoveryPageObserver;
  }
}

// A dynamic document_start MAIN-world script installs this before the supplier
// SPA executes. It is deliberately ephemeral: bounded sanitized evidence stays
// in page memory and is removed when the discovery run finishes.
if (typeof window !== "undefined" && !window[OBSERVER_KEY]) installObserver();

function installObserver(): void {
  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const entries: CapturedEntry[] = [];
  const pending = new Set<Promise<void>>();
  const xhrState = new WeakMap<XMLHttpRequest, {
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    requestBody?: string;
  }>();
  let totalBodyChars = 0;
  let stopped = false;
  const expiryTimer = setTimeout(() => window[OBSERVER_KEY]?.stop(), MAX_OBSERVER_LIFETIME_MS);

  const queue = (work: () => Promise<void>): void => {
    if (stopped) return;
    const task = Promise.resolve().then(work).catch(() => undefined).finally(() => pending.delete(task));
    pending.add(task);
  };

  const keep = (input: {
    url: string;
    method: string;
    status: number;
    contentType: string;
    body: string;
    requestBody?: string;
    requestHeaders?: Record<string, string>;
  }): void => {
    if (stopped || !isJsonContentType(input.contentType) || !input.body || input.body.length > MAX_BODY_CHARS) return;
    if (input.method !== "GET" && input.method !== "POST") return;
    let url: URL;
    try { url = new URL(input.url, location.href); } catch { return; }
    if (url.protocol !== "https:" || url.username || url.password) return;
    url.username = "";
    url.password = "";
    url.hash = "";
    const entry = buildEntry({
      ...input,
      url: url.toString(),
      body: input.body.slice(0, MAX_BODY_CHARS),
      requestBody: input.requestBody?.slice(0, MAX_REQUEST_BODY_CHARS),
    });
    entry.url = restoreSafeStaticQueryValues(url.toString(), entry.url);
    if (!entry.responseBody || entry.responseBody.length > MAX_BODY_CHARS) return;
    const key = `${entry.method}|${entry.url}|${entry.requestBody ?? ""}`;
    const existing = entries.findIndex((candidate) => `${candidate.method}|${candidate.url}|${candidate.requestBody ?? ""}` === key);
    if (existing >= 0) {
      totalBodyChars -= entries[existing].responseBody?.length ?? 0;
      entries.splice(existing, 1);
    }
    while (entries.length >= MAX_ENTRIES || totalBodyChars + entry.responseBody.length > MAX_TOTAL_BODY_CHARS) {
      const removed = entries.shift();
      if (!removed) return;
      totalBodyChars -= removed.responseBody?.length ?? 0;
    }
    entries.push(entry);
    totalBodyChars += entry.responseBody.length;
  };

  const wrappedFetch: typeof window.fetch = function(this: Window, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = requestHeaders(input, init);
    const requestBody = requestBodyText(input, init, headers["content-type"]);
    const responsePromise = Reflect.apply(originalFetch, this, [input, init]) as Promise<Response>;
    queue(async () => {
      const response = await responsePromise;
      const contentType = normalizeContentType(response.headers.get("content-type"));
      if (!isJsonContentType(contentType)) return;
      const body = await readBoundedResponse(response.clone());
      if (body === undefined) return;
      keep({
        url: response.url || requestUrl,
        method,
        status: response.status,
        contentType,
        body,
        requestBody: await requestBody,
        requestHeaders: headers,
      });
    });
    return responsePromise;
  };

  const wrappedOpen: typeof XMLHttpRequest.prototype.open = function(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    xhrState.set(this, { method: method.toUpperCase(), url: String(url), requestHeaders: {} });
    return Reflect.apply(originalXhrOpen, this, [method, url, async, username, password]);
  } as typeof XMLHttpRequest.prototype.open;

  const wrappedSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader = function(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    const state = xhrState.get(this);
    if (state && name.toLowerCase() === "content-type") state.requestHeaders["content-type"] = normalizeContentType(value);
    return Reflect.apply(originalXhrSetRequestHeader, this, [name, value]);
  };

  const wrappedSend: typeof XMLHttpRequest.prototype.send = function(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const state = xhrState.get(this);
    if (state && typeof body === "string" && body.length <= MAX_REQUEST_BODY_CHARS) state.requestBody = body;
    this.addEventListener("loadend", () => {
      queue(async () => {
        const current = xhrState.get(this);
        if (!current) return;
        const contentType = normalizeContentType(this.getResponseHeader("content-type"));
        if (!isJsonContentType(contentType)) return;
        let responseBody: string | undefined;
        if (this.responseType === "json") responseBody = JSON.stringify(this.response);
        else if (this.responseType === "" || this.responseType === "text") responseBody = this.responseText;
        if (!responseBody || responseBody.length > MAX_BODY_CHARS) return;
        keep({
          url: this.responseURL || current.url,
          method: current.method,
          status: this.status,
          contentType,
          body: responseBody,
          requestBody: current.requestBody,
          requestHeaders: current.requestHeaders,
        });
      });
    }, { once: true });
    return Reflect.apply(originalXhrSend, this, [body]);
  };

  window.fetch = wrappedFetch;
  XMLHttpRequest.prototype.open = wrappedOpen;
  XMLHttpRequest.prototype.send = wrappedSend;
  XMLHttpRequest.prototype.setRequestHeader = wrappedSetRequestHeader;
  window[OBSERVER_KEY] = {
    async snapshot(): Promise<CapturedEntry[]> {
      const current = [...pending];
      if (current.length) {
        await Promise.race([
          Promise.allSettled(current),
          new Promise<void>((resolve) => setTimeout(resolve, 750)),
        ]);
      }
      return entries.map((entry) => structuredClone(entry));
    },
    stop(): void {
      stopped = true;
      clearTimeout(expiryTimer);
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
      if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = originalXhrSend;
      if (XMLHttpRequest.prototype.setRequestHeader === wrappedSetRequestHeader) {
        XMLHttpRequest.prototype.setRequestHeader = originalXhrSetRequestHeader;
      }
      entries.length = 0;
      pending.clear();
      delete window[OBSERVER_KEY];
    },
  };
}

function requestHeaders(input: RequestInfo | URL, init: RequestInit | undefined): Record<string, string> {
  try {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const contentType = normalizeContentType(headers.get("content-type"));
    return contentType ? { "content-type": contentType } : {};
  } catch {
    return {};
  }
}

async function requestBodyText(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  contentType: string | undefined,
): Promise<string | undefined> {
  if (!contentType?.includes("json")) return undefined;
  if (typeof init?.body === "string") return init.body.length <= MAX_REQUEST_BODY_CHARS ? init.body : undefined;
  if (input instanceof Request && init?.body === undefined) {
    try {
      const declared = Number(input.headers.get("content-length") ?? "0");
      if (declared > MAX_REQUEST_BODY_CHARS) return undefined;
      const body = await input.clone().text();
      return body.length <= MAX_REQUEST_BODY_CHARS ? body : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readBoundedResponse(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS) return undefined;
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > MAX_BODY_CHARS) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
