/**
 * Network-replay strategy — the default and the robust one.
 *
 * Instead of scraping HTML, it calls the vendor's own internal billing JSON API
 * (the same request the vendor's billing page makes) and reads structured data
 * straight back. It survives visual redesigns because it depends only on the
 * API shape, which vendors change far less often than their markup.
 *
 * The pure mapping functions (`mapListResponse`, `mapItem`) are exported so a
 * vendor test can feed a recorded fixture through them with zero network I/O.
 */
import type {
  FieldMap,
  InvoiceRef,
  NetworkInvoices,
  NetworkListSpec,
  RunContext,
  VendorRecipe,
} from "../types";
import type { RawDocument, Strategy } from "../engine";
import { AuthExpired, DocumentNotFound, UnexpectedResponse } from "../errors";
import { extract, extractString } from "../extract";
import { get, getArray } from "../jsonpath";
import { render } from "../template";

const DEFAULT_FILENAME = "{vendorId}-{issuedAt}-{vendorInvoiceId}.pdf";

export const networkStrategy: Strategy = {
  async list(recipe, vars, ctx) {
    const spec = (recipe.invoices as NetworkInvoices).list;
    const refs: InvoiceRef[] = [];

    let cursor = "";
    const maxPages = spec.paginate ? spec.paginate.maxPages ?? 20 : 1;

    for (let page = 0; page < maxPages; page++) {
      const res = await ctx.fetch(spec.request, { ...vars, cursor });
      // 401 = no valid session → reconnect (vendor-wide). 403 = authenticated but
      // this scope/org isn't allowed the resource → a per-scope failure the engine
      // skips, NOT a dead session. (The recipe's auth.check already verified login.)
      if (res.status === 401) throw new AuthExpired(recipe.id);
      if (!res.ok) throw new UnexpectedResponse(res.status, "invoice list failed", recipe.id);

      const json = await res.json();
      refs.push(...mapListResponse(recipe.id, spec, json));

      if (!spec.paginate) break;
      const next = get(json, spec.paginate.cursor);
      if (next === undefined || next === null || next === "") break;
      cursor = String(next);
    }

    return refs;
  },

  async fetchDocument(recipe, ref, vars, ctx): Promise<RawDocument> {
    const doc = (recipe.invoices as NetworkInvoices).document;
    const docVars = {
      ...vars,
      id: ref.vendorInvoiceId,
      documentRef: ref.documentRef ?? "",
      documentUrl: ref.documentUrl ?? "",
    };

    let res;
    if (doc.request) {
      res = await ctx.fetch(doc.request, docVars);
    } else if (ref.documentUrl) {
      res = await ctx.fetch({ url: ref.documentUrl }, docVars);
    } else {
      throw new DocumentNotFound("document URL unavailable", recipe.id);
    }

    if (res.status === 404) throw new DocumentNotFound("document unavailable", recipe.id);
    if (!res.ok) throw new UnexpectedResponse(res.status, "document fetch failed", recipe.id);

    const bytes = await res.arrayBuffer();
    const head = new Uint8Array(bytes.slice(0, 4));
    const looksPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // "%PDF"
    console.info(
      `[collector] ${recipe.id} document: ${bytes.byteLength}b type=${res.headers.get("content-type") ?? "?"} pdf=${looksPdf}`,
    );
    // Trust the server's content-type when it disagrees with the recipe, so an
    // HTML error page isn't silently saved as a .pdf.
    const contentType = res.headers.get("content-type")?.includes("pdf")
      ? "application/pdf"
      : (doc.contentType ?? res.headers.get("content-type") ?? "application/pdf");
    const filename = render(doc.filename ?? DEFAULT_FILENAME, {
      vendorId: recipe.id,
      issuedAt: ref.issuedAt,
      vendorInvoiceId: ref.vendorInvoiceId,
    });

    return { bytes, contentType, filename };
  },
};

// ---- Pure mapping (unit-tested directly against fixtures) -----------------

export function mapListResponse(vendorId: string, spec: NetworkListSpec, json: unknown): InvoiceRef[] {
  return getArray(json, spec.items).map((item) => mapItem(vendorId, spec.map, item));
}

export function mapItem(_vendorId: string, map: FieldMap, item: unknown): InvoiceRef {
  return {
    vendorInvoiceId: String(extract(item, map.id)),
    // Server-rendered rows may omit a date; the pipeline reads it from the PDF.
    issuedAt: map.issuedAt ? String(extract(item, map.issuedAt)) : "",
    total: extractString(item, map.total),
    currency: extractString(item, map.currency),
    documentUrl: extractString(item, map.documentUrl),
    documentRef: extractString(item, map.documentRef),
  };
}

// Re-exported for symmetry with strategy consumers that import from here.
export type { VendorRecipe, RunContext };
