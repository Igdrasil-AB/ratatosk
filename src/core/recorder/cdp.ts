import type { CapturedEntry } from "./types";
import { isPaymentSensitiveKey, isPaymentSensitiveValue } from "./payment-sensitive";

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

const SENSITIVE_KEY = /(token|secret|password|passwd|passcode|credential|private[_-]?key|cookie|session|authorization|api[_-]?key|csrf|xsrf)/i;
const PII_KEY = /(?:^|_)(?:email|name|recipient|address|phone|vat|tax|ssn|personnummer|customer)(?:_|$)/i;
const NON_PII_STRUCTURAL_NAME_KEYS = new Set(["operation_name", "file_name", "filename"]);
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
  valueAliases: Array<{ path: string; alias: string }>;
}

type CapturedBodyKind = "request" | "response";

/**
 * A short-lived, in-memory correlation table for one capture session. Its
 * aliases are opaque ordinals, never hashes or derivatives of a captured
 * value, so an entry can safely be persisted while related request/response
 * shapes remain inferable. Deliberately do not persist this map: a worker
 * restart may lose future correlation, but cannot make stored aliases
 * reversible.
 */
export interface CaptureRedactionContext {
  alias(value: string): string;
}

export function createCaptureRedactionContext(): CaptureRedactionContext {
  const aliases = new Map<string, string>();
  return {
    alias(value: string): string {
      const existing = aliases.get(value);
      if (existing) return existing;
      const next = `ref_${aliases.size + 1}`;
      aliases.set(value, next);
      return next;
    },
  };
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
  redactionContext?: CaptureRedactionContext;
}): CapturedEntry {
  const contentType = normalizeContentType(input.contentType);
  const response = isCapturableBody(contentType) && input.body
    ? sanitizeBodyWithMetadata(input.body, contentType, input.redactionContext, "response")
    : undefined;
  const requestContentType = headerValue(input.requestHeaders, "content-type") ?? "";
  const request = input.requestBody ? sanitizeBodyWithMetadata(input.requestBody, requestContentType, input.redactionContext, "request") : undefined;
  const sanitizedUrl = sanitizeUrlWithAliases(input.url, input.redactionContext);
  return {
    url: sanitizedUrl.value,
    method: (input.method || "GET").toUpperCase(),
    status: input.status,
    contentType,
    requestBody: request?.value,
    requestHeaders: sanitizeHeaders(input.requestHeaders),
    requestAuth: detectRequestAuth(input.requestHeaders),
    ...(request?.redactedPaths.length ? { redactedRequestPaths: request.redactedPaths } : {}),
    ...(response?.redactedPaths.length ? { redactedResponsePaths: response.redactedPaths } : {}),
    ...(sanitizedUrl.aliases.length ? { urlValueAliases: sanitizedUrl.aliases } : {}),
    ...(response?.valueAliases.length ? { responseValueAliases: response.valueAliases } : {}),
    responseBody: response?.value,
  };
}

/** Remove credentials and values from a URL while retaining endpoint structure. */
export function sanitizeUrl(value: string): string {
  return sanitizeUrlWithAliases(value).value;
}

function sanitizeUrlWithAliases(
  value: string,
  context?: CaptureRedactionContext,
): { value: string; aliases: NonNullable<CapturedEntry["urlValueAliases"]> } {
  const aliases: NonNullable<CapturedEntry["urlValueAliases"]> = [];
  try {
    const url = new URL(value, "https://invalid.local");
    url.username = "";
    url.password = "";
    const pathSegments = url.pathname.split("/");
    url.pathname = pathSegments.map((segment, pathIndex) => {
      const decoded = decodeCaptureComponent(segment);
      const parent = decodeCaptureComponent(pathSegments[pathIndex - 1] ?? "");
      if (!isSensitivePathSegment(decoded) && !isPersonalPathSegment(parent, decoded)) return segment;
      if (context) {
        const alias = context.alias(decoded);
        aliases.push({ location: "path", pathIndex, alias });
        return opaqueUrlAlias(alias);
      }
      return "REDACTED";
    }).join("/");
    for (const [key, rawValue] of url.searchParams) {
      if (isSafeStaticQuery(key, rawValue)) continue;
      if (context && isOpaqueIdentifier(rawValue)) {
        const alias = context.alias(rawValue);
        aliases.push({ location: "query", key, alias });
        url.searchParams.set(key, opaqueUrlAlias(alias));
        continue;
      }
      url.searchParams.set(key, "REDACTED");
    }
    url.hash = "";
    return { value: value.startsWith("http://") || value.startsWith("https://") ? url.toString() : `${url.pathname}${url.search}`, aliases };
  } catch {
    return { value: redactText(value), aliases };
  }
}

function opaqueUrlAlias(alias: string): string {
  return `__ratatosk_${alias}__`;
}

function isSensitivePathSegment(segment: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment)) return true;
  return segment.length >= 24 && /^[A-Za-z0-9._~+=-]+$/.test(segment) && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment);
}

/** A human-readable segment immediately beneath a person/customer collection
 * is data, not route structure (e.g. `/customers/alice-smith/receipts`). */
function isPersonalPathSegment(parent: string | undefined, segment: string): boolean {
  if (!parent || !/^(?:customers?|users?|members?|contacts?|people|recipients?)$/i.test(parent)) return false;
  return EMAIL_VALUE.test(segment) || (/^[A-Za-z][A-Za-z.'-]{1,63}$/.test(segment) && /[A-Za-z]/.test(segment));
}

function decodeCaptureComponent(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

const SAFE_STATIC_QUERY_KEYS = new Set(["limit", "offset", "page", "per_page", "page_size", "sort", "order", "status", "type", "include", "include_archived"]);
const SAFE_STATIC_QUERY_VALUE = /^(?:\d{1,4}|true|false|[a-z][a-z0-9_-]{0,31})$/i;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_IDENTIFIER_VALUE = /^[A-Za-z0-9_-]{16,}$/;

function isSafeStaticQuery(key: string, value: string): boolean {
  return SAFE_STATIC_QUERY_KEYS.has(key.toLowerCase()) && SAFE_STATIC_QUERY_VALUE.test(value);
}

function isOpaqueIdentifier(value: string): boolean {
  return UUID_VALUE.test(value) || /^\d{6,}$/.test(value) || LONG_IDENTIFIER_VALUE.test(value);
}

function isIdentifierField(key: string | undefined): boolean {
  return Boolean(key && /(?:^id$|_id$|(?:account|team|workspace|organization|org|tenant|customer)[_-]?id$)/i.test(key));
}

/** Preserve JSON shape for inference while replacing secret-bearing values. */
export function sanitizeBody(value: string, contentType: string): string {
  return sanitizeBodyWithMetadata(value, contentType).value;
}

function sanitizeBodyWithMetadata(
  value: string,
  contentType: string,
  context?: CaptureRedactionContext,
  kind: CapturedBodyKind = "response",
): SanitizedBody {
  // Never persist a prefix of a structured body. A truncated JSON fragment no
  // longer has key/value boundaries, so key-aware redaction cannot prove that a
  // credential near the prefix is safe. The bounded marker retains diagnostic
  // truth without retaining supplier/account data.
  if (value.length > MAX_BODY_CHARS) {
    return { value: '{"__ratatosk_truncated__":true}', redactedPaths: [], valueAliases: [] };
  }
  const normalizedContentType = contentType.toLowerCase();
  if (normalizedContentType.includes("multipart/form-data")) {
    // Multipart values can contain arbitrary files and credentials. The
    // recorder never replays multipart writes, so retain no body content.
    return { value: "[multipart body omitted]", redactedPaths: [], valueAliases: [] };
  }
  if (normalizedContentType.includes("application/x-www-form-urlencoded")) {
    return { value: redactFormBody(value), redactedPaths: [], valueAliases: [] };
  }
  if (normalizedContentType.includes("html")) {
    return { value: sanitizeHtmlLinks(value), redactedPaths: [], valueAliases: [] };
  }
  const jsonLike = normalizedContentType.includes("json") || /^[\s]*[\[{]/.test(value);
  if (jsonLike) {
    try {
      const redactedPaths: string[] = [];
      const valueAliases: Array<{ path: string; alias: string }> = [];
      return {
        value: JSON.stringify(redactJson(JSON.parse(value), undefined, "", redactedPaths, valueAliases, context, kind)),
        redactedPaths,
        valueAliases,
      };
    } catch {
      // JSON-like payloads with broken structure cannot be redacted with
      // confidence. Do not retain any prefix or text fallback that may contain
      // short credentials the generic scanner cannot recognize.
      return { value: '{"__ratatosk_malformed__":true}', redactedPaths: [], valueAliases: [] };
    }
  }
  return { value: redactText(value), redactedPaths: [], valueAliases: [] };
}

function redactFormBody(value: string): string {
  try {
    const params = new URLSearchParams(value);
    for (const key of new Set(params.keys())) params.set(key, "REDACTED");
    return params.toString();
  } catch {
    return "[form body omitted]";
  }
}

/** HTML carries arbitrary user-visible content. Keep only sanitized document
 * links, which is the sole HTML evidence recorder inference needs. */
function sanitizeHtmlLinks(value: string): string {
  const links: string[] = [];
  const href = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  for (let match; (match = href.exec(value)) !== null;) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    if (!raw || /^\s*(?:javascript|data|mailto|tel):/i.test(raw)) continue;
    const cleaned = sanitizeUrl(raw);
    if (cleaned.length > 2_048) continue;
    links.push(`<a href="${escapeHtmlAttribute(cleaned)}"></a>`);
    if (links.length >= 500) break;
  }
  return links.join("");
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function redactJson(
  value: unknown,
  key: string | undefined,
  path: string,
  redactedPaths: string[],
  valueAliases: Array<{ path: string; alias: string }>,
  context?: CaptureRedactionContext,
  kind: CapturedBodyKind = "response",
): unknown {
  if (key && (SENSITIVE_KEY.test(key) || isPiiKey(key) || isPaymentSensitiveKey(key))) {
    if (isSafeRedactedPath(path) && redactedPaths.length < MAX_REDACTED_PATHS) redactedPaths.push(path);
    return "REDACTED";
  }
  if (isPaymentSensitiveValue(value)) {
    if (isSafeRedactedPath(path) && redactedPaths.length < MAX_REDACTED_PATHS) redactedPaths.push(path);
    return "REDACTED";
  }
  if (context && isIdentifierField(key) && (typeof value === "string" || typeof value === "number") && isOpaqueIdentifier(String(value))) {
    const alias = context.alias(String(value));
    if (isSafeRedactedPath(path) && valueAliases.length < MAX_REDACTED_PATHS) valueAliases.push({ path, alias });
    return alias;
  }
  if (Array.isArray(value)) return value.map((item, index) => redactJson(item, key, joinPath(path, String(index)), redactedPaths, valueAliases, context, kind));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const used = new Set(entries.map(([rawKey]) => rawKey));
    let redactedKeyIndex = 0;
    return Object.fromEntries(entries.map(([rawKey, child]) => {
      const key = isUnsafeJsonPropertyKey(rawKey)
        ? nextRedactedJsonKey(used, ++redactedKeyIndex)
        : rawKey;
      return [key, redactJson(child, rawKey, joinPath(path, key), redactedPaths, valueAliases, context, kind)];
    }));
  }
  return typeof value === "string" ? sanitizeJsonScalar(value, key, kind) : value;
}

const ISO_DATE_VALUE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const CURRENCY_VALUE = /^[A-Za-z]{3}$/;
const GRAPHQL_OPERATION = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/;
const SAFE_GRAPHQL_ENUM_KEY = /^(?:status|type|sort|order)$/i;
const SAFE_GRAPHQL_ENUM_VALUE = /^[a-z][a-z0-9_-]{0,31}$/i;
const DATE_VALUE_KEY = /(?:^|_)(?:date|created|issued|period_end|timestamp)(?:_|$)|(?:date|created|issued|periodEnd|timestamp)(?:At)?$/i;
const CURRENCY_VALUE_KEY = /^(?:currency|curr|currency_code)$/i;
const INVOICE_IDENTIFIER_VALUE = /^(?:inv|invoice|in)[_-][A-Za-z0-9-]{1,128}$/i;

function sanitizeJsonScalar(value: string, key: string | undefined, kind: CapturedBodyKind): string {
  const structural = /^(?:https?:\/\/|\/)/i.test(value) ? sanitizeUrl(value) : value;
  const cleaned = redactText(structural).replace(EMAIL, "user@example.com");
  // A URL is already reduced to route/query structure by sanitizeUrl. It may
  // be needed as a document-origin signal, while all ordinary string leaves
  // below are treated as user data unless explicitly structural.
  if (/^(?:https?:\/\/|\/)/i.test(value) || cleaned !== structural) return cleaned;
  if (isApprovedJsonScalar(key, cleaned, kind)) return cleaned;
  return "REDACTED";
}

function isApprovedJsonScalar(key: string | undefined, value: string, kind: CapturedBodyKind): boolean {
  if (!key) return false;
  if (ISO_DATE_VALUE.test(value) && DATE_VALUE_KEY.test(key)) return true;
  if (CURRENCY_VALUE.test(value) && CURRENCY_VALUE_KEY.test(key)) return true;
  if (kind === "response" && isIdentifierField(key) && INVOICE_IDENTIFIER_VALUE.test(value)) return true;
  if (kind !== "request") return false;
  if (key === "operationName") return GRAPHQL_OPERATION.test(value);
  if (key === "query") return isStructuralGraphqlQuery(value);
  if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return true;
  return SAFE_GRAPHQL_ENUM_KEY.test(key) && SAFE_GRAPHQL_ENUM_VALUE.test(value);
}

/** A captured query is structural only when it cannot embed a user string
 * literal. Queries with literals are deliberately omitted from auto-replay. */
function isStructuralGraphqlQuery(value: string): boolean {
  if (value.length > 48 * 1024 || /["']/.test(value)) return false;
  const query = value.replace(/#[^\r\n]*/g, " ").trim();
  return /^query(?:\s+[_A-Za-z][_0-9A-Za-z]*)?\s*(?:\([^)]*\)\s*)?\{/s.test(query) && !/\b(?:mutation|subscription)\b/i.test(query);
}

function isPiiKey(key: string): boolean {
  // Field names in JSON are commonly camelCase. Normalize their boundaries
  // before matching so `firstName` and `billingAddress` receive the same
  // protection as `first_name` and `billing_address`.
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
  if (NON_PII_STRUCTURAL_NAME_KEYS.has(normalized)) return false;
  return PII_KEY.test(normalized);
}

/** Property names can themselves be captured personal data when an API uses an
 * email, opaque capability, or account token as a map key. Preserve ordinary
 * schema keys, but never persist a key-shaped value. */
function isUnsafeJsonPropertyKey(rawKey: string): boolean {
  const decoded = decodeCaptureComponent(rawKey);
  return EMAIL_VALUE.test(decoded) || isCapabilityPropertyKey(decoded) || /^(?:sk|pk|rk|api)_(?:live|test|prod)_/i.test(decoded);
}

function isCapabilityPropertyKey(value: string): boolean {
  return UUID_VALUE.test(value) || (
    value.length >= 24 && /^[A-Za-z0-9_-]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)
  );
}

function nextRedactedJsonKey(used: Set<string>, index: number): string {
  let suffix = index;
  let candidate = `__ratatosk_redacted_key_${suffix}__`;
  while (used.has(candidate)) candidate = `__ratatosk_redacted_key_${++suffix}__`;
  used.add(candidate);
  return candidate;
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
    .replace(/(["']?(?:token|secret|password|passwd|cookie|session|authorization|api[_-]?key|csrf|xsrf)["']?\s*[:=]\s*["']?)[^\s,}&"']+/gi, "$1REDACTED")
    .replace(/(["']?(?:email|name|recipient|address|phone|vat|tax|ssn|personnummer|customer)["']?\s*[:=]\s*["']?)[^\s,}&"']+/gi, "$1REDACTED")
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{8,}=*/g, "Bearer REDACTED")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "REDACTED_JWT")
    .replace(/\b(?:sk|pk|rk|api)[_-](?:live|test|prod)?[_-]?[A-Za-z0-9_-]{12,}\b/gi, "REDACTED_KEY")
    .replace(/([?&](?:token|key|secret|signature|sig|auth|code)=)[^&#\s"']+/gi, "$1REDACTED")
    .replace(EMAIL, "user@example.com");
}
