/** Convert one exact, public HTTPS origin into a Chrome match pattern. */
export function exactPublicHttpsOriginPattern(origin: string): string {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" || url.origin !== origin || url.username || url.password ||
    !isPublicHostname(url.hostname)
  ) {
    throw new Error("origin must be exact public HTTPS");
  }
  return `${url.origin}/*`;
}

export function isExactPublicHttpsOriginPattern(value: string): boolean {
  if (!value.endsWith("/*")) return false;
  try {
    return exactPublicHttpsOriginPattern(value.slice(0, -2)) === value;
  } catch {
    return false;
  }
}

export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b, c] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
