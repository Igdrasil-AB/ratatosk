/**
 * Redact PII from a captured JSON body before it's stored as a test fixture.
 *
 * Captured billing responses contain real names, emails, and opaque capability
 * tokens (you saw this in the Anthropic capture). Fixtures only need field
 * *names, shapes, and numeric values* — so we scrub string values that look like
 * PII while keeping amounts/dates/ids intact, so the mapping stays testable.
 */

const PII_KEY = /email|name|recipient|address|phone|vat|tax|ssn|personnummer|customer/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
/** Long opaque token segments in URLs/strings (Stripe live_… capability tokens etc.). */
const LONG_TOKEN = /[A-Za-z0-9_-]{24,}/g;

export function redact(value: unknown, key?: string): unknown {
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, k);
    return out;
  }
  return value; // numbers, booleans, null pass through — needed to test transforms
}

function redactString(value: string, key?: string): string {
  if (key && PII_KEY.test(key)) return "REDACTED";
  return value.replace(EMAIL, "user@example.com").replace(LONG_TOKEN, "TOKEN");
}
