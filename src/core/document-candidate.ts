/**
 * Select the most directly materializable URL when one invoice is exposed
 * through multiple equivalent controls. Some portals render both a navigation
 * or forced-download endpoint and an explicit PDF endpoint for the same receipt.
 * Keeping DOM order makes collection depend on presentation order, so prefer the
 * URL whose path states the document representation most precisely.
 */
export function preferDocumentUrl(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!current) return candidate;
  if (!candidate) return current;
  return documentUrlScore(candidate) > documentUrlScore(current) ? candidate : current;
}

function documentUrlScore(value: string): number {
  try {
    const path = new URL(value).pathname.toLowerCase();
    if (path.endsWith(".pdf")) return 3;
    if (/(?:^|\/)pdf(?:\/|$)/.test(path)) return 2;
    if (/(?:^|\/)download(?:\/|$)/.test(path)) return 1;
  } catch {
    return -1;
  }
  return 0;
}
