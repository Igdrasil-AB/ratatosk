const SAFE_STATIC_QUERY_KEY = /^(?:limit|offset|page|per_page|sort|order|status|type)$/i;
const SAFE_STATIC_QUERY_VALUE = /^[A-Za-z0-9_.-]{0,32}$/;

/** Static query parameters that automatic discovery may safely replay without
 * treating a captured account/token value as reusable configuration. */
export function isSafeStaticDiscoveryQueryValue(key: string, value: string): boolean {
  return SAFE_STATIC_QUERY_KEY.test(key) && SAFE_STATIC_QUERY_VALUE.test(value);
}
