import type { CapturedEntry } from "./types";
import { detectRequestAuth, normalizeContentType, sanitizeHeaders } from "./cdp";
import { isPaymentSensitiveKey, isPaymentSensitiveValue } from "./payment-sensitive";

/**
 * Evidence normalization for *local* supplier discovery.
 *
 * This is deliberately NOT `buildEntry` from `cdp.ts`. That sanitizer exists for
 * the recorder, whose output is a capture session a human reviews and may share:
 * it must survive leaving the machine, so it reduces every value it cannot prove
 * safe to `REDACTED` and keeps only a structural skeleton.
 *
 * Discovery has the opposite lifetime. Its evidence is observed in the page,
 * held in service-worker memory for one bounded scan, used to infer a recipe,
 * and dropped. Nothing derived from a response body is ever persisted or
 * uploaded — only the *request* the recipe must replay (URL, method, JSON body)
 * reaches storage, and that request is separately re-validated by
 * `assertDiscoveredRecipePolicy` before a candidate can exist.
 *
 * Running discovery evidence through the recorder's sanitizer therefore
 * destroyed exactly what inference needs while protecting nothing extra: an
 * invoice array nested under a `customer` key was replaced wholesale, every
 * opaque workspace/account identifier became `REDACTED`, and the resulting draft
 * was then discarded for containing redactions. Whole classes of supplier — any
 * GraphQL portal, any API with a non-trivial query string — could never produce
 * a network candidate.
 *
 * What this normalizer still removes is what is genuinely unsafe to hold or to
 * replay: credential-named fields, credential-shaped values (JWTs, provider API
 * keys, bearer strings) and payment instrument data.
 */

const MAX_BODY_CHARS = 256_000;
const MAX_REDACTED_PATHS = 40;

/** Field and query-parameter names whose value is a credential, never data. */
const CREDENTIAL_KEY =
  /(?:^|[_-])(?:token|secret|password|passwd|passcode|credential|private[_-]?key|privatekey|cookie|session|authorization|apikey|api[_-]?key|csrf|xsrf|signature|jwt|otp|mfa)(?:[_-]|$)/i;

/** Values that are a credential regardless of the field that carried them. */
const CREDENTIAL_VALUE =
  /^(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:sk|pk|rk|api)[_-](?:live|test|prod)[_-][A-Za-z0-9_-]{8,}|(?:bearer|basic)\s+\S{8,})$/i;

const REDACTED = "REDACTED";

/**
 * Normalize one observed request/response pair into inference evidence.
 *
 * Bodies keep their shape *and* their values, because the array under
 * `data.workspace.customer.invoices` and the identifier inside a GraphQL
 * `variables` object are the evidence. Only credential-bearing leaves are
 * replaced.
 */
export function buildDiscoveryEvidenceEntry(input: {
  url: string;
  method: string;
  status: number;
  contentType: string | undefined | null;
  body?: string;
  requestBody?: string;
  requestHeaders?: Record<string, unknown>;
}): CapturedEntry {
  const contentType = normalizeContentType(input.contentType);
  const response = input.body === undefined ? undefined : redactDiscoveryBody(input.body);
  return {
    url: sanitizeDiscoveryUrl(input.url),
    method: (input.method || "GET").toUpperCase(),
    status: input.status,
    contentType,
    requestBody: input.requestBody === undefined ? undefined : redactDiscoveryBody(input.requestBody)?.value,
    requestHeaders: sanitizeHeaders(input.requestHeaders),
    requestAuth: detectRequestAuth(input.requestHeaders),
    // Where a credential *was*, never what it was. This is what lets discovery
    // wire a runtime token exchange without ever holding the token: the path is
    // structure, and the value is fetched fresh from the user's own session.
    ...(response?.redactedPaths.length ? { redactedResponsePaths: response.redactedPaths } : {}),
    responseBody: response?.value,
  };
}

/**
 * Keep a URL replayable. Credentials in the authority, the fragment, and
 * credential-named or credential-shaped query values are removed; ordinary
 * filters, operation names, years, and tenant identifiers are retained because
 * a request without them addresses a different resource — or none at all.
 */
export function sanitizeDiscoveryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const [key, queryValue] of [...url.searchParams.entries()]) {
    if (CREDENTIAL_KEY.test(key) || isCredentialValue(queryValue)) url.searchParams.set(key, REDACTED);
  }
  return url.toString();
}

interface RedactedBody {
  value: string;
  /** Structural paths whose value was a credential. */
  redactedPaths: string[];
}

function redactDiscoveryBody(body: string): RedactedBody | undefined {
  if (!body || body.length > MAX_BODY_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A non-JSON body cannot be inspected key-by-key, so it cannot be proven
    // free of credentials. Discovery only ever infers from JSON.
    return undefined;
  }
  const redactedPaths: string[] = [];
  const value = JSON.stringify(redactCredentialLeaves(parsed, undefined, "", 0, redactedPaths));
  return { value, redactedPaths };
}

function redactCredentialLeaves(
  value: unknown,
  key: string | undefined,
  path: string,
  depth: number,
  redactedPaths: string[],
): unknown {
  if (depth > 12) return null;
  const redact = () => {
    if (redactedPaths.length < MAX_REDACTED_PATHS && isStructuralPath(path)) redactedPaths.push(path);
    return REDACTED;
  };
  if (key !== undefined && (isCredentialKey(key) || isPaymentSensitiveKey(key))) return redact();
  if (isPaymentSensitiveValue(value)) return redact();
  if (typeof value === "string") return isCredentialValue(value) ? redact() : value;
  // Containers are traversed whatever they are called. A key named `customer`
  // or `account` describes where invoices live; it is not itself a secret.
  if (Array.isArray(value)) {
    return value.map((item, index) => redactCredentialLeaves(item, key, joinPath(path, String(index)), depth + 1, redactedPaths));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, redactCredentialLeaves(child, childKey, joinPath(path, childKey), depth + 1, redactedPaths)]),
    );
  }
  return value;
}

/** JSON field names are routinely camelCase, so `accessToken` has to receive the
 * same treatment as `access_token`. */
function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function isStructuralPath(path: string): boolean {
  return path.length > 0 && path.length <= 300 && path.split(".").every((part) => /^[A-Za-z0-9_$-]+$/.test(part));
}

function isCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE.test(value.trim());
}
