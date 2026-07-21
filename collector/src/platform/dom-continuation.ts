import type { DomContinuationSpec } from "../../../src/core/types";

export const DOM_CONTINUATION_LABEL_PATTERN =
  "^(?:(?:load|show|view)\\s+more(?:\\s+(?:items|results|payments|receipts|invoices))?|next(?:\\s+page)?|older(?:\\s+(?:items|payments|receipts|invoices))?|visa\\s+fler(?:\\s+(?:objekt|resultat|betalningar|kvitton|fakturor))?|nästa(?:\\s+sida)?|äldre(?:\\s+(?:betalningar|kvitton|fakturor))?|mehr(?:\\s+(?:zahlungen|belege|rechnungen))?\\s+anzeigen|nächste(?:\\s+seite)?|ältere(?:\\s+(?:zahlungen|belege|rechnungen))?|afficher\\s+plus(?:\\s+de)?(?:\\s+(?:résultats|paiements|reçus|factures))?|page\\s+suivante|suivant|mostrar\\s+más(?:\\s+(?:resultados|pagos|recibos|facturas))?|página\\s+siguiente|siguiente|mostrar\\s+mais(?:\\s+(?:resultados|pagamentos|recibos|faturas))?|próxima\\s+página|mostra\\s+altro(?:\\s+(?:risultati|pagamenti|ricevute|fatture))?|pagina\\s+successiva|meer(?:\\s+(?:resultaten|betalingen|bonnen|facturen))?\\s+tonen|volgende(?:\\s+pagina)?)$";

const PAGINATION_QUERY_KEY = /^(?:page|p|offset|start|cursor|after|before|starting_after|page_token|continuation|per_page|limit)$/i;
const SECRET_QUERY_KEY = /(?:^|_)(?:access_?token|api_?key|auth|authorization|code|credential|jwt|secret|session|sig|signature)(?:$|_)/i;
const BILLING_INTENT = /billing|invoice|receipt|statement|payment|transaction|subscription/i;
const UNSAFE_PATH = /(?:^|\/)(?:cancel|checkout|delete|logout|payment-method|payment_methods?|remove|revoke|signout|terminate)(?:\/|$)/i;

export interface NormalizedDomContinuation {
  mode: "auto";
  maxActions: number;
  maxDocuments: number;
  timeoutMs: number;
  allowScroll: boolean;
}

export function normalizeDomContinuation(spec: DomContinuationSpec): NormalizedDomContinuation {
  return {
    mode: "auto",
    maxActions: bounded(spec.maxActions, 8, 1, 12),
    maxDocuments: bounded(spec.maxDocuments, 500, 1, 500),
    timeoutMs: bounded(spec.timeoutMs, 30_000, 1_000, 60_000),
    allowScroll: spec.allowScroll ?? false,
  };
}

/**
 * Validate an ephemeral next-page URL returned by the supplier DOM. Opaque
 * cursor values may be used in memory for the current collection run but are
 * never stored in the discovered profile or diagnostic.
 */
export function safeContinuationUrl(value: string, expectedOrigin: string): string | undefined {
  try {
    if (value.length > 1_200) return undefined;
    const url = new URL(value, `${expectedOrigin}/`);
    if (
      url.protocol !== "https:" || url.origin !== expectedOrigin || url.username || url.password || url.hash ||
      url.pathname.length > 320 || !BILLING_INTENT.test(url.pathname) || UNSAFE_PATH.test(url.pathname)
    ) return undefined;
    let paginationKeys = 0;
    for (const [key, queryValue] of url.searchParams) {
      if (SECRET_QUERY_KEY.test(key) || !PAGINATION_QUERY_KEY.test(key) || queryValue.length > 512) return undefined;
      paginationKeys += 1;
    }
    const pathPagination = /(?:^|\/)(?:page|offset)\/\d+(?:\/|$)/i.test(url.pathname);
    if (paginationKeys === 0 && !pathPagination) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value!)));
}
