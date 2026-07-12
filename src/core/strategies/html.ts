/**
 * HTML strategy — for vendors that render invoices into the page instead of
 * serving a clean JSON billing API (server-rendered apps like GitHub).
 *
 * It fetches the billing page and pulls rows out of it one of two ways:
 *   - `embeddedJson`: parse the `<script type="application/json">` blobs modern
 *     apps hydrate from, then read `items` as a path into whichever blob holds
 *     the invoice array. This is the common React/Rails-SSR shape.
 *   - `rowRegex`: match a global regex whose named groups become each row —
 *     the escape hatch for pages that only ever render plain HTML rows/links.
 *
 * Document fetching is identical to network-replay (follow `documentUrl` to the
 * PDF), so we borrow that half wholesale. The extraction helpers are pure and
 * exported so a vendor test can run them against a saved page with no I/O.
 */
import type { HtmlInvoices, HtmlListSpec, InvoiceRef } from "../types";
import type { Strategy } from "../engine";
import { AuthExpired, UnexpectedResponse } from "../errors";
import { getArray } from "../jsonpath";
import { mapItem, networkStrategy } from "./network";

export const htmlStrategy: Strategy = {
  async list(recipe, vars, ctx) {
    const spec = (recipe.invoices as HtmlInvoices).list;
    const res = await ctx.fetch(spec.request, { ...vars, cursor: "" });
    if (res.status === 401) throw new AuthExpired(recipe.id);
    if (!res.ok) throw new UnexpectedResponse(res.status, "html list failed", recipe.id);

    const html = new TextDecoder().decode(await res.arrayBuffer());
    const rows = extractRows(spec, html);
    const refs = rows.map((row) => mapItem(recipe.id, spec.map, row));
    // Row-regex links are usually page-relative (`/account/receipt/…`) — make them
    // absolute against the page URL so the document fetch can follow them.
    for (const ref of refs) {
      if (ref.documentUrl) ref.documentUrl = absolutize(ref.documentUrl, spec.request.url);
    }
    return dedupById(refs);
  },

  // Same as network-replay: follow the row's documentUrl (or document.request) to the PDF.
  fetchDocument: networkStrategy.fetchDocument,
};

// ---- Pure extraction (unit-tested directly against saved pages) ------------

/** Pull the invoice rows out of an HTML page per the recipe's chosen mode. */
export function extractRows(spec: HtmlListSpec, html: string): unknown[] {
  if (spec.rowRegex) {
    const out: unknown[] = [];
    for (const match of html.matchAll(new RegExp(spec.rowRegex, "g"))) {
      out.push(match.groups ?? {});
    }
    return out;
  }
  // embeddedJson: the array lives at `items` inside one of the page's JSON blobs.
  const path = spec.items ?? "$";
  for (const blob of extractEmbeddedJson(html)) {
    const rows = getArray(blob, path);
    if (rows.length) return rows;
  }
  return [];
}

/** Every parseable `<script type="application/json|ld+json">` blob in the page. */
export function extractEmbeddedJson(html: string): unknown[] {
  const blobs: unknown[] = [];
  const re =
    /<script[^>]*\btype=["'](?:application\/json|application\/ld\+json)["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const parsed = tryParse(raw) ?? tryParse(decodeEntities(raw));
    if (parsed !== undefined) blobs.push(parsed);
  }
  return blobs;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // not JSON — another blob may hold the data
  }
}

/** Undo the handful of HTML entities some frameworks emit inside JSON blobs.
 * Only used as a fallback after a raw parse fails, so it can't corrupt valid JSON. */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Resolve a possibly-relative URL against the page it was scraped from. */
export function absolutize(url: string, base: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url; // base had unrendered template vars or url is already absolute-ish
  }
}

function dedupById(refs: InvoiceRef[]): InvoiceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!ref.vendorInvoiceId || seen.has(ref.vendorInvoiceId)) return false;
    seen.add(ref.vendorInvoiceId);
    return true;
  });
}
