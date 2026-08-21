import type {
  DomContinuationSpec,
  DomStep,
  InvoiceMetadataEvidence,
  VendorRecipe,
} from "../../../src/core/types";
import type {
  DomDocumentObservation,
  DomDocumentAction,
  DomDriver,
  DomDriverRunResult,
} from "../../../src/core/strategies/dom";
import {
  AuthExpired,
  AuthFailure,
  DocumentActionFailed,
  DocumentPermissionRequired,
  DomActionFailed,
  SelectorMiss,
  UnexpectedResponse,
} from "../../../src/core/errors";
import { readDocumentBytes } from "../../../src/core/document-size";
import { exactPublicHttpsOriginPattern } from "../../../src/core/origin-policy";
import { PageFetcher } from "./page-fetch";
import { createRetrievalProof } from "../../../src/core/retrieval";
import {
  DOM_CONTINUATION_LABEL_PATTERN,
  normalizeDomContinuation,
  safeContinuationUrl,
} from "./dom-continuation";
import {
  DISCOVERY_DOM_POLICY,
  isSafeSemanticInvoiceSection,
} from "./discovery-dom-policy";
import { acquireForegroundTabVisibility, type ReleaseForegroundTab } from "./tab-visibility";
import {
  DocumentActionController,
  type SemanticDocumentActionReference,
} from "./document-action-controller";
export { parseDomAdvanceResult } from "./document-action-controller";

type DomRunErrorCode = "auth_expired" | "blocked_or_challenged" | "selector_miss" | "action_failed";
type DomPageRetrievalEvidence = { observedItems: number; resolvedItems: number; unresolvedItems: number };
type PageDomRunResult =
  | {
      ok: true;
      collected: Record<string, string[]>;
      documents?: DomDocumentObservation[];
      actions?: SemanticDocumentActionReference[];
      retrieval: DomPageRetrievalEvidence;
      timedOut?: boolean;
      actionCapReached?: boolean;
    }
  | { ok: false; code: DomRunErrorCode; error: string };
const INLINE_PDF_PREFIX = "data:application/pdf;base64,";
const MAX_INLINE_PDF_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_PDF_TOTAL_BYTES = 24 * 1024 * 1024;
const INLINE_DOCUMENT_ORIGIN = "https://inline.ratatosk.invalid";
export function isSafeInvoiceSectionLabel(value: string): boolean {
  return isSafeSemanticInvoiceSection(value);
}

/**
 * Execute the closed DOM-step vocabulary in a real supplier tab.
 *
 * Discovered recipes and packaged recipes use the same action-free listing
 * vocabulary. Returned values are untrusted, bounded, and converted to
 * absolute HTTPS URLs before crossing the boundary.
 */
export class BrowserDomDriver implements DomDriver {
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly actionController: DocumentActionController;
  private readonly semanticActions = new Map<string, {
    pageUrl: string;
    actionId: string;
    continuationActions: number;
    documentSelector: string;
    allowScroll: boolean;
  }>();
  /** Run-namespaced owners keep earlier scope results available until each URL
   * is consumed, without sharing one run's byte/document budget with another. */
  private readonly inlineDocumentOwners = new Map<string, InlineDocumentStore>();

  constructor(
    private readonly recipe: VendorRecipe,
    private readonly createInlineDocumentStore: () => InlineDocumentStore = () => new InlineDocumentStore(),
    onSemanticDocumentAction: () => void = () => undefined,
  ) {
    this.allowedOrigins = new Set(recipe.hosts.map((host) => new URL(host.slice(0, -2)).origin));
    this.actionController = new DocumentActionController(
      this.allowedOrigins,
      recipe.id,
      onSemanticDocumentAction,
    );
  }

  async run(url: string, steps: DomStep[], continuation?: DomContinuationSpec): Promise<DomDriverRunResult> {
    const inlineDocuments = this.createInlineDocumentStore();
    const page = new URL(url);
    const usesSemanticActions = steps.some((step) => step.action === "extractSemanticDownloads");
    const policy = continuation ? normalizeDomContinuation(continuation) : undefined;
    const pageObserver = usesSemanticActions
      ? await this.actionController.registerPageObserver(page.origin)
      : undefined;
    let exactTab: { tabId: number; created: boolean } | undefined;
    let releaseForegroundTab: ReleaseForegroundTab = async () => undefined;
    try {
      if (usesSemanticActions) {
        // Some browser applications defer or omit their billing UI when the
        // initial navigation happens in a background tab. Create a harmless
        // shell first, foreground it, and only then navigate to the supplier.
        // The document-start observer is already registered for that later
        // navigation.
        const shellDeadline = Date.now() + 20_000;
        const shell = await withinRunDeadline(
          chrome.tabs.create({ url: "about:blank", active: false }),
          shellDeadline,
        );
        if (shell.id == null) throw new Error("could not open the supplier billing page");
        exactTab = { tabId: shell.id, created: true };
        releaseForegroundTab = await acquireForegroundTabVisibility(shell.id);

        // Navigation and action execution are independently bounded. Slow SPA
        // startup must not consume the semantic-control budget.
        const navigationDeadline = Date.now() + Math.max(20_000, policy?.timeoutMs ?? 0);
        await withinRunDeadline(
          chrome.tabs.update(shell.id, { url: page.toString(), active: true }),
          navigationDeadline,
        );
        // tabs.update can briefly return the completed about:blank document
        // even though the requested navigation has only just started. Require
        // the supplier document to commit before injecting any action code.
        await waitForSupplierTabCommit(
          shell.id,
          page.toString(),
          remainingRunMs(navigationDeadline),
        );
      } else {
        const navigationDeadline = Date.now() + Math.max(20_000, policy?.timeoutMs ?? 0);
        exactTab = await ensureExactTab(
          page,
          requiresDisposableDomTab(steps, continuation),
          navigationDeadline,
        );
      }
    } catch (error) {
      await releaseForegroundTab();
      await pageObserver?.dispose(exactTab?.tabId);
      if (exactTab?.created) await chrome.tabs.remove(exactTab.tabId).catch(() => undefined);
      throw error;
    }
    if (!exactTab) throw new Error("could not open the supplier billing page");
    const { tabId, created } = exactTab;
    const aggregate: Record<string, Set<string>> = {};
    const documentEvidence = new Map<string, InvoiceMetadataEvidence[]>();
    const semanticActions = new Map<string, DomDocumentAction>();
    const documentStep = steps.find((step) =>
      (step.action === "extractAll" && step.attr === "href") || step.action === "extractSemanticDownloads");
    const documentKey = documentStep?.action === "extractAll" || documentStep?.action === "extractSemanticDownloads"
      ? documentStep.as
      : undefined;
    if (documentKey) aggregate[documentKey] = new Set<string>();
    const documentSelector = documentStep?.action === "extractAll"
      ? documentStep.selector
      : 'a[href],a:not([href]),button,[role="button"],[role="menuitem"],input[type="button"],input[type="submit"],[data-href],[data-url]';
    const visited = new Set<string>([`${page.origin}${page.pathname}${page.search}`]);
    let pagesVisited = 0;
    let observedItems = 0;
    let resolvedItems = 0;
    let unresolvedItems = 0;
    let termination: "explicit_end" | "continuation_failed" | "repeated_state" | "action_cap" | "document_cap" | "time_cap" = "explicit_end";
    let startedAt = Date.now();
    let runDeadline: number | null = null;
    try {
      startedAt = Date.now();
      runDeadline = policy ? startedAt + policy.timeoutMs : null;
      for (let action = 0; ; action += 1) {
        if (runDeadline !== null && Date.now() >= runDeadline) {
          termination = "time_cap";
          break;
        }
        pagesVisited += 1;
        let injection: chrome.scripting.InjectionResult<PageDomRunResult> | undefined;
        let result: PageDomRunResult;
        try {
          // Let the injected page return its completed structural proof before
          // the service-worker watchdog rejects the executeScript promise.
          const pageRunDeadline = runDeadline === null ? null : Math.max(Date.now(), runDeadline - 750);
          if (usesSemanticActions) {
            const semanticStep = steps.find((step) => step.action === "extractSemanticDownloads");
            if (!semanticStep || steps.some((step) => step.action !== "extractSemanticDownloads")) {
              throw new DomActionFailed("semantic enumeration cannot mix DOM step kinds", this.recipe.id);
            }
            const semantic = await this.actionController.enumerateOnTab(
              tabId,
              semanticStep.maxActions ?? 8,
              DISCOVERY_DOM_POLICY,
              pageRunDeadline,
            );
            result = {
              ok: true,
              collected: { [semanticStep.as]: semantic.directDocuments.map((document) => document.url) },
              documents: semantic.directDocuments,
              actions: semantic.actions,
              retrieval: {
                observedItems: semantic.observedItems,
                resolvedItems: semantic.resolvedItems,
                unresolvedItems: semantic.unresolvedItems,
              },
              ...(semantic.truncated ? { actionCapReached: true } : {}),
            };
          } else {
            [injection] = await withinRunDeadline(chrome.scripting.executeScript({
              target: { tabId },
              world: "ISOLATED",
              func: runDomStepsInPage,
              args: [steps, [...this.allowedOrigins], DISCOVERY_DOM_POLICY, pageRunDeadline],
            }), runDeadline);
            result = parseDomRunResult(injection?.result, this.allowedOrigins);
          }
        } catch (error) {
          if (error instanceof DomRunDeadlineExceeded) {
            termination = "time_cap";
            break;
          }
          if (error instanceof DocumentPermissionRequired) throw error;
          throw error;
        }
        if (!result.ok) throwDomRunError(result.code, this.recipe.id);
        observedItems += result.retrieval.observedItems;
        resolvedItems += result.retrieval.resolvedItems;
        unresolvedItems += result.retrieval.unresolvedItems;
        const maximumDocuments = policy?.maxDocuments ?? 500;
        const materialized = await this.materializeInlineDocuments(inlineDocuments, result.collected, maximumDocuments);
        resolvedItems = Math.max(0, resolvedItems - materialized.rejected);
        unresolvedItems += materialized.rejected;
        mergeCollected(aggregate, materialized.collected, maximumDocuments);
        mergeDocumentObservations(documentEvidence, result.documents ?? [], maximumDocuments);
        if (usesSemanticActions && result.actions?.length) {
          const tab = await chrome.tabs.get(tabId);
          const actionPage = tab.url ? new URL(tab.url) : page;
          if (actionPage.origin !== page.origin) {
            throw new DomActionFailed("semantic action page left the approved origin", this.recipe.id);
          }
          for (const actionRef of result.actions) {
            if (semanticActions.has(actionRef.vendorInvoiceId)) {
              throw new DocumentActionFailed("document_action_ambiguous", this.recipe.id);
            }
            const handle = crypto.randomUUID();
            this.semanticActions.set(handle, {
              pageUrl: page.toString(),
              actionId: actionRef.actionId,
              continuationActions: action,
              documentSelector,
              allowScroll: policy?.allowScroll ?? false,
            });
            semanticActions.set(actionRef.vendorInvoiceId, {
              vendorInvoiceId: actionRef.vendorInvoiceId,
              handle,
              evidence: actionRef.evidence,
            });
          }
        }
        if (result.timedOut) {
          termination = "time_cap";
          break;
        }
        if (result.actionCapReached) {
          termination = "action_cap";
          break;
        }

        if (!policy || !documentStep) break;
        if (action >= policy.maxActions) {
          termination = "action_cap";
          break;
        }
        if (Date.now() - startedAt >= policy.timeoutMs) {
          termination = "time_cap";
          break;
        }
        if (collectedSize(aggregate) >= policy.maxDocuments || inlineDocuments.exhausted) {
          termination = "document_cap";
          break;
        }

        try {
          const advance = await this.actionController.advanceOnTab(
            tabId,
            documentSelector,
            policy.allowScroll,
            DOM_CONTINUATION_LABEL_PATTERN,
            Math.max(0, Math.min(5_000, remainingRunMs(runDeadline))),
            runDeadline,
          );
          if (advance.kind === "exhausted") break;
          if (advance.kind === "failed") {
            termination = "continuation_failed";
            break;
          }
          if (advance.kind === "navigate") {
            const next = safeContinuationUrl(advance.url, page.origin);
            if (!next || visited.has(next)) {
              termination = "repeated_state";
              break;
            }
            visited.add(next);
            const updated = await withinRunDeadline(chrome.tabs.update(tabId, { url: next, active: true }), runDeadline);
            if (updated.status !== "complete") {
              await waitForTabComplete(tabId, Math.min(8_000, remainingRunMs(runDeadline)));
            }
          }
        } catch (error) {
          if (!(error instanceof DomRunDeadlineExceeded)) throw error;
          termination = "time_cap";
          break;
        }
      }
      return {
        collected: Object.fromEntries(Object.entries(aggregate).map(([key, values]) => [key, [...values]])),
        documents: [...documentEvidence].map(([url, evidence]) => ({ url, evidence })),
        actions: [...semanticActions.values()],
        retrieval: createRetrievalProof({
          termination,
          pagesVisited,
          observedItems,
          resolvedItems,
          unresolvedItems,
        }),
      };
    } finally {
      await releaseForegroundTab();
      await pageObserver?.dispose(tabId);
      if (created) await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  }

  async resolve(handle: string, signal?: AbortSignal): Promise<{ kind: "url"; url: string } | { kind: "bytes"; bytes: ArrayBuffer; contentType: string }> {
    const action = this.semanticActions.get(handle);
    if (!action) throw new DomActionFailed("semantic document action is no longer available", this.recipe.id);
    this.semanticActions.delete(handle);
    const resolved = await this.actionController.resolve(
      action.pageUrl,
      action.actionId,
      DISCOVERY_DOM_POLICY,
      signal,
      {
        continuationActions: action.continuationActions,
        documentSelector: action.documentSelector,
        allowScroll: action.allowScroll,
        labelPattern: DOM_CONTINUATION_LABEL_PATTERN,
      },
    );
    if (resolved.kind === "url") return resolved;
    const materialized = await materializeInlinePdfDataUrl(resolved.dataUrl);
    if (!materialized) throw new DomActionFailed("semantic action returned an invalid document", this.recipe.id);
    return { kind: "bytes", bytes: materialized.bytes, contentType: "application/pdf" };
  }

  async dispose(): Promise<void> {
    this.semanticActions.clear();
    this.inlineDocumentOwners.clear();
  }

  async download(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const owner = this.inlineDocumentOwners.get(url);
    const inline = owner?.take(url);
    if (inline) this.inlineDocumentOwners.delete(url);
    if (inline) return { bytes: inline.slice(0), contentType: "application/pdf" };
    const fetcher = new PageFetcher(this.recipe, { semanticActionDocuments: true });
    try {
      const response = await fetcher.fetch({ url }, {});
      if (!response.ok) {
        throw new UnexpectedResponse(
          response.status,
          "DOM document download failed",
          this.recipe.id,
          response.headers.get("content-type") ?? undefined,
        );
      }
      return {
        bytes: await readDocumentBytes(response, this.recipe.id),
        contentType: response.headers.get("content-type") ?? "",
      };
    } finally {
      await fetcher.dispose();
    }
  }

  private async materializeInlineDocuments(
    inlineDocuments: InlineDocumentStore,
    collected: Record<string, string[]>,
    maximumDocuments: number,
  ): Promise<{ collected: Record<string, string[]>; rejected: number }> {
    const materialized: Record<string, string[]> = {};
    let rejected = 0;
    for (const [key, values] of Object.entries(collected)) {
      const documents: string[] = [];
      for (const value of values) {
        if (!value.startsWith(INLINE_PDF_PREFIX)) {
          documents.push(value);
          continue;
        }
        const admitted = await inlineDocuments.add(value, maximumDocuments);
        if (admitted) {
          documents.push(admitted);
          this.inlineDocumentOwners.set(admitted, inlineDocuments);
        }
        else rejected += 1;
      }
      materialized[key] = documents;
    }
    return { collected: materialized, rejected };
  }
}

export function requiresDisposableDomTab(steps: readonly DomStep[], continuation: DomContinuationSpec | undefined): boolean {
  return continuation !== undefined || steps.some((step) => (
    step.action === "extractSemanticDownloads"
  ));
}

/** One bounded store per driver/vendor run. Per-page parsing still rejects an
 * oversized response; this store prevents continuation passes from accumulating
 * more retained PDF bytes than the service worker can safely hold. */
export class InlineDocumentStore {
  private readonly documents = new Map<string, ArrayBuffer>();
  private bytes = 0;
  private limitReached = false;

  constructor(
    private readonly maximumBytes = MAX_INLINE_PDF_TOTAL_BYTES,
    private readonly maximumDocuments = 500,
    private readonly namespace = crypto.randomUUID(),
  ) {}

  get retainedBytes(): number { return this.bytes; }
  get exhausted(): boolean { return this.limitReached; }

  get(url: string): ArrayBuffer | undefined {
    return this.documents.get(url)?.slice(0);
  }

  take(url: string): ArrayBuffer | undefined {
    const bytes = this.documents.get(url);
    if (!bytes) return undefined;
    this.documents.delete(url);
    this.bytes -= bytes.byteLength;
    return bytes.slice(0);
  }

  async add(value: string, runDocumentLimit = this.maximumDocuments): Promise<string | undefined> {
    const inline = await materializeInlinePdfDataUrl(value, this.namespace);
    if (!inline) return undefined;
    if (this.documents.has(inline.url)) return inline.url;
    const documentLimit = Math.max(0, Math.min(this.maximumDocuments, runDocumentLimit));
    if (
      this.documents.size >= documentLimit ||
      this.bytes + inline.bytes.byteLength > this.maximumBytes
    ) {
      this.limitReached = true;
      return undefined;
    }
    this.documents.set(inline.url, inline.bytes);
    this.bytes += inline.bytes.byteLength;
    return inline.url;
  }
}

export function parseDomRunResult(
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
  allowActionDocumentOrigins = false,
): PageDomRunResult {
  const invalid = (): never => { throw new Error("supplier DOM result is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  if (raw.ok === false) {
    if (!["auth_expired", "blocked_or_challenged", "selector_miss", "action_failed"].includes(String(raw.code))) return invalid();
    return { ok: false, code: raw.code as DomRunErrorCode, error: "supplier page inspection failed" };
  }
  if (
    raw.ok !== true || !raw.collected || typeof raw.collected !== "object" || Array.isArray(raw.collected) ||
    !raw.retrieval || typeof raw.retrieval !== "object" || Array.isArray(raw.retrieval)
  ) return invalid();
  const rawRetrieval = raw.retrieval as Record<string, unknown>;
  if (
    !boundedDomCount(rawRetrieval.observedItems) || !boundedDomCount(rawRetrieval.resolvedItems) ||
    !boundedDomCount(rawRetrieval.unresolvedItems)
  ) return invalid();
  const entries = Object.entries(raw.collected as Record<string, unknown>);
  if (entries.length > 8) return invalid();
  const collected: Record<string, string[]> = {};
  const requiredOrigins = new Set<string>();
  let total = 0;
  let inlineBytes = 0;
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(key) || !Array.isArray(item) || item.length > 500) return invalid();
    const values: string[] = [];
    for (const candidate of item) {
      if (typeof candidate !== "string") return invalid();
      const inline = decodeInlinePdfDataUrl(candidate);
      if (inline) {
        inlineBytes += inline.byteLength;
        if (inlineBytes > MAX_INLINE_PDF_TOTAL_BYTES) return invalid();
        values.push(candidate);
        total++;
        if (total > 500) return invalid();
        continue;
      }
      if (candidate.length > 2_048) return invalid();
      let url: URL;
      try { url = new URL(candidate); } catch { return invalid(); }
      if (url.protocol !== "https:" || url.username || url.password) return invalid();
      if (!allowedOrigins.has(url.origin)) {
        if (!allowActionDocumentOrigins) return invalid();
        let origin: string;
        try { origin = exactPublicHttpsOriginPattern(url.origin); } catch { return invalid(); }
        requiredOrigins.add(origin);
        if (requiredOrigins.size > 4) return invalid();
        continue;
      }
      values.push(url.toString());
      total++;
      if (total > 500) return invalid();
    }
    collected[key] = [...new Set(values)];
  }
  const documents = parseDocumentObservations(raw.documents, collected, allowedOrigins);
  if (requiredOrigins.size) {
    throw new DocumentPermissionRequired("semantic_action", [...requiredOrigins]);
  }
  return {
    ok: true,
    collected,
    ...(documents.length ? { documents } : {}),
    ...(raw.timedOut === true ? { timedOut: true } : {}),
    retrieval: {
      observedItems: Number(rawRetrieval.observedItems),
      resolvedItems: Number(rawRetrieval.resolvedItems),
      unresolvedItems: Number(rawRetrieval.unresolvedItems),
    },
  };
}

function parseDocumentObservations(
  raw: unknown,
  collected: Record<string, string[]>,
  allowedOrigins: ReadonlySet<string>,
): DomDocumentObservation[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 500) throw new Error("supplier DOM result is invalid");
  const collectedUrls = new Set(Object.values(collected).flat());
  const result: DomDocumentObservation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("supplier DOM result is invalid");
    const observation = item as Record<string, unknown>;
    if (typeof observation.url !== "string" || !collectedUrls.has(observation.url)) continue;
    const inline = decodeInlinePdfDataUrl(observation.url);
    if (!inline) {
      let url: URL;
      try { url = new URL(observation.url); } catch { throw new Error("supplier DOM result is invalid"); }
      if (url.protocol !== "https:" || !allowedOrigins.has(url.origin)) continue;
    }
    if (!Array.isArray(observation.evidence) || observation.evidence.length > 8) {
      throw new Error("supplier DOM result is invalid");
    }
    const evidence = observation.evidence.map(parseMetadataEvidence);
    if (evidence.length) result.push({ url: observation.url, evidence });
  }
  return result;
}

function parseMetadataEvidence(raw: unknown): InvoiceMetadataEvidence {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("supplier DOM result is invalid");
  const value = raw as Record<string, unknown>;
  if (
    !["network", "embedded", "dom-row", "download-filename", "content-disposition", "document-url"].includes(String(value.source)) ||
    !["high", "medium", "low"].includes(String(value.confidence))
  ) throw new Error("supplier DOM result is invalid");
  const result: InvoiceMetadataEvidence = {
    source: value.source as InvoiceMetadataEvidence["source"],
    confidence: value.confidence as InvoiceMetadataEvidence["confidence"],
  };
  for (const field of ["invoiceNumber", "issuedAt", "total", "currency", "filename"] as const) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.length > 240) throw new Error("supplier DOM result is invalid");
    result[field] = candidate;
  }
  return result;
}

function boundedDomCount(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
}

/** Decode only a bounded, magic-checked PDF data URL produced by the semantic
 * action capture. Other data URLs remain invalid at the DOM trust boundary. */
export function decodeInlinePdfDataUrl(value: string): ArrayBuffer | undefined {
  if (!value.startsWith(INLINE_PDF_PREFIX)) return undefined;
  const encoded = value.slice(INLINE_PDF_PREFIX.length);
  if (!encoded || encoded.length > Math.ceil(MAX_INLINE_PDF_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return undefined;
  }
  let binary: string;
  try { binary = atob(encoded); } catch { return undefined; }
  if (binary.length === 0 || binary.length > MAX_INLINE_PDF_BYTES || !binary.startsWith("%PDF")) return undefined;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export async function materializeInlinePdfDataUrl(
  value: string,
  namespace?: string,
): Promise<{ url: string; bytes: ArrayBuffer } | undefined> {
  const bytes = decodeInlinePdfDataUrl(value);
  if (!bytes) return undefined;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const id = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const prefix = namespace ? `${encodeURIComponent(namespace)}/` : "";
  return { url: `${INLINE_DOCUMENT_ORIGIN}/${prefix}${id}.pdf`, bytes };
}
/** Self-contained function serialized into the supplier tab. */
export async function runDomStepsInPage(
  steps: DomStep[],
  allowedOrigins: string[],
  semanticPolicy: typeof DISCOVERY_DOM_POLICY,
  runDeadline: number | null,
): Promise<PageDomRunResult> {
  const collected: Record<string, string[]> = {};
  const documents: DomDocumentObservation[] = [];
  let observedItems = 0;
  let resolvedItems = 0;
  let unresolvedItems = 0;
  const documentNumberHeader = new RegExp(semanticPolicy.documentNumberPattern, "i");
  const result = (timedOut = false): PageDomRunResult => ({
    ok: true,
    collected,
    ...(documents.length ? { documents } : {}),
    retrieval: { observedItems, resolvedItems, unresolvedItems },
    ...(timedOut ? { timedOut: true } : {}),
  });
  const waitFor = async (selector: string, timeoutMs: number): Promise<Element | null> => {
    const requestedDeadline = Date.now() + Math.min(10_000, Math.max(0, timeoutMs));
    const deadline = runDeadline === null ? requestedDeadline : Math.min(requestedDeadline, runDeadline);
    do {
      const found = document.querySelector(selector);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return null;
  };

  try {
    for (const step of steps.slice(0, 20)) {
      if (runDeadline !== null && Date.now() >= runDeadline) return result(true);
      if (step.action === "waitFor") {
        if (!(await waitFor(step.selector, step.timeoutMs ?? 8_000))) {
          if (runDeadline !== null && Date.now() >= runDeadline) return result(true);
          if (looksLoggedOut()) return { ok: false, code: "auth_expired", error: "supplier session is logged out" };
          if (looksChallenged()) return { ok: false, code: "blocked_or_challenged", error: "supplier challenge blocked the invoice list" };
          return { ok: false, code: "selector_miss", error: "invoice elements did not appear" };
        }
      } else if (step.action === "extractAll") {
        const values = new Set<string>();
        const observed = new Set<string>();
        for (const element of Array.from(document.querySelectorAll(step.selector)).slice(0, 500)) {
          const raw = element.getAttribute(step.attr);
          if (!raw) continue;
          observed.add(raw);
          try {
            let absolute = new URL(raw, location.href);
            const hostedInvoice = absolute.pathname.match(/^\/i\/([^/]+)\/([^/]+)$/);
            if (absolute.hostname === "invoice.stripe.com" && hostedInvoice) {
              absolute = new URL(`https://pay.stripe.com/invoice/${hostedInvoice[1]}/${hostedInvoice[2]}/pdf${absolute.search}`);
            }
            if (absolute.protocol === "https:") {
              const documentUrl = absolute.toString();
              values.add(documentUrl);
              const evidence = metadataForElement(element);
              if (evidence.length) documents.push({ url: documentUrl, evidence });
            }
          } catch {
            // A malformed page value is simply not a document candidate.
          }
        }
        observedItems += observed.size;
        resolvedItems += values.size;
        unresolvedItems += Math.max(0, observed.size - values.size);
        collected[step.as] = [...new Set([...(collected[step.as] ?? []), ...values])];
      } else {
        return { ok: false, code: "action_failed", error: "semantic document actions must be resolved transactionally" };
      }
    }
    return result(runDeadline !== null && Date.now() >= runDeadline);
  } catch {
    if (looksLoggedOut()) return { ok: false, code: "auth_expired", error: "supplier session is logged out" };
    if (looksChallenged()) return { ok: false, code: "blocked_or_challenged", error: "supplier challenge blocked invoice downloads" };
    return { ok: false, code: "action_failed", error: "supplier invoice action failed" };
  }

  function looksLoggedOut(): boolean {
    return Boolean(
      /(?:^|\/)(?:auth|login|log-in|signin|sign-in|sso)(?:\/|$)/i.test(location.pathname) ||
      document.querySelector('input[type="password"],input[autocomplete="current-password"]') ||
      document.querySelector('form[action*="login" i],form[action*="signin" i]'),
    );
  }

  function looksChallenged(): boolean {
    const candidates = Array.from(document.querySelectorAll(
      '[id*="challenge" i],[class*="challenge" i],iframe[src*="challenge" i],iframe[src*="captcha" i]',
    )).slice(0, 20);
    return candidates.some((candidate) => {
      const element = candidate as HTMLElement;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return !element.hidden &&
        element.getAttribute("aria-hidden") !== "true" &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        Number(style.opacity) !== 0 &&
        bounds.width >= 2 &&
        bounds.height >= 2;
    });
  }

  function metadataForElement(element: Element): InvoiceMetadataEvidence[] {
    const row = element.closest(semanticPolicy.rowSelector);
    if (!row) return [];
    let table = row.closest(semanticPolicy.tableSelector);
    for (let root = row.parentElement, depth = 0; !table && root && depth < 5; depth += 1, root = root.parentElement) {
      if (root.querySelector(semanticPolicy.headerRowSelector)) table = root;
    }
    const cells = Array.from(row.querySelectorAll(semanticPolicy.cellSelector));
    if (!cells.length) return [];
    const headers: string[] = [];
    if (table) {
      for (const headerRow of Array.from(table.querySelectorAll(semanticPolicy.headerRowSelector)).slice(0, 5)) {
        const found = Array.from(headerRow.querySelectorAll(semanticPolicy.headerCellSelector));
        if (found.length >= cells.length) {
          for (let index = 0; index < cells.length; index += 1) {
            headers[index] = (found[index]?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
          }
          break;
        }
      }
    }
    for (let index = 0; index < cells.length; index += 1) {
      headers[index] ||= (
        cells[index].getAttribute("aria-label") ||
        cells[index].getAttribute("data-label") ||
        cells[index].getAttribute("data-title") ||
        ""
      ).replace(/\s+/g, " ").trim().slice(0, 120);
    }
    const claim: InvoiceMetadataEvidence = { source: "dom-row", confidence: "high" };
    for (let index = 0; index < cells.length; index += 1) {
      const header = headers[index]?.toLowerCase() ?? "";
      if (!header) continue;
      const cell = cells[index];
      const text = (cell.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
      if (!text) continue;
      if (
        !claim.invoiceNumber &&
        documentNumberHeader.test(header)
      ) {
        claim.invoiceNumber = text;
      } else if (
        !claim.issuedAt &&
        !/(?:due|paid|period|service|subscription|renew)/i.test(header) &&
        /(?:invoice|receipt|issue|issued|created)?\s*date/i.test(header)
      ) {
        claim.issuedAt = structuredDate(cell, text);
      } else if (!claim.total && /^(?:total|amount|gross|invoice amount|amount paid|paid)$/i.test(header)) {
        const parsed = displayedAmount(text);
        if (parsed) {
          claim.total = parsed.total;
          if (parsed.currency) claim.currency = parsed.currency;
        }
      } else if (!claim.currency && /^(?:currency|ccy)$/i.test(header)) {
        const code = text.match(/\b[A-Za-z]{3}\b/)?.[0];
        if (code) claim.currency = code.toUpperCase();
      }
    }
    return Object.keys(claim).length > 2 ? [claim] : [];
  }

  function structuredDate(cell: Element, text: string): string | undefined {
    const raw = cell.querySelector("time[datetime]")?.getAttribute("datetime") || text;
    const iso = raw.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (iso) return validCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const dayFirst = raw.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
    if (dayFirst) {
      const first = Number(dayFirst[1]);
      const second = Number(dayFirst[2]);
      if (first > 12) return validCalendarDate(Number(dayFirst[3]), second, first);
      if (second > 12) return validCalendarDate(Number(dayFirst[3]), first, second);
      return undefined;
    }
    if (!/[A-Za-z]{3,}/.test(raw)) return undefined;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return validCalendarDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }

  function validCalendarDate(year: number, month: number, day: number): string | undefined {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      year < 2000 || year > 2100 ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) return undefined;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function displayedAmount(text: string): { total: string; currency?: string } | undefined {
    const explicitCode = text.match(/\b[A-Za-z]{3}\b/)?.[0]?.toUpperCase();
    const symbolCurrency = text.includes("€") ? "EUR" : text.includes("£") ? "GBP" : undefined;
    const currency = explicitCode && /^[A-Z]{3}$/.test(explicitCode) ? explicitCode : symbolCurrency;
    let numeric = text
      .replace(/\b[A-Za-z]{3}\b/g, "")
      .replace(/[€£$¥]/g, "")
      .replace(/[\s\u00a0']/g, "")
      .trim();
    if (!/^-?[\d.,]+$/.test(numeric)) return undefined;
    const comma = numeric.lastIndexOf(",");
    const dot = numeric.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? "," : ".";
      const thousands = decimal === "," ? /\./g : /,/g;
      numeric = numeric.replace(thousands, "").replace(decimal, ".");
    } else if (comma >= 0 || dot >= 0) {
      const separator = comma >= 0 ? "," : ".";
      const pieces = numeric.split(separator);
      if (pieces.length > 2) {
        if (!pieces.slice(1).every((piece) => piece.length === 3)) return undefined;
        numeric = pieces.join("");
      } else {
        const decimals = pieces[1]?.length ?? 0;
        if (decimals === 1 || decimals === 2) numeric = `${pieces[0]}.${pieces[1]}`;
        else if (decimals === 3) return undefined;
      }
    }
    if (!/^-?\d{1,18}(?:\.\d{1,6})?$/.test(numeric)) return undefined;
    return { total: numeric, ...(currency ? { currency } : {}) };
  }

}


function mergeCollected(target: Record<string, Set<string>>, source: Record<string, string[]>, maximum: number): void {
  for (const [key, values] of Object.entries(source)) {
    const bucket = (target[key] ??= new Set<string>());
    for (const value of values) {
      if (bucket.size >= maximum) break;
      bucket.add(value);
    }
  }
}

function mergeDocumentObservations(
  target: Map<string, InvoiceMetadataEvidence[]>,
  source: readonly DomDocumentObservation[],
  maximum: number,
): void {
  for (const observation of source) {
    if (!target.has(observation.url) && target.size >= maximum) break;
    const combined = [...(target.get(observation.url) ?? []), ...observation.evidence];
    target.set(observation.url, combined.filter((item, index, all) =>
      index === all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item))
    ).slice(0, 32));
  }
}

function collectedSize(collected: Record<string, Set<string>>): number {
  return Math.max(0, ...Object.values(collected).map((values) => values.size));
}

function throwDomRunError(code: DomRunErrorCode, vendorId: string): never {
  if (code === "auth_expired") throw new AuthExpired(vendorId);
  if (code === "blocked_or_challenged") throw new AuthFailure("blocked_or_challenged", vendorId);
  if (code === "action_failed") throw new DomActionFailed("invoice action did not produce a document", vendorId);
  throw new SelectorMiss("invoice elements did not appear", vendorId);
}

class DomRunDeadlineExceeded extends Error {}

function remainingRunMs(deadline: number | null): number {
  return deadline === null ? 20_000 : Math.max(0, deadline - Date.now());
}

function withinRunDeadline<T>(operation: Promise<T>, deadline: number | null): Promise<T> {
  if (deadline === null) return operation;
  const remaining = remainingRunMs(deadline);
  if (remaining <= 0) return Promise.reject(new DomRunDeadlineExceeded("DOM run deadline exceeded"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DomRunDeadlineExceeded("DOM run deadline exceeded")), remaining);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function ensureExactTab(
  target: URL,
  forceTemporary = false,
  runDeadline: number | null = null,
): Promise<{ tabId: number; created: boolean }> {
  const tabs = forceTemporary
    ? []
    : await withinRunDeadline(chrome.tabs.query({ url: `${target.origin}/*` }), runDeadline);
  const expected = `${target.origin}${target.pathname}${target.search}`;
  const existing = tabs.find((tab) => {
    if (tab.id == null || !tab.url) return false;
    try {
      const current = new URL(tab.url);
      return `${current.origin}${current.pathname}${current.search}` === expected;
    } catch {
      return false;
    }
  });
  if (existing?.id != null) {
    if (existing.status !== "complete") await waitForTabComplete(existing.id, remainingRunMs(runDeadline));
    return { tabId: existing.id, created: false };
  }

  const tab = await withinRunDeadline(chrome.tabs.create({ url: target.toString(), active: false }), runDeadline);
  if (tab.id == null) throw new Error("could not open the supplier billing page");
  try {
    await waitForTabComplete(tab.id, remainingRunMs(runDeadline));
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
    throw error;
  }
  return { tabId: tab.id, created: true };
}

function waitForTabComplete(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => done(new DomRunDeadlineExceeded("supplier page load timed out")), Math.max(0, timeoutMs));
    const onUpdated = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedId === tabId && info.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") done();
    }).catch(() => undefined);
  });
}

/**
 * Wait for a freshly created shell tab to commit the requested supplier page.
 *
 * The tab starts on about:blank, so only this run's navigation can put it on
 * the supplier origin. Single-page applications commonly rewrite the address
 * bar while keeping the requested surface mounted, so a completed document on
 * the requested origin is the commit signal. Any other origin is not.
 */
function waitForSupplierTabCommit(
  tabId: number,
  expectedUrl: string,
  timeoutMs = 20_000,
): Promise<void> {
  const expected = new URL(expectedUrl);
  const matches = (tab: chrome.tabs.Tab): boolean => {
    if (tab.status !== "complete" || !tab.url) return false;
    try {
      return new URL(tab.url).origin === expected.origin;
    } catch {
      return false;
    }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      error ? reject(error) : resolve();
    };
    const check = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        if (matches(await chrome.tabs.get(tabId))) done();
      } catch {
        // A later update may still commit the requested supplier document.
      } finally {
        checking = false;
      }
    };
    const timer = setTimeout(
      () => done(new DomRunDeadlineExceeded("supplier page navigation timed out")),
      Math.max(0, timeoutMs),
    );
    const onUpdated = (updatedId: number) => {
      if (updatedId === tabId) void check();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    void check();
  });
}
