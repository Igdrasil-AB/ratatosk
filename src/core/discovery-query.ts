const SAFE_STATIC_QUERY_KEY = /^(?:limit|offset|page|per_page|sort|order|status|type)$/i;
const SAFE_STATIC_QUERY_VALUE = /^[A-Za-z0-9_.-]{0,32}$/;

/** Static query parameters that automatic discovery may safely replay without
 * treating a captured account/token value as reusable configuration. */
export function isSafeStaticDiscoveryQueryValue(key: string, value: string): boolean {
  return SAFE_STATIC_QUERY_KEY.test(key) && SAFE_STATIC_QUERY_VALUE.test(value);
}

/**
 * Capture sanitization intentionally redacts every query value. Restore only
 * the closed static subset already accepted by discovered-recipe policy; all
 * account identifiers, filters, signatures, and credentials stay redacted.
 */
export function restoreSafeStaticQueryValues(observedUrl: string, sanitizedUrl: string): string {
  let observed: URL;
  let sanitized: URL;
  try {
    observed = new URL(observedUrl);
    sanitized = new URL(sanitizedUrl);
  } catch {
    return sanitizedUrl;
  }
  if (
    observed.protocol !== "https:" || sanitized.protocol !== "https:" ||
    observed.origin !== sanitized.origin || observed.username || observed.password
  ) return sanitizedUrl;

  for (const key of new Set(observed.searchParams.keys())) {
    const values = observed.searchParams.getAll(key);
    if (values.length !== 1 || !sanitized.searchParams.has(key)) continue;
    const value = values[0];
    if (isSafeStaticDiscoveryQueryValue(key, value)) sanitized.searchParams.set(key, value);
  }
  sanitized.hash = "";
  return sanitized.toString();
}
