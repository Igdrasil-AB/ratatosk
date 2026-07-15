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

/** Authentication-bearing headers are never persisted in a Studio capture. */
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;
const SENSITIVE_KEY = /(token|secret|password|passwd|cookie|session|authorization|api[_-]?key|csrf|xsrf)/i;

/** Lower-case header keys and remove every authentication-bearing value. */
export function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!SENSITIVE_HEADER.test(key) && typeof v === "string") out[key] = redactText(v);
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
  const keepBody = isCapturableBody(contentType) && input.body ? sanitizeBody(input.body.slice(0, MAX_BODY_CHARS), contentType) : undefined;
  return {
    url: sanitizeUrl(input.url),
    method: (input.method || "GET").toUpperCase(),
    status: input.status,
    contentType,
    requestBody: input.requestBody ? sanitizeBody(input.requestBody, input.requestHeaders?.["content-type"] ?? "") : undefined,
    requestHeaders: sanitizeHeaders(input.requestHeaders),
    responseBody: keepBody,
  };
}

/** Remove credentials and values from a URL while retaining endpoint structure. */
export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value, "https://invalid.local");
    url.username = "";
    url.password = "";
    url.pathname = url.pathname
      .split("/")
      .map((segment) => (isSensitivePathSegment(segment) ? "REDACTED" : segment))
      .join("/");
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "REDACTED");
    url.hash = "";
    return value.startsWith("http://") || value.startsWith("https://") ? url.toString() : `${url.pathname}${url.search}`;
  } catch {
    return redactText(value);
  }
}

function isSensitivePathSegment(segment: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment)) return true;
  return segment.length >= 24 && /^[A-Za-z0-9._~+=-]+$/.test(segment) && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment);
}

/** Preserve JSON shape for inference while replacing secret-bearing values. */
export function sanitizeBody(value: string, contentType: string): string {
  if (contentType.toLowerCase().includes("json") || /^[\s]*[\[{]/.test(value)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(value)));
    } catch {
      // Fall through to conservative text redaction for malformed JSON.
    }
  }
  return redactText(value);
}

function redactJson(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "REDACTED";
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactJson(v, k)]));
  }
  return typeof value === "string" ? redactText(value) : value;
}

function redactText(value: string): string {
  return value
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{8,}=*/g, "Bearer REDACTED")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "REDACTED_JWT")
    .replace(/\b(?:sk|pk|rk|api)[_-](?:live|test|prod)?[_-]?[A-Za-z0-9_-]{12,}\b/gi, "REDACTED_KEY")
    .replace(/([?&](?:token|key|secret|signature|sig|auth|code)=)[^&#\s"']+/gi, "$1REDACTED");
}
