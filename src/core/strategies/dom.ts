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
import type {
  DomContinuationSpec,
  DomInvoices,
  DomStep,
  InvoiceMetadataEvidence,
  InvoiceRef,
  RetrievalProof,
  ReplayTrace,
  VendorRecipe,
} from "../types";
import type { RawDocument, Strategy } from "../engine";
import { DocumentInvalid, DocumentNotFound, DocumentTooLarge, SelectorMiss, UnexpectedResponse } from "../errors";
import { preferDocumentUrl } from "../document-candidate";
import { render } from "../template";
import { createInvoiceListResult } from "../retrieval";
import { MAX_DOCUMENT_BYTES } from "../document-size";
import { resolveInvoiceMetadata } from "../invoice-metadata";
import { assertSafeRenderedDiscoveredDomOpen } from "../discovery";

export interface DomDocumentObservation {
  url: string;
  evidence: InvoiceMetadataEvidence[];
}

export interface DomDocumentAction {
  /** Stable, supplier-scoped identity derived before the action executes. */
  vendorInvoiceId: string;
  /** Random, run-scoped capability. It is meaningful only to this driver instance. */
  handle: string;
  evidence?: InvoiceMetadataEvidence[];
}

export interface DomDriverRunResult {
  collected: Record<string, string[]>;
  documents?: DomDocumentObservation[];
  actions?: DomDocumentAction[];
  retrieval: RetrievalProof;
  replay?: ReplayTrace;
}

export type DomResolvedDocument =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: ArrayBuffer; contentType: string };

/** Implemented by the platform, backed by a real browser tab. */
export interface DomDriver {
  /** Open `url`, run `steps`, and return the variables collected by `extractAll`. */
  run(url: string, steps: DomStep[], continuation?: DomContinuationSpec): Promise<DomDriverRunResult>;
  /** Resolve one previously enumerated semantic action after the engine owns its identity claim. */
  resolve?(handle: string, signal?: AbortSignal): Promise<DomResolvedDocument>;
  /** Fetch a URL as bytes using the live session (delegates to credentialed fetch). */
  download(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }>;
  dispose?(): Promise<void>;
}

const DEFAULT_FILENAME = "{vendorId}-{issuedAt}-{vendorInvoiceId}.pdf";

export function makeDomStrategy(driver: DomDriver): Strategy {
  return {
    async list(recipe, vars, _ctx) {
      const spec = (recipe.invoices as DomInvoices).list;
      const open = render(spec.open, vars);
      assertSafeRenderedDiscoveredDomOpen(recipe, spec.open, open);
      const { collected, documents = [], actions = [], retrieval, replay } = await driver.run(open, spec.steps, spec.continuation);
      const hrefs = collected[spec.hrefsFrom];
      if (!hrefs) throw new SelectorMiss(`DOM step never collected "${spec.hrefsFrom}"`, recipe.id);
      const evidenceByUrl = new Map<string, InvoiceMetadataEvidence[]>();
      for (const document of documents) {
        const key = canonicalDocumentHref(document.url);
        evidenceByUrl.set(key, [
          ...(evidenceByUrl.get(key) ?? []),
          ...document.evidence,
        ].slice(0, 32));
      }

      const refs = new Map<string, { ref: InvoiceRef; legacyVendorInvoiceId: string }>();
      for (const href of hrefs) {
        const identity = canonicalDocumentHref(href);
        const vendorInvoiceId = await idFromHref(href);
        const legacyVendorInvoiceId = await legacyIdFromHref(href);
        const candidate: InvoiceRef = {
          vendorInvoiceId,
          documentUrl: href,
          ...(evidenceByUrl.get(identity)?.length
            ? { metadataEvidence: evidenceByUrl.get(identity) }
            : {}),
        };
        const existing = refs.get(identity);
        refs.set(identity, existing
          ? {
              ...existing,
              ref: {
                ...existing.ref,
                documentUrl: preferDocumentUrl(existing.ref.documentUrl, candidate.documentUrl),
                metadataEvidence: [
                  ...(existing.ref.metadataEvidence ?? []),
                  ...(candidate.metadataEvidence ?? []),
                ].slice(0, 32),
              },
            }
          : { ref: candidate, legacyVendorInvoiceId });
      }
      const legacyCounts = new Map<string, number>();
      for (const { legacyVendorInvoiceId } of refs.values()) {
        legacyCounts.set(legacyVendorInvoiceId, (legacyCounts.get(legacyVendorInvoiceId) ?? 0) + 1);
      }
      const uniqueLinks = [...refs.values()].map(({ ref, legacyVendorInvoiceId }) => (
        legacyVendorInvoiceId === ref.vendorInvoiceId || legacyCounts.get(legacyVendorInvoiceId) !== 1
          ? ref
          : { ...ref, identityAliases: [legacyVendorInvoiceId] }
      ));
      const actionRefs = actions.map((action): InvoiceRef => ({
        vendorInvoiceId: action.vendorInvoiceId,
        resolution: { kind: "semantic_action", handle: action.handle },
        ...(action.evidence?.length ? { metadataEvidence: action.evidence } : {}),
      }));
      const identities = new Set<string>();
      const unique = [...uniqueLinks, ...actionRefs].filter((ref) => {
        if (identities.has(ref.vendorInvoiceId)) return false;
        identities.add(ref.vendorInvoiceId);
        return true;
      });
      return createInvoiceListResult(unique, {
        ...retrieval,
        // The driver observes raw controls/links. Multiple presentation URLs
        // can intentionally resolve to one canonical document, so the proof
        // counts unique document identities plus genuinely unresolved values.
        observedItems: unique.length + retrieval.unresolvedItems,
        resolvedItems: unique.length,
        unresolvedItems: retrieval.unresolvedItems,
      }, replay);
    },

    async fetchDocument(recipe, ref, _vars, _ctx, signal): Promise<RawDocument> {
      let materialized: { bytes: ArrayBuffer; contentType: string };
      if (ref.resolution?.kind === "semantic_action") {
        if (!driver.resolve) throw new DocumentNotFound(ref.vendorInvoiceId, recipe.id);
        const resolved = await driver.resolve(ref.resolution.handle, signal);
        materialized = resolved.kind === "bytes"
          ? { bytes: resolved.bytes, contentType: resolved.contentType }
          : await driver.download(resolved.url);
      } else {
        if (!ref.documentUrl) throw new DocumentNotFound(ref.vendorInvoiceId, recipe.id);
        materialized = await driver.download(ref.documentUrl);
      }
      const { bytes, contentType } = materialized;
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentTooLarge(MAX_DOCUMENT_BYTES, recipe.id);
      if (bytes.byteLength === 0) throw new UnexpectedResponse(200, "empty document", recipe.id);
      const head = new Uint8Array(bytes.slice(0, 4));
      const looksPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
      const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
      // Treat MIME as advisory. Signed/object-storage URLs frequently return
      // application/octet-stream even though their bytes are a valid PDF.
      if (!looksPdf) {
        throw new DocumentInvalid(200, normalizedType, recipe.id);
      }
      const metadata = resolveInvoiceMetadata(ref);
      const inferredFilename = render((recipe.invoices as DomInvoices).document.filename ?? DEFAULT_FILENAME, {
        vendorId: recipe.id,
        issuedAt: metadata.issuedAt ?? "unknown",
        vendorInvoiceId: ref.vendorInvoiceId,
      });
      const filename = metadata.filename ?? inferredFilename;
      return { bytes, contentType: "application/pdf", filename };
    },

    async dispose(): Promise<void> {
      await driver.dispose?.();
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

async function idFromHref(href: string): Promise<string> {
  return idFromCanonicalHref(canonicalDocumentHref(href));
}

async function legacyIdFromHref(href: string): Promise<string> {
  return legacyIdFromCanonicalHref(legacyCanonicalDocumentHref(href));
}

async function idFromCanonicalHref(href: string): Promise<string> {
  const legacy = await legacyIdFromCanonicalHref(href);
  if (legacy.startsWith("document-")) return legacy;
  return `${legacy}-${await shortHrefDigest(href)}`;
}

async function legacyIdFromCanonicalHref(href: string): Promise<string> {
  const last = href.split("?")[0].split("/").filter(Boolean).pop();
  const normalized = last?.replace(/\.pdf$/i, "");
  if (normalized && normalized.length > 3 && !/^(?:download|document|file|invoice|pdf|receipt|view)$/i.test(normalized)) {
    return normalized;
  }
  return `document-${await shortHrefDigest(href)}`;
}

async function shortHrefDigest(href: string): Promise<string> {
  const material = new TextEncoder().encode(href);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalDocumentHref(href: string): string {
  try {
    const url = new URL(href);
    url.pathname = url.pathname.replace(/\.pdf$/i, "");
    url.hash = "";
    const queryKeys = [...url.searchParams.keys()];
    const hasStableQueryIdentity = queryKeys.some((key) => !isVolatileDocumentQueryKey(key));
    if (hasStablePathIdentity(url.pathname) || hasStableQueryIdentity) {
      for (const key of queryKeys) {
        if (isVolatileDocumentQueryKey(key)) url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return href.replace(/\.pdf(?=\?|#|$)/i, "").replace(/#.*$/, "");
  }
}

function hasStablePathIdentity(pathname: string): boolean {
  const last = pathname.split("/").filter(Boolean).pop()?.replace(/\.pdf$/i, "");
  return Boolean(last && last.length > 3 && !/^(?:download|document|file|invoice|pdf|receipt|view)$/i.test(last));
}

function legacyCanonicalDocumentHref(href: string): string {
  try {
    const url = new URL(href);
    url.pathname = url.pathname.replace(/\.pdf$/i, "");
    url.hash = "";
    return url.toString();
  } catch {
    return href.replace(/\.pdf(?=\?|#|$)/i, "").replace(/#.*$/, "");
  }
}

function isVolatileDocumentQueryKey(key: string): boolean {
  return /^(?:x-amz-|x-goog-|signature$|sig$|expires?$|token$|policy$|key-pair-id$|response-content-)/i.test(key);
}
