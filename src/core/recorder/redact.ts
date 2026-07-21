/**
 * Redact PII from a captured JSON body before it's stored as a test fixture.
 *
 * Captured billing responses contain real names, emails, and opaque capability
 * tokens (you saw this in the Anthropic capture). Fixtures only need field
 * *names, shapes, and numeric values* — so we scrub string values that look like
 * PII while keeping amounts/dates/ids intact, so the mapping stays testable.
 */

const PII_KEY = /email|name|recipient|address|phone|vat|tax|ssn|personnummer|customer/i;
const SENSITIVE_KEY = /token|secret|password|passwd|passcode|credential|private[_-]?key|cookie|session|authorization|api[_-]?key|csrf|xsrf/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Long opaque token segments in URLs/strings (Stripe live_… capability tokens etc.). */
const LONG_TOKEN = /[A-Za-z0-9_-]{24,}/g;
const OPAQUE_KEY = /^[A-Za-z0-9_-]{24,}$/;

export function redact(value: unknown, key?: string): unknown {
  return redactWithContext(value, key, new Map());
}

function redactWithContext(value: unknown, key: string | undefined, aliases: Map<string, string>): unknown {
  if (typeof value === "string") return redactString(value, key, aliases);
  // Preserve the parent key across arrays: `customer_names` is just as
  // identifying when its values are nested in an array as when it is scalar.
  if (Array.isArray(value)) return value.map((v) => redactWithContext(v, key, aliases));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let redactedKeyIndex = 0;
    for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
      const key = isUnsafePropertyKey(rawKey)
        ? nextRedactedKey(out, ++redactedKeyIndex)
        : rawKey;
      out[key] = redactWithContext(child, rawKey, aliases);
    }
    return out;
  }
  return value; // numbers, booleans, null pass through — needed to test transforms
}

function redactString(value: string, key: string | undefined, aliases: Map<string, string>): string {
  if (isPaymentSensitiveValue(value) || (key && (PII_KEY.test(key) || SENSITIVE_KEY.test(key) || isPaymentSensitiveKey(key)))) return "REDACTED";
  return value.replace(EMAIL, "user@example.com").replace(LONG_TOKEN, (token) => {
    const existing = aliases.get(token);
    if (existing) return existing;
    const alias = `REDACTED_VALUE_${aliases.size + 1}`;
    aliases.set(token, alias);
    return alias;
  });
}

function isUnsafePropertyKey(rawKey: string): boolean {
  const decoded = decodeComponent(rawKey);
  return EMAIL_VALUE.test(decoded) || OPAQUE_KEY.test(decoded) || /^(?:sk|pk|rk|api)_(?:live|test|prod)_/i.test(decoded);
}

function nextRedactedKey(out: Record<string, unknown>, index: number): string {
  let suffix = index;
  let candidate = `__ratatosk_redacted_key_${suffix}__`;
  while (Object.hasOwn(out, candidate)) candidate = `__ratatosk_redacted_key_${++suffix}__`;
  return candidate;
}

function decodeComponent(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
import { isPaymentSensitiveKey, isPaymentSensitiveValue } from "./payment-sensitive";
