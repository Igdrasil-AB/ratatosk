/**
 * DOM strategy — the fallback for vendors with no JSON API to replay.
 *
 * DOM automation needs a real document, which only exists in the platform layer
 * (an offscreen document or an injected content script). To keep the core
 * platform-free, this module defines the *driver contract* and builds a strategy
 * around whatever driver the platform injects. Tests and CI (no browser) use the
 * network strategy only and never touch this.
 *
 * Prefer network replay. Reach for DOM only when a vendor genuinely renders
 * invoices server-side with no discoverable endpoint — and expect more upkeep.
 */
import type { DomInvoices, DomStep, InvoiceRef, VendorRecipe } from "../types";
import type { RawDocument, Strategy } from "../engine";
import { DocumentNotFound, SelectorMiss, UnexpectedResponse } from "../errors";
import { render } from "../template";

/** Implemented by the platform, backed by an offscreen document. */
export interface DomDriver {
  /** Open `url`, run `steps`, and return the variables collected by `extractAll`. */
  run(url: string, steps: DomStep[]): Promise<Record<string, string[]>>;
  /** Fetch a URL as bytes using the live session (delegates to credentialed fetch). */
  download(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }>;
}

const DEFAULT_FILENAME = "{vendorId}-{issuedAt}-{vendorInvoiceId}.pdf";

export function makeDomStrategy(driver: DomDriver): Strategy {
  return {
    async list(recipe, _vars, _ctx): Promise<InvoiceRef[]> {
      const spec = (recipe.invoices as DomInvoices).list;
      const collected = await driver.run(spec.open, spec.steps);
      const hrefs = collected[spec.hrefsFrom];
      if (!hrefs) throw new SelectorMiss(`DOM step never collected "${spec.hrefsFrom}"`, recipe.id);

      // The DOM strategy can only offer opaque document URLs; downstream systems
      // dedup on these. A richer DOM recipe can add per-row metadata later.
      return hrefs.map((href, i) => ({
        vendorInvoiceId: idFromHref(href, i),
        issuedAt: "", // unknown from a bare link; the ingest pipeline derives it from the PDF
        documentUrl: href,
      }));
    },

    async fetchDocument(recipe, ref, _vars, _ctx): Promise<RawDocument> {
      if (!ref.documentUrl) throw new DocumentNotFound(ref.vendorInvoiceId, recipe.id);
      const { bytes, contentType } = await driver.download(ref.documentUrl);
      if (bytes.byteLength === 0) throw new UnexpectedResponse(200, "empty document", recipe.id);
      const filename = render((recipe.invoices as DomInvoices).document.filename ?? DEFAULT_FILENAME, {
        vendorId: recipe.id,
        issuedAt: ref.issuedAt || "unknown",
        vendorInvoiceId: ref.vendorInvoiceId,
      });
      return { bytes, contentType, filename };
    },
  };
}

/** A strategy that fails loudly when a recipe needs DOM but no driver is wired. */
export const unavailableDomStrategy: Strategy = {
  list(recipe) {
    return Promise.reject(new SelectorMiss("DOM strategy is not available in this runtime", recipe.id));
  },
  fetchDocument(recipe) {
    return Promise.reject(new SelectorMiss("DOM strategy is not available in this runtime", recipe.id));
  },
};

function idFromHref(href: string, index: number): string {
  const last = href.split("?")[0].split("/").filter(Boolean).pop();
  return last && last.length > 3 ? last : `doc-${index}`;
}
