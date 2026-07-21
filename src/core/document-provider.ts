export type DocumentProviderId = "stripe";

export interface DocumentProviderPolicy {
  id: DocumentProviderId;
  stableHosts: readonly string[];
  matches(url: URL): boolean;
  canonicalize(url: URL): URL;
}

export const STRIPE_DOCUMENT_HOSTS = [
  "https://invoice.stripe.com/*",
  "https://pay.stripe.com/*",
  "https://files.stripe.com/*",
] as const;

/** Bootstrap origin used by Stripe today. New regional origins are learned only
 * through the typed permission-drift flow and never broaden this allowlist. */
export const STRIPE_KNOWN_DOCUMENT_HOSTS = [
  ...STRIPE_DOCUMENT_HOSTS,
  "https://stripe-upload-api.s3.us-west-1.amazonaws.com/*",
] as const;

const STRIPE_CAPABILITY_HOSTS = new Set([
  "invoice.stripe.com",
  "pay.stripe.com",
  "files.stripe.com",
]);
const STRIPE_UPLOAD_HOST = /^stripe-upload-api\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;

const stripePolicy: DocumentProviderPolicy = {
  id: "stripe",
  stableHosts: STRIPE_DOCUMENT_HOSTS,
  matches(url) {
    return STRIPE_CAPABILITY_HOSTS.has(url.hostname) || STRIPE_UPLOAD_HOST.test(url.hostname);
  },
  canonicalize(url) {
    const hostedInvoice = url.pathname.match(/^\/i\/([^/]+)\/([^/]+)$/);
    if (url.hostname !== "invoice.stripe.com" || !hostedInvoice) return url;
    const canonical = new URL(url.toString());
    canonical.hostname = "pay.stripe.com";
    canonical.pathname = `/invoice/${hostedInvoice[1]}/${hostedInvoice[2]}/pdf`;
    return canonical;
  },
};

const PROVIDERS: readonly DocumentProviderPolicy[] = [stripePolicy];

export function documentProviderForUrl(value: string | URL): DocumentProviderPolicy | undefined {
  const url = normalHttpsUrl(value);
  return url ? PROVIDERS.find((provider) => provider.matches(url)) : undefined;
}

export function canonicalDocumentProviderUrl(value: string | URL): string {
  const url = normalHttpsUrl(value);
  if (!url) throw new Error("document provider URL must be normal HTTPS");
  return (PROVIDERS.find((provider) => provider.matches(url))?.canonicalize(url) ?? url).toString();
}

/** Exact origin permission for a trusted provider URL. Paths and signed query
 * values deliberately never cross this boundary. */
export function exactDocumentProviderOrigin(value: string | URL): string | undefined {
  const url = normalHttpsUrl(value);
  if (!url || !PROVIDERS.some((provider) => provider.matches(url))) return undefined;
  return `${url.origin}/*`;
}

export function isExactDocumentProviderOriginPattern(value: string): boolean {
  if (!value.endsWith("/*")) return false;
  return exactDocumentProviderOrigin(value.slice(0, -2)) === value;
}

function normalHttpsUrl(value: string | URL): URL | undefined {
  try {
    const url = value instanceof URL ? new URL(value.toString()) : new URL(value);
    // Chrome extension match patterns cannot express ports. URL normalizes an
    // explicit :443 to the empty string, so any remaining port is non-default.
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return undefined;
    return url;
  } catch {
    return undefined;
  }
}
