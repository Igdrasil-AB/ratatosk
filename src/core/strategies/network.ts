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
  PaginateSpec,
  RequestSpec,
  RunContext,
  VendorRecipe,
} from "../types";
import type { RawDocument, Strategy } from "../engine";
import { AuthExpired, DocumentInvalid, DocumentNotFound, UnexpectedResponse } from "../errors";
import { MAX_DOCUMENT_BYTES, readDocumentBytes } from "../document-size";
import { extract, extractString } from "../extract";
import { get, getArray } from "../jsonpath";
import { render } from "../template";
import { createInvoiceListResult } from "../retrieval";

const DEFAULT_FILENAME = "{vendorId}-{issuedAt}-{vendorInvoiceId}.pdf";
export { MAX_DOCUMENT_BYTES } from "../document-size";

export const networkStrategy: Strategy = {
  async list(recipe, vars, ctx) {
    const spec = (recipe.invoices as NetworkInvoices).list;
    const refs: InvoiceRef[] = [];
    const maxPages = spec.paginate ? spec.paginate.maxPages ?? 20 : 1;
    const state = initialPaginationState(spec.paginate);
    const continuations = new Set<string>();
    let pagesVisited = 0;
    let termination: "explicit_end" | "continuation_failed" | "repeated_state" | "page_cap" = "explicit_end";

    for (let page = 0; page < maxPages; page++) {
      pagesVisited += 1;
      const requestVars = { ...vars, ...state.vars };
      const request = state.nextUrl ? { ...spec.request, url: state.nextUrl } : spec.request;
      const requestUrl = render(request.url, requestVars);
      const res = await ctx.fetch(request, requestVars);
      // 401 = no valid session → reconnect (vendor-wide). 403 = authenticated but
      // this scope/org isn't allowed the resource → a per-scope failure the engine
      // skips, NOT a dead session. (The recipe's auth.check already verified login.)
      if (res.status === 401) throw new AuthExpired(recipe.id);
      if (!res.ok) {
        throw new UnexpectedResponse(res.status, "invoice list failed", recipe.id, res.headers.get("content-type") ?? undefined);
      }

      const json = await res.json();
      const rawItemCount = getArray(json, spec.items).length;
      const responseUrl = res.url || requestUrl;
      const pageRefs = mapListResponse(recipe.id, spec, json).map((ref) => ({
        ...ref,
        documentUrl: ref.documentUrl ? new URL(ref.documentUrl, responseUrl).toString() : undefined,
      }));
      refs.push(...pageRefs);

      if (!spec.paginate) break;
      const next = nextPaginationState(
        spec.paginate,
        json,
        requestUrl,
        rawItemCount,
        state,
        res.headers.get("link"),
      );
      if (!next) {
        if (requiresContinuation(spec.paginate, json, rawItemCount, res.headers.get("link"))) termination = "continuation_failed";
        break;
      }
      if (continuations.has(next.key)) {
        termination = "repeated_state";
        break;
      }
      if (page + 1 >= maxPages) {
        termination = "page_cap";
        break;
      }
      continuations.add(next.key);
      state.vars = next.vars;
      state.nextUrl = next.nextUrl;
    }

    return createInvoiceListResult(await disambiguateDuplicateInvoiceIds(refs), {
      termination,
      pagesVisited,
      observedItems: refs.length,
      resolvedItems: refs.length,
      unresolvedItems: 0,
    });
  },

  async fetchDocument(recipe, ref, vars, ctx, signal): Promise<RawDocument> {
    const doc = (recipe.invoices as NetworkInvoices).document;
    const docVars = {
      ...vars,
      id: ref.vendorInvoiceId,
      documentRef: ref.documentRef ?? "",
      documentUrl: ref.documentUrl ?? "",
    };

    let res;
    if (doc.request) {
      res = await ctx.fetch(doc.request, docVars, signal);
    } else if (ref.documentUrl) {
      res = await ctx.fetch({ url: ref.documentUrl }, docVars, signal);
    } else {
      throw new DocumentNotFound("document URL unavailable", recipe.id);
    }

    if (res.status === 404) throw new DocumentNotFound("document unavailable", recipe.id);
    if (res.status === 401) throw new AuthExpired(recipe.id);
    if (!res.ok) {
      throw new UnexpectedResponse(res.status, "document fetch failed", recipe.id, res.headers.get("content-type") ?? undefined);
    }

    const bytes = await readDocumentBytes(res, recipe.id);
    const head = new Uint8Array(bytes.slice(0, 4));
    const looksPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // "%PDF"
    const responseContentType = normalizeResponseContentType(res.headers.get("content-type"));
    const expectedContentType = normalizeResponseContentType(doc.contentType ?? "application/pdf");
    console.info(
      `[collector] ${recipe.id} document: ${bytes.byteLength}b type=${responseContentType || "?"} pdf=${looksPdf}`,
    );
    if (expectedContentType === "application/pdf") {
      // Suppliers commonly serve valid PDFs as octet-stream, force downloads,
      // or attach stale MIME metadata. The PDF signature is authoritative; MIME
      // is diagnostic only and invoice text/keywords are never a retrieval gate.
      if (!looksPdf) {
        throw new DocumentInvalid(res.status, responseContentType, recipe.id);
      }
    }
    const contentType = expectedContentType === "application/pdf"
      ? "application/pdf"
      : responseContentType || expectedContentType;
    const filename = render(doc.filename ?? DEFAULT_FILENAME, {
      vendorId: recipe.id,
      issuedAt: ref.issuedAt ?? "unknown",
      vendorInvoiceId: ref.vendorInvoiceId,
    });

    return { bytes, contentType, filename };
  },
};

async function disambiguateDuplicateInvoiceIds(refs: InvoiceRef[]): Promise<InvoiceRef[]> {
  const groups = new Map<string, InvoiceRef[]>();
  for (const ref of refs) groups.set(ref.vendorInvoiceId, [...(groups.get(ref.vendorInvoiceId) ?? []), ref]);
  const duplicateIds = new Set([...groups].flatMap(([id, group]) => {
    const discriminators = new Set(group.map((ref, index) => ref.documentRef ?? ref.documentUrl ?? `position:${index}`));
    return discriminators.size > 1 ? [id] : [];
  }));
  return Promise.all(refs.map(async (ref, index) => {
    if (!duplicateIds.has(ref.vendorInvoiceId)) return ref;
    const discriminator = ref.documentRef ?? ref.documentUrl ?? `position:${index}`;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(discriminator)));
    const suffix = [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { ...ref, vendorInvoiceId: `${ref.vendorInvoiceId}-${suffix}` };
  }));
}

interface PaginationState {
  vars: Record<string, unknown>;
  nextUrl?: string;
}

function initialPaginationState(spec: PaginateSpec | undefined): PaginationState {
  if (!spec || spec.kind === undefined || spec.kind === "cursor") {
    return { vars: spec ? { [spec.variable ?? "cursor"]: "" } : {} };
  }
  if (spec.kind === "page") return { vars: { [spec.variable ?? "page"]: spec.start ?? 1 } };
  if (spec.kind === "offset") return { vars: { [spec.variable ?? "offset"]: spec.start ?? 0 } };
  return { vars: {} };
}

function requiresContinuation(spec: PaginateSpec, json: unknown, itemCount: number, linkHeader: string | null): boolean {
  const hasMore = spec.hasMore ? get(json, spec.hasMore) : undefined;
  if (hasMore !== undefined) return truthyContinuation(hasMore);
  if ((spec.kind === undefined || spec.kind === "cursor") && spec.pageSize && itemCount >= spec.pageSize) return true;
  // For next-url and Link pagination the locator itself is the continuation
  // signal. A present but unsafe/malformed locator must be partial, not an
  // implicit end of the invoice history.
  if (spec.kind === "next-url") {
    const value = get(json, spec.nextUrl);
    return typeof value === "string" && value.trim().length > 0;
  }
  return spec.kind === "link-header" && hasNextLinkHeader(linkHeader);
}

function nextPaginationState(
  spec: PaginateSpec,
  json: unknown,
  requestUrl: string,
  itemCount: number,
  current: PaginationState,
  linkHeader: string | null,
): (PaginationState & { key: string }) | undefined {
  if (spec.hasMore) {
    const hasMore = get(json, spec.hasMore);
    if (hasMore !== undefined && !truthyContinuation(hasMore)) return undefined;
    if (hasMore === undefined && !(
      (spec.kind === undefined || spec.kind === "cursor") && spec.pageSize && itemCount >= spec.pageSize
    )) return undefined;
  }
  if (spec.kind === undefined || spec.kind === "cursor") {
    const value = get(json, spec.cursor);
    if (value === undefined || value === null || value === "") return undefined;
    if ((typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isFinite(value))) return undefined;
    const cursor = String(value);
    if (cursor.length > 2_048) return undefined;
    return { vars: { [spec.variable ?? "cursor"]: cursor }, key: `cursor:${cursor}` };
  }
  if (spec.kind === "next-url") {
    const value = get(json, spec.nextUrl);
    if (typeof value !== "string" || !value.trim()) return undefined;
    const nextUrl = safePaginationUrl(value, requestUrl);
    if (!nextUrl) return undefined;
    return { vars: {}, nextUrl, key: `url:${nextUrl}` };
  }
  if (spec.kind === "link-header") {
    const nextUrl = nextUrlFromLinkHeader(linkHeader, requestUrl);
    return nextUrl ? { vars: {}, nextUrl, key: `url:${nextUrl}` } : undefined;
  }
  if (spec.kind !== "page" && spec.kind !== "offset") return undefined;
  if (spec.pageSize && itemCount < spec.pageSize) return undefined;
  const variable = spec.variable ?? (spec.kind === "page" ? "page" : "offset");
  const currentValue = Number(current.vars[variable] ?? (spec.kind === "page" ? spec.start ?? 1 : spec.start ?? 0));
  const nextValue = currentValue + (spec.step ?? 1);
  return { vars: { [variable]: nextValue }, key: `${spec.kind}:${nextValue}` };
}

function nextUrlFromLinkHeader(header: string | null, requestUrl: string): string | undefined {
  if (!header || header.length > 4_096) return undefined;
  for (const part of header.split(",").slice(0, 20)) {
    const match = /^\s*<([^>]{1,1200})>\s*;(.*)$/i.exec(part);
    if (!match || !/(?:^|;)\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|'[^']*\bnext\b[^']*'|next)(?:\s*;|\s*$)/i.test(`;${match[2]}`)) continue;
    return safePaginationUrl(match[1], requestUrl);
  }
  return undefined;
}

function hasNextLinkHeader(header: string | null): boolean {
  return Boolean(header && /(?:^|;)\s*rel\s*=\s*(?:"[^"\r\n]*\bnext\b[^"\r\n]*"|'[^'\r\n]*\bnext\b[^'\r\n]*'|next)(?:\s*;|\s*$)/i.test(header));
}

function safePaginationUrl(value: string, requestUrl: string): string | undefined {
  try {
    if (value.length > 2_048) return undefined;
    const url = new URL(value, requestUrl);
    const origin = new URL(requestUrl).origin;
    // Pagination reuses the original request's headers and page-session
    // credentials. It therefore cannot change origin; document retrieval has
    // a separate, permission-gated transport for approved provider hosts.
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return undefined;
    url.hash = "";
    const normalized = url.toString();
    return normalized.length <= 2_048 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function truthyContinuation(value: unknown): boolean {
  if (value === false || value === null || value === undefined || value === 0 || value === "") return false;
  if (typeof value === "string" && /^(?:false|no|0)$/i.test(value.trim())) return false;
  return true;
}

function normalizeResponseContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

// ---- Pure mapping (unit-tested directly against fixtures) -----------------

export function mapListResponse(vendorId: string, spec: NetworkListSpec, json: unknown): InvoiceRef[] {
  return getArray(json, spec.items).map((item) => mapItem(vendorId, spec.map, item));
}

export function mapItem(_vendorId: string, map: FieldMap, item: unknown): InvoiceRef {
  const vendorInvoiceId = extractString(item, map.id)?.trim();
  const issuedAt = extractString(item, map.issuedAt);
  if (!vendorInvoiceId) {
    throw new UnexpectedResponse(200, "invoice list item is missing a stable invoice ID", _vendorId);
  }
  return {
    vendorInvoiceId,
    // Server-rendered rows may omit a date; the pipeline reads it from the PDF.
    ...(issuedAt ? { issuedAt } : {}),
    total: extractString(item, map.total),
    currency: extractString(item, map.currency),
    documentUrl: extractString(item, map.documentUrl),
    documentRef: extractString(item, map.documentRef),
  };
}

// Re-exported for symmetry with strategy consumers that import from here.
export type { VendorRecipe, RunContext };
