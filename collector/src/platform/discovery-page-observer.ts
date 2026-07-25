import { buildEntry, isJsonContentType, normalizeContentType } from "../../../src/core/recorder/cdp";
import type { CapturedEntry } from "../../../src/core/recorder/types";
import { restoreSafeStaticQueryValues } from "../../../src/core/discovery-query";

const OBSERVER_KEY = "__ratatoskDiscoveryObserverV1" as const;
const MAX_ENTRIES = 12;
const MAX_BODY_CHARS = 256_000;
const MAX_REQUEST_BODY_CHARS = 65_536;
const MAX_TOTAL_BODY_CHARS = 768_000;
const MAX_OBSERVER_LIFETIME_MS = 180_000;
const MAX_DOCUMENTS = 100;
const MAX_INLINE_PDF_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_PDF_TOTAL_BYTES = 24 * 1024 * 1024;
const DOCUMENT_HINT = /(?:invoice|receipt|statement|document|download|pdf)/i;
const DOCUMENT_JSON_FIELD = /(?:^|[._-])(?:(?:invoice|receipt|statement|document)[_-]?(?:pdf|url)|pdf[_-]?url|download[_-]?url)$/i;

interface DiscoveryPageObserver {
  snapshot(): Promise<CapturedEntry[]>;
  snapshotDocuments(): Promise<string[]>;
  snapshotActionDocuments(): Promise<string[]>;
  beginDocumentAction(): void;
  endDocumentAction(): void;
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
  const originalCreateObjectURL = URL.createObjectURL;
  const originalWindowOpen = window.open;
  const entries: CapturedEntry[] = [];
  const documents: string[] = [];
  const documentKeys = new Set<string>();
  const actionDocuments: string[] = [];
  const actionDocumentKeys = new Set<string>();
  const pending = new Set<Promise<void>>();
  const xhrState = new WeakMap<XMLHttpRequest, {
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    requestBody?: string;
    actionScopedAtRequestStart?: boolean;
  }>();
  let totalBodyChars = 0;
  let totalInlinePdfBytes = 0;
  let stopped = false;
  let documentActionActive = false;
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

  const keepDocumentUrl = (raw: string, actionScopedAtRequestStart = false): void => {
    if (stopped || documents.length >= MAX_DOCUMENTS || raw.length > 2_048) return;
    let url: URL;
    try { url = new URL(raw, location.href); } catch { return; }
    if (url.protocol !== "https:" || url.username || url.password) return;
    url.hash = "";
    const value = url.toString();
    if (actionScopedAtRequestStart) keepActionDocumentUrl(value);
    if (documentKeys.has(value)) return;
    documentKeys.add(value);
    documents.push(value);
  };

  const keepActionDocumentUrl = (raw: string): void => {
    if (stopped || actionDocuments.length >= MAX_DOCUMENTS || raw.length > 2_048) return;
    let url: URL;
    try { url = new URL(raw, location.href); } catch { return; }
    if (url.protocol !== "https:" || url.username || url.password) return;
    url.hash = "";
    const value = url.toString();
    if (actionDocumentKeys.has(value)) return;
    actionDocumentKeys.add(value);
    actionDocuments.push(value);
  };

  const keepPdfBytes = (bytes: Uint8Array, actionScopedAtRequestStart = false): boolean => {
    if (
      stopped || documents.length >= MAX_DOCUMENTS || bytes.byteLength === 0 ||
      bytes.byteLength > MAX_INLINE_PDF_BYTES ||
      totalInlinePdfBytes + bytes.byteLength > MAX_INLINE_PDF_TOTAL_BYTES ||
      new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
    ) return false;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 32_768)));
    }
    const value = `data:application/pdf;base64,${btoa(binary)}`;
    if (actionScopedAtRequestStart && !actionDocumentKeys.has(value) && actionDocuments.length < MAX_DOCUMENTS) {
      actionDocumentKeys.add(value);
      actionDocuments.push(value);
    }
    if (documentKeys.has(value)) return true;
    documentKeys.add(value);
    documents.push(value);
    totalInlinePdfBytes += bytes.byteLength;
    return true;
  };

  const captureDocumentBlob = async (
    blob: Blob,
    fallbackUrl?: string,
    actionScopedAtRequestStart = false,
  ): Promise<void> => {
    if (blob.size === 0 || blob.size > MAX_INLINE_PDF_BYTES) {
      if (fallbackUrl) keepDocumentUrl(fallbackUrl, actionScopedAtRequestStart);
      return;
    }
    try {
      const captured = keepPdfBytes(new Uint8Array(await blob.arrayBuffer()), actionScopedAtRequestStart);
      if (!captured && fallbackUrl) keepDocumentUrl(fallbackUrl, actionScopedAtRequestStart);
    } catch {
      if (fallbackUrl) keepDocumentUrl(fallbackUrl, actionScopedAtRequestStart);
    }
  };

  const captureJsonDocumentUrls = (body: string, actionScopedAtRequestStart = false): void => {
    let root: unknown;
    try { root = JSON.parse(body); } catch { return; }
    const pendingNodes: Array<{ value: unknown; path: string; depth: number }> = [{ value: root, path: "", depth: 0 }];
    let visited = 0;
    while (pendingNodes.length && visited < 2_000 && documents.length < MAX_DOCUMENTS) {
      const node = pendingNodes.shift()!;
      visited += 1;
      if (node.depth > 8) continue;
      if (typeof node.value === "string") {
        if (node.value.length <= 2_048 && DOCUMENT_JSON_FIELD.test(node.path)) {
          keepDocumentUrl(node.value, actionScopedAtRequestStart);
        }
        continue;
      }
      if (Array.isArray(node.value)) {
        for (const item of node.value.slice(0, 200)) {
          pendingNodes.push({ value: item, path: node.path, depth: node.depth + 1 });
        }
        continue;
      }
      if (node.value && typeof node.value === "object") {
        for (const [key, value] of Object.entries(node.value as Record<string, unknown>).slice(0, 200)) {
          pendingNodes.push({ value, path: `${node.path}.${key}`.slice(-320), depth: node.depth + 1 });
        }
      }
    }
  };

  const wrappedFetch: typeof window.fetch = function(this: Window, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = requestHeaders(input, init);
    const requestBody = requestBodyText(input, init, headers["content-type"]);
    const actionScopedAtRequestStart = documentActionActive;
    const responsePromise = Reflect.apply(originalFetch, this, [input, init]) as Promise<Response>;
    queue(async () => {
      const response = await responsePromise;
      const contentType = normalizeContentType(response.headers.get("content-type"));
      const responseUrl = response.url || requestUrl;
      if (isJsonContentType(contentType)) {
        const body = await readBoundedResponse(response.clone());
        if (body === undefined) return;
        captureJsonDocumentUrls(body, actionScopedAtRequestStart);
        keep({
          url: responseUrl,
          method,
          status: response.status,
          contentType,
          body,
          requestBody: await requestBody,
          requestHeaders: headers,
        });
      } else if (
        contentType === "application/pdf" ||
        (DOCUMENT_HINT.test(responseUrl) && !/(?:json|html|javascript|text\/|image\/)/i.test(contentType))
      ) {
        await captureDocumentBlob(await response.clone().blob(), responseUrl, actionScopedAtRequestStart);
      }
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
    if (state) {
      state.actionScopedAtRequestStart = documentActionActive;
      if (typeof body === "string" && body.length <= MAX_REQUEST_BODY_CHARS) state.requestBody = body;
    }
    this.addEventListener("loadend", () => {
      queue(async () => {
        const current = xhrState.get(this);
        if (!current) return;
        const contentType = normalizeContentType(this.getResponseHeader("content-type"));
        const responseUrl = this.responseURL || current.url;
        if (isJsonContentType(contentType)) {
          let responseBody: string | undefined;
          if (this.responseType === "json") responseBody = JSON.stringify(this.response);
          else if (this.responseType === "" || this.responseType === "text") responseBody = this.responseText;
          if (!responseBody || responseBody.length > MAX_BODY_CHARS) return;
          captureJsonDocumentUrls(responseBody, current.actionScopedAtRequestStart);
          keep({
            url: responseUrl,
            method: current.method,
            status: this.status,
            contentType,
            body: responseBody,
            requestBody: current.requestBody,
            requestHeaders: current.requestHeaders,
          });
        } else if (
          contentType === "application/pdf" ||
          (DOCUMENT_HINT.test(responseUrl) && !/(?:json|html|javascript|text\/|image\/)/i.test(contentType))
        ) {
          if (this.response instanceof Blob) {
            await captureDocumentBlob(this.response, responseUrl, current.actionScopedAtRequestStart);
          }
          else if (this.response instanceof ArrayBuffer) {
            if (!keepPdfBytes(new Uint8Array(this.response), current.actionScopedAtRequestStart)) {
              keepDocumentUrl(responseUrl, current.actionScopedAtRequestStart);
            }
          } else {
            keepDocumentUrl(responseUrl, current.actionScopedAtRequestStart);
          }
        }
      });
    }, { once: true });
    return Reflect.apply(originalXhrSend, this, [body]);
  };

  const wrappedCreateObjectURL: typeof URL.createObjectURL = function(object: Blob | MediaSource): string {
    const value = Reflect.apply(originalCreateObjectURL, URL, [object]) as string;
    const actionScopedAtRequestStart = documentActionActive;
    if (object instanceof Blob && (
      object.type.toLowerCase() === "application/pdf" || DOCUMENT_HINT.test(object.type)
    )) {
      queue(() => captureDocumentBlob(object, undefined, actionScopedAtRequestStart));
    }
    return value;
  };

  const wrappedWindowOpen: typeof window.open = function(
    url?: string | URL,
    target?: string,
    features?: string,
  ): WindowProxy | null {
    if (documentActionActive && url) {
      // A verified invoice control may produce a signed document URL through a
      // popup. Retain it for the extension transport and suppress the browser
      // window so Chrome's popup blocker is never part of invoice collection.
      keepActionDocumentUrl(String(url));
      return null;
    }
    return Reflect.apply(originalWindowOpen, window, [url, target, features]) as WindowProxy | null;
  } as typeof window.open;

  window.fetch = wrappedFetch;
  XMLHttpRequest.prototype.open = wrappedOpen;
  XMLHttpRequest.prototype.send = wrappedSend;
  XMLHttpRequest.prototype.setRequestHeader = wrappedSetRequestHeader;
  URL.createObjectURL = wrappedCreateObjectURL;
  window.open = wrappedWindowOpen;
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
    async snapshotDocuments(): Promise<string[]> {
      const current = [...pending];
      if (current.length) {
        await Promise.race([
          Promise.allSettled(current),
          new Promise<void>((resolve) => setTimeout(resolve, 750)),
        ]);
      }
      return [...documents];
    },
    async snapshotActionDocuments(): Promise<string[]> {
      const current = [...pending];
      if (current.length) {
        await Promise.race([
          Promise.allSettled(current),
          new Promise<void>((resolve) => setTimeout(resolve, 750)),
        ]);
      }
      return [...actionDocuments];
    },
    beginDocumentAction(): void {
      if (!stopped) {
        actionDocuments.length = 0;
        actionDocumentKeys.clear();
        documentActionActive = true;
      }
    },
    endDocumentAction(): void {
      documentActionActive = false;
    },
    stop(): void {
      stopped = true;
      documentActionActive = false;
      clearTimeout(expiryTimer);
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
      if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = originalXhrSend;
      if (XMLHttpRequest.prototype.setRequestHeader === wrappedSetRequestHeader) {
        XMLHttpRequest.prototype.setRequestHeader = originalXhrSetRequestHeader;
      }
      if (URL.createObjectURL === wrappedCreateObjectURL) URL.createObjectURL = originalCreateObjectURL;
      if (window.open === wrappedWindowOpen) window.open = originalWindowOpen;
      entries.length = 0;
      documents.length = 0;
      documentKeys.clear();
      actionDocuments.length = 0;
      actionDocumentKeys.clear();
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
