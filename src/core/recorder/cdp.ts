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

const SENSITIVE_KEY = /(token|secret|password|passwd|cookie|session|authorization|api[_-]?key|csrf|xsrf)/i;
const SAFE_HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CUSTOM_AUTH_HEADER = /(?:^|[-])(auth|token|key|secret|session|csrf|xsrf)(?:[-]|$)/;
const MAX_HEADER_COUNT = 100;
const MAX_HEADER_VALUE_CHARS = 8_192;
const MAX_REDACTED_PATHS = 40;
const MAX_REDACTED_PATH_CHARS = 300;

type RawHeaders = Record<string, unknown> | undefined;
type RequestAuth = CapturedEntry["requestAuth"];
interface SanitizedBody {
  value: string;
  redactedPaths: string[];
}

/** Retain only explicitly reviewed, non-sensitive header values. */
export function sanitizeHeaders(headers: RawHeaders): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers).slice(0, MAX_HEADER_COUNT)) {
    const key = rawKey.toLowerCase();
    if (key !== "content-type" || typeof rawValue !== "string" || rawValue.length > MAX_HEADER_VALUE_CHARS) continue;
    const contentType = normalizeContentType(rawValue);
    if (/^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(contentType)) {
      out[key] = contentType;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Reduce raw request headers to one bounded structural authentication marker. */
export function detectRequestAuth(headers: RawHeaders): RequestAuth {
  if (!headers) return { scheme: "none" };
  let customHeader: string | undefined;
  for (const [rawKey, rawValue] of Object.entries(headers).slice(0, MAX_HEADER_COUNT)) {
    const key = rawKey.toLowerCase();
    if (!SAFE_HEADER_NAME.test(key)) continue;
    const value = typeof rawValue === "string" ? rawValue.slice(0, MAX_HEADER_VALUE_CHARS) : "";
    if (key === "authorization" || key === "proxy-authorization") {
      if (/^bearer(?:\s|$)/i.test(value)) return { scheme: "bearer", headerName: key };
      if (/^basic(?:\s|$)/i.test(value)) return { scheme: "basic", headerName: key };
      customHeader ??= key;
    } else if (key === "cookie" || key === "set-cookie" || CUSTOM_AUTH_HEADER.test(key) || key.startsWith("x-")) {
      customHeader ??= key;
    }
  }
  return customHeader ? { scheme: "custom", headerName: customHeader } : { scheme: "none" };
}

/** Build a normalized entry; keeps JSON+HTML bodies (capped), drops binary noise. */
export function buildEntry(input: {
  url: string;
  method: string;
  status: number;
  contentType: string | undefined | null;
  body?: string;
  requestBody?: string;
  requestHeaders?: RawHeaders;
}): CapturedEntry {
  const contentType = normalizeContentType(input.contentType);
  const response = isCapturableBody(contentType) && input.body
    ? sanitizeBodyWithMetadata(input.body.slice(0, MAX_BODY_CHARS), contentType)
    : undefined;
  const requestContentType = headerValue(input.requestHeaders, "content-type") ?? "";
  const request = input.requestBody ? sanitizeBodyWithMetadata(input.requestBody.slice(0, MAX_BODY_CHARS), requestContentType) : undefined;
  return {
    url: sanitizeUrl(input.url),
    method: (input.method || "GET").toUpperCase(),
    status: input.status,
    contentType,
    requestBody: request?.value,
    requestHeaders: sanitizeHeaders(input.requestHeaders),
    requestAuth: detectRequestAuth(input.requestHeaders),
    ...(request?.redactedPaths.length ? { redactedRequestPaths: request.redactedPaths } : {}),
    ...(response?.redactedPaths.length ? { redactedResponsePaths: response.redactedPaths } : {}),
    responseBody: response?.value,
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
  return sanitizeBodyWithMetadata(value, contentType).value;
}

function sanitizeBodyWithMetadata(value: string, contentType: string): SanitizedBody {
  if (contentType.toLowerCase().includes("json") || /^[\s]*[\[{]/.test(value)) {
    try {
      const redactedPaths: string[] = [];
      return { value: JSON.stringify(redactJson(JSON.parse(value), undefined, "", redactedPaths)), redactedPaths };
    } catch {
      // Fall through to conservative text redaction for malformed JSON.
    }
  }
  return { value: redactText(value), redactedPaths: [] };
}

function redactJson(value: unknown, key: string | undefined, path: string, redactedPaths: string[]): unknown {
  if (key && SENSITIVE_KEY.test(key)) {
    if (isSafeRedactedPath(path) && redactedPaths.length < MAX_REDACTED_PATHS) redactedPaths.push(path);
    return "REDACTED";
  }
  if (Array.isArray(value)) return value.map((item, index) => redactJson(item, undefined, joinPath(path, String(index)), redactedPaths));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      redactJson(v, k, joinPath(path, k), redactedPaths),
    ]));
  }
  return typeof value === "string" ? redactText(value) : value;
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function isSafeRedactedPath(path: string): boolean {
  return path.length <= MAX_REDACTED_PATH_CHARS && path.split(".").every((part) => /^[A-Za-z0-9_$-]+$/.test(part));
}

function headerValue(headers: RawHeaders, wanted: string): string | undefined {
  if (!headers) return undefined;
  const found = Object.entries(headers).slice(0, MAX_HEADER_COUNT).find(([key]) => key.toLowerCase() === wanted);
  return found && typeof found[1] === "string" && found[1].length <= MAX_HEADER_VALUE_CHARS ? found[1] : undefined;
}

function redactText(value: string): string {
  return value
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{8,}=*/g, "Bearer REDACTED")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "REDACTED_JWT")
    .replace(/\b(?:sk|pk|rk|api)[_-](?:live|test|prod)?[_-]?[A-Za-z0-9_-]{12,}\b/gi, "REDACTED_KEY")
    .replace(/([?&](?:token|key|secret|signature|sig|auth|code)=)[^&#\s"']+/gi, "$1REDACTED");
}
