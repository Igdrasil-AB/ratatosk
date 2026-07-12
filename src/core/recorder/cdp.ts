import type { CapturedEntry } from "./types";

/**
 * Pure helpers shared by both capture backends (the chrome.debugger/CDP backend
 * and the MAIN-world interceptor). Kept platform-free so the "which responses do
 * we keep, and how do we normalize them" logic is unit-testable.
 */

/** Upper bound on a kept body. HTML pages are big; this keeps a session under
 * chrome.storage.session's quota while still holding a page's embedded-JSON blob. */
export const MAX_BODY_CHARS = 1_500_000;

/** Strip parameters and lower-case a content-type header. */
export function normalizeContentType(raw: string | undefined | null): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}

/** JSON bodies carry invoice lists (the best case). */
export function isJsonContentType(contentType: string): boolean {
  return contentType.includes("json");
}

/** HTML bodies carry server-rendered invoices and embedded-JSON hydration blobs. */
export function isHtmlContentType(contentType: string): boolean {
  return contentType.includes("html");
}

/** Any text body worth keeping for inference (JSON or HTML). Binary/JS/CSS is noise. */
export function isCapturableBody(contentType: string): boolean {
  return isJsonContentType(contentType) || isHtmlContentType(contentType);
}

export function isPdfContentType(contentType: string): boolean {
  return contentType.includes("pdf");
}

/** Sensitive/auto-managed headers we never keep: the cookie rides `credentials:
 * include` automatically, so it's never templated — and it's the most sensitive. */
const DROP_HEADERS = new Set(["cookie", "set-cookie"]);

/** Lower-case header keys and drop the cookie, so inference can read auth headers
 * (authorization, x-api-key, …) without hoarding the session cookie. */
export function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!DROP_HEADERS.has(key) && typeof v === "string") out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Build a normalized entry; keeps JSON+HTML bodies (capped), drops binary noise. */
export function buildEntry(input: {
  url: string;
  method: string;
  status: number;
  contentType: string | undefined | null;
  body?: string;
  requestBody?: string;
  requestHeaders?: Record<string, string>;
}): CapturedEntry {
  const contentType = normalizeContentType(input.contentType);
  const keepBody = isCapturableBody(contentType) && input.body ? input.body.slice(0, MAX_BODY_CHARS) : undefined;
  return {
    url: input.url,
    method: (input.method || "GET").toUpperCase(),
    status: input.status,
    contentType,
    requestBody: input.requestBody || undefined,
    requestHeaders: sanitizeHeaders(input.requestHeaders),
    responseBody: keepBody,
  };
}
