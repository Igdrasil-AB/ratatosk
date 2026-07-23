import type { DomContinuationSpec, DomStep, VendorRecipe } from "../../../src/core/types";
import type { DomDriver, DomDriverRunResult } from "../../../src/core/strategies/dom";
import { AuthExpired, AuthFailure, SelectorMiss, UnexpectedResponse } from "../../../src/core/errors";
import { readDocumentBytes } from "../../../src/core/document-size";
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

type DomRunErrorCode = "auth_expired" | "blocked_or_challenged" | "selector_miss";
type DomPageRetrievalEvidence = { observedItems: number; resolvedItems: number; unresolvedItems: number };
type PageDomRunResult =
  | { ok: true; collected: Record<string, string[]>; retrieval: DomPageRetrievalEvidence; timedOut?: boolean }
  | { ok: false; code: DomRunErrorCode; error: string };
type DomAdvanceResult =
  | { kind: "navigate"; url: string }
  | { kind: "advanced" }
  | { kind: "failed" }
  | { kind: "exhausted" };

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
 * Discovered recipes are separately constrained to waitFor + href extraction;
 * reviewed packaged recipes may also use click. Returned values are untrusted,
 * bounded, and converted to absolute HTTPS URLs before crossing the boundary.
 */
export class BrowserDomDriver implements DomDriver {
  private readonly allowedOrigins: ReadonlySet<string>;
  /** Run-namespaced owners keep earlier scope results available until each URL
   * is consumed, without sharing one run's byte/document budget with another. */
  private readonly inlineDocumentOwners = new Map<string, InlineDocumentStore>();

  constructor(
    private readonly recipe: VendorRecipe,
    private readonly createInlineDocumentStore: () => InlineDocumentStore = () => new InlineDocumentStore(),
  ) {
    this.allowedOrigins = new Set(recipe.hosts.map((host) => new URL(host.slice(0, -2)).origin));
  }

  async run(url: string, steps: DomStep[], continuation?: DomContinuationSpec): Promise<DomDriverRunResult> {
    const inlineDocuments = this.createInlineDocumentStore();
    const page = new URL(url);
    const usesSemanticActions = steps.some((step) => step.action === "extractSemanticDownloads");
    const policy = continuation ? normalizeDomContinuation(continuation) : undefined;
    const startedAt = Date.now();
    const runDeadline = policy ? startedAt + policy.timeoutMs : null;
    const { tabId, created } = await ensureExactTab(
      page,
      requiresDisposableDomTab(steps, continuation),
      runDeadline,
    );
    const aggregate: Record<string, Set<string>> = {};
    const documentStep = steps.find((step) =>
      (step.action === "extractAll" && step.attr === "href") || step.action === "extractSemanticDownloads");
    const documentSelector = documentStep?.action === "extractAll"
      ? documentStep.selector
      : 'a[href],a:not([href]),button,[role="button"],[role="menuitem"],input[type="button"],input[type="submit"],[data-href],[data-url]';
    const visited = new Set<string>([`${page.origin}${page.pathname}${page.search}`]);
    let pagesVisited = 0;
    let observedItems = 0;
    let resolvedItems = 0;
    let unresolvedItems = 0;
    let termination: "explicit_end" | "continuation_failed" | "repeated_state" | "action_cap" | "document_cap" | "time_cap" = "explicit_end";
    let releaseForegroundTab: ReleaseForegroundTab = async () => undefined;
    try {
      if (usesSemanticActions) {
        try {
          releaseForegroundTab = await acquireForegroundTabVisibility(tabId);
        } catch {
          console.warn("[collector] semantic action visibility unavailable; continuing in the disposable tab");
        }
      }
      for (let action = 0; ; action += 1) {
        if (runDeadline !== null && Date.now() >= runDeadline) {
          termination = "time_cap";
          break;
        }
        pagesVisited += 1;
        let injection: chrome.scripting.InjectionResult<PageDomRunResult> | undefined;
        try {
          [injection] = await withinRunDeadline(chrome.scripting.executeScript({
            target: { tabId },
            world: usesSemanticActions ? "MAIN" : "ISOLATED",
            func: runDomStepsInPage,
            args: [steps, [...this.allowedOrigins], DISCOVERY_DOM_POLICY, runDeadline],
          }), runDeadline);
        } catch (error) {
          if (!(error instanceof DomRunDeadlineExceeded)) throw error;
          termination = "time_cap";
          break;
        }
        const result = parseDomRunResult(injection?.result, this.allowedOrigins);
        if (!result.ok) throwDomRunError(result.code, this.recipe.id);
        observedItems += result.retrieval.observedItems;
        resolvedItems += result.retrieval.resolvedItems;
        unresolvedItems += result.retrieval.unresolvedItems;
        const maximumDocuments = policy?.maxDocuments ?? 500;
        const materialized = await this.materializeInlineDocuments(inlineDocuments, result.collected, maximumDocuments);
        resolvedItems = Math.max(0, resolvedItems - materialized.rejected);
        unresolvedItems += materialized.rejected;
        mergeCollected(aggregate, materialized.collected, maximumDocuments);
        if (result.timedOut) {
          termination = "time_cap";
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

        let advanceInjection: chrome.scripting.InjectionResult<DomAdvanceResult> | undefined;
        try {
          [advanceInjection] = await withinRunDeadline(chrome.scripting.executeScript({
            target: { tabId },
            func: advanceDomPageInPage,
            args: [
              documentSelector,
              policy.allowScroll,
              DOM_CONTINUATION_LABEL_PATTERN,
              Math.max(0, Math.min(5_000, remainingRunMs(runDeadline))),
            ],
          }), runDeadline);
        } catch (error) {
          if (!(error instanceof DomRunDeadlineExceeded)) throw error;
          termination = "time_cap";
          break;
        }
        const advance = parseDomAdvanceResult(advanceInjection?.result);
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
          try {
            const updated = await withinRunDeadline(chrome.tabs.update(tabId, { url: next, active: false }), runDeadline);
            if (updated.status !== "complete") {
              await waitForTabComplete(tabId, Math.min(8_000, remainingRunMs(runDeadline)));
            }
          } catch (error) {
            if (!(error instanceof DomRunDeadlineExceeded)) throw error;
            termination = "time_cap";
            break;
          }
        }
      }
      return {
        collected: Object.fromEntries(Object.entries(aggregate).map(([key, values]) => [key, [...values]])),
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
      if (created) await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  }

  async download(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const owner = this.inlineDocumentOwners.get(url);
    const inline = owner?.take(url);
    if (inline) this.inlineDocumentOwners.delete(url);
    if (inline) return { bytes: inline.slice(0), contentType: "application/pdf" };
    const fetcher = new PageFetcher(this.recipe);
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
    step.action === "click" || step.action === "extractSemanticDownloads"
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

export function parseDomRunResult(value: unknown, allowedOrigins: ReadonlySet<string>): PageDomRunResult {
  const invalid = (): never => { throw new Error("supplier DOM result is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  if (raw.ok === false) {
    if (!["auth_expired", "blocked_or_challenged", "selector_miss"].includes(String(raw.code))) return invalid();
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
      if (url.protocol !== "https:" || url.username || url.password || !allowedOrigins.has(url.origin)) return invalid();
      values.push(url.toString());
      total++;
      if (total > 500) return invalid();
    }
    collected[key] = [...new Set(values)];
  }
  return {
    ok: true,
    collected,
    ...(raw.timedOut === true ? { timedOut: true } : {}),
    retrieval: {
      observedItems: Number(rawRetrieval.observedItems),
      resolvedItems: Number(rawRetrieval.resolvedItems),
      unresolvedItems: Number(rawRetrieval.unresolvedItems),
    },
  };
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

export function parseDomAdvanceResult(value: unknown): DomAdvanceResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("supplier continuation result is invalid");
  const raw = value as Record<string, unknown>;
  if (raw.kind === "advanced" || raw.kind === "failed" || raw.kind === "exhausted") return { kind: raw.kind };
  if (raw.kind === "navigate" && typeof raw.url === "string" && raw.url.length <= 1_200) {
    let url: URL;
    try { url = new URL(raw.url); } catch { throw new Error("supplier continuation result is invalid"); }
    if (url.protocol === "https:" && !url.username && !url.password) return { kind: "navigate", url: url.toString() };
  }
  throw new Error("supplier continuation result is invalid");
}

/** Self-contained function serialized into the supplier tab. */
export async function runDomStepsInPage(
  steps: DomStep[],
  allowedOrigins: string[],
  semanticPolicy: typeof DISCOVERY_DOM_POLICY,
  runDeadline: number | null,
): Promise<PageDomRunResult> {
  const collected: Record<string, string[]> = {};
  let observedItems = 0;
  let resolvedItems = 0;
  let unresolvedItems = 0;
  const result = (timedOut = false): PageDomRunResult => ({
    ok: true,
    collected,
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
      } else if (step.action === "click") {
        const element = document.querySelector(step.selector);
        if (!(element instanceof HTMLElement)) return { ok: false, code: "selector_miss", error: "invoice control was unavailable" };
        element.click();
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
            if (absolute.protocol === "https:") values.add(absolute.toString());
          } catch {
            // A malformed page value is simply not a document candidate.
          }
        }
        observedItems += observed.size;
        resolvedItems += values.size;
        unresolvedItems += Math.max(0, observed.size - values.size);
        collected[step.as] = [...new Set([...(collected[step.as] ?? []), ...values])];
      } else {
        if (looksLoggedOut()) return { ok: false, code: "auth_expired", error: "supplier session is logged out" };
        if (looksChallenged()) return { ok: false, code: "blocked_or_challenged", error: "supplier challenge blocked invoice downloads" };
        const semantic = await extractSemanticDownloads(step.maxActions ?? 8);
        observedItems += semantic.observedItems;
        resolvedItems += semantic.resolvedItems;
        unresolvedItems += semantic.unresolvedItems;
        collected[step.as] = [...new Set([...(collected[step.as] ?? []), ...semantic.values])];
      }
    }
    return result(runDeadline !== null && Date.now() >= runDeadline);
  } catch {
    return { ok: false, code: "selector_miss", error: "supplier page could not be inspected safely" };
  }

  function looksLoggedOut(): boolean {
    return Boolean(
      /(?:^|\/)(?:auth|login|log-in|signin|sign-in|sso)(?:\/|$)/i.test(location.pathname) ||
      document.querySelector('input[type="password"],input[autocomplete="current-password"]') ||
      document.querySelector('form[action*="login" i],form[action*="signin" i]'),
    );
  }

  function looksChallenged(): boolean {
    return Boolean(document.querySelector('[id*="challenge" i],[class*="challenge" i],iframe[src*="challenge" i],iframe[src*="captcha" i]'));
  }

  async function extractSemanticDownloads(maxActions: number): Promise<{
    values: string[];
    observedItems: number;
    resolvedItems: number;
    unresolvedItems: number;
  }> {
    const MAX_INLINE_PDF_BYTES = 8 * 1024 * 1024;
    const explicitAction = new RegExp(semanticPolicy.explicitActionPattern, "i");
    const strongDocumentLabel = new RegExp(semanticPolicy.strongDocumentPattern, "i");
    const documentIcon = new RegExp(semanticPolicy.documentIconPattern, "i");
    const invoiceContext = new RegExp(semanticPolicy.invoiceContextPattern, "i");
    const invoiceRow = new RegExp(semanticPolicy.invoiceRowPattern, "i");
    const actionColumn = new RegExp(semanticPolicy.actionColumnPattern, "i");
    const unsafe = new RegExp(semanticPolicy.unsafeLabelPattern, "i");
    const unsafePath = new RegExp(semanticPolicy.unsafePathPattern, "i");
    const invoiceSectionLabel = new RegExp(semanticPolicy.invoiceSectionPattern, "i");
    const allowed = new Set(allowedOrigins.slice(0, 9));
    const values = new Set<string>();
    const semanticCaptureDeadline = Math.min(Date.now() + 30_000, runDeadline ?? Number.POSITIVE_INFINITY);
    const add = (raw: string | URL | null | undefined): boolean => {
      if (!raw) return false;
      try {
        const url = new URL(String(raw), location.href);
        if (url.protocol === "https:" && allowed.has(url.origin) && !url.username && !url.password) {
          values.add(url.toString());
          return true;
        }
      } catch {
        // Ignore malformed or cross-origin action output.
      }
      return false;
    };
    const capturePdfBlob = (blob: Blob): Promise<boolean> => new Promise((resolve) => {
      if (blob.size === 0 || blob.size > MAX_INLINE_PDF_BYTES) {
        resolve(false);
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => resolve(false);
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result === "string" && result.startsWith("data:application/pdf;base64,JVBER")) {
          values.add(result);
          resolve(true);
          return;
        }
        resolve(false);
      };
      reader.readAsDataURL(blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" }));
    });
    const labelOf = (element: Element): string => {
      const icon = element.querySelector("svg,[icon],[name],[data-lucide]");
      return [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("value"),
        element.getAttribute("data-test"),
        element.getAttribute("data-testid"),
        element.getAttribute("data-lucide"),
        icon?.getAttribute("class"),
        icon?.getAttribute("data-lucide"),
        icon?.getAttribute("icon"),
        icon?.getAttribute("name"),
        icon?.getAttribute("aria-label"),
        icon?.getAttribute("title"),
        element.getAttribute("class"),
        element.textContent,
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 320);
    };
    const visible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 &&
        !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
    };
    const rowContextOf = (element: Element): string => (
      element.closest(semanticPolicy.contextSelector)?.textContent || ""
    ).replace(/\s+/g, " ").trim().slice(0, 500);
    const columnContextOf = (element: Element): string => {
      const cell = element.closest('td,th,[role="cell"],[role="gridcell"],[role="columnheader"]');
      const row = cell?.closest('tr,[role="row"]');
      const table = row?.closest(semanticPolicy.tableSelector);
      if (!cell || !row || !table) return "";
      const cells = Array.from(row.querySelectorAll(':scope > td,:scope > th,:scope > [role="cell"],:scope > [role="gridcell"],:scope > [role="columnheader"]'));
      const index = cells.indexOf(cell);
      if (index < 0) return "";
      for (const headerRow of Array.from(table.querySelectorAll('thead tr,[role="row"]')).slice(0, 5)) {
        const headers = Array.from(headerRow.querySelectorAll(':scope > th,:scope > [role="columnheader"]'));
        const text = headers[index]?.textContent?.replace(/\s+/g, " ").trim().slice(0, 120);
        if (text) return text;
      }
      return "";
    };
    const tableContextOf = (element: Element): string => (
      Array.from(element.closest(semanticPolicy.tableSelector)?.querySelectorAll(
        'thead th,[role="columnheader"]',
      ) || [])
        .slice(0, 20)
        .map((header) => header.textContent)
        .join(" ")
    ).replace(/\s+/g, " ").trim().slice(0, 500);
    const pageContext = (): string => `${location.pathname} ${document.title} ${
      Array.from(document.querySelectorAll("h1,h2,h3,caption"))
        .slice(0, 12)
        .map((element) => element.textContent)
        .join(" ")
    }`.replace(/\s+/g, " ").trim().slice(0, 240);
    const downloadControls = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(
      semanticPolicy.controlSelector,
    )).filter((element) => {
      const label = labelOf(element);
      if (!label || unsafe.test(label) || element.closest("form") || !visible(element)) return false;
      const row = rowContextOf(element);
      const table = tableContextOf(element);
      const page = pageContext();
      const explicit = explicitAction.test(label) &&
        (strongDocumentLabel.test(label) || invoiceContext.test(`${row} ${page}`));
      const contextualIcon = documentIcon.test(label) &&
        actionColumn.test(columnContextOf(element)) &&
        (invoiceRow.test(row) || invoiceContext.test(table)) &&
        invoiceContext.test(page);
      return explicit || contextualIcon;
    });
    const sectionLabelOf = (element: Element): string => [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.textContent,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
    const revealInvoiceSection = async (): Promise<boolean> => {
      if (downloadControls().length > 0) return false;
      const section = Array.from(document.querySelectorAll<HTMLElement>(
        semanticPolicy.sectionSelector,
      )).find((element) => {
        const label = sectionLabelOf(element);
        if (!label || !invoiceSectionLabel.test(label) || unsafe.test(label) || element.closest("form") || !visible(element)) return false;
        if (element instanceof HTMLAnchorElement && element.href) {
          try {
            const target = new URL(element.href, location.href);
            if (target.origin !== location.origin || unsafePath.test(target.pathname)) return false;
          } catch {
            return false;
          }
        }
        return true;
      });
      if (!section) return false;
      if (section.getAttribute("aria-selected") !== "true") section.click();
      const deadline = Math.min(Date.now() + 4_000, semanticCaptureDeadline);
      while (downloadControls().length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return true;
    };

    const waitForDownloadControls = async (): Promise<{
      availableControls: HTMLElement[];
      sectionObserved: boolean;
    }> => {
      let sectionObserved = await revealInvoiceSection();
      let availableControls = downloadControls();
      const deadline = Math.min(semanticCaptureDeadline, Date.now() + 8_000);
      let stableControlCount = -1;
      let stableControlCountSince = 0;
      while (Date.now() < deadline) {
        if (availableControls.length > 0) {
          if (availableControls.length !== stableControlCount) {
            stableControlCount = availableControls.length;
            stableControlCountSince = Date.now();
          } else if (Date.now() - stableControlCountSince >= semanticPolicy.stableMs) {
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        // Some SPAs mount the invoice tab after document.readyState becomes
        // complete. Reveal it once it exists, then keep waiting for its rows.
        if (!sectionObserved) sectionObserved = await revealInvoiceSection();
        availableControls = downloadControls();
      }
      return { availableControls, sectionObserved };
    };

    const { availableControls, sectionObserved } = await waitForDownloadControls();
    const controls = availableControls.slice(0, Math.max(1, Math.min(12, maxActions)));
    let resolvedControls = 0;

    for (const control of controls) {
      const direct = control.getAttribute("data-href") || control.getAttribute("data-url");
      if (direct) {
        if (add(direct)) resolvedControls += 1;
        continue;
      }
      if (control instanceof HTMLAnchorElement && control.href) {
        const target = new URL(control.href, location.href);
        if (target.protocol === "blob:" && target.origin === location.origin) {
          const captured = await window.fetch(target.toString())
            .then((response) => response.blob())
            .then((blob) => capturePdfBlob(blob))
            .catch(() => false);
          if (captured) resolvedControls += 1;
        } else if (add(target)) {
          resolvedControls += 1;
        }
        continue;
      }
      const form = control.closest("form");
      if (form) {
        if ((form.getAttribute("method") || "GET").toUpperCase() === "GET") {
          if (add(form.getAttribute("action") || location.href)) resolvedControls += 1;
        }
        continue;
      }
      const originalFetch = window.fetch;
      const originalXhrOpen = XMLHttpRequest.prototype.open;
      const originalXhrSend = XMLHttpRequest.prototype.send;
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      const xhrRequests = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
      const navigation = (window as Window & { navigation?: EventTarget }).navigation;
      const blockNavigation = (event: Event): void => {
        const candidate = event as Event & { destination?: { url?: string } };
        add(candidate.destination?.url);
        if (event.cancelable) event.preventDefault();
      };
      navigation?.addEventListener("navigate", blockNavigation);
      window.open = ((url?: string | URL) => {
        add(url);
        return null;
      }) as typeof window.open;
      HTMLAnchorElement.prototype.click = function guardAnchorClick(): void {
        const href = this.getAttribute("href");
        if (href) {
          const target = new URL(this.href, location.href);
          if (target.protocol === "blob:" && target.origin === location.origin) {
            void originalFetch(target.toString())
              .then((response) => response.blob())
              .then((blob) => capturePdfBlob(blob))
              .catch(() => false);
          } else {
            add(target);
          }
          return;
        }
        // Framework controls frequently use an anchor purely as an event
        // surface. Preserve that event while still intercepting any real link
        // the handler creates afterward.
        Reflect.apply(originalAnchorClick, this, []);
      };
      window.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
        const input = args[0];
        const init = args[1];
        const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
        // Analytics is commonly emitted before the safe invoice GET. Suppress
        // side-effecting requests without throwing into the supplier's click
        // handler, otherwise the handler never reaches its document request.
        if (method !== "GET") return new Response(null, { status: 204 });
        const response = await originalFetch(...args);
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        const requestUrl = input instanceof Request ? input.url : String(input);
        const documentResponse = contentType.includes("application/pdf") ||
          (/invoice|receipt|statement|\.pdf(?:\?|$)|\/download(?:\/|\?|$)/i.test(`${requestUrl} ${response.url}`) &&
            !/json|html|javascript|text\//i.test(contentType));
        if (documentResponse) {
          const captured = await capturePdfBlob(await response.clone().blob()).catch(() => false);
          if (!captured) {
            add(requestUrl);
            add(response.url);
          }
        }
        return response;
      }) as typeof window.fetch;
      XMLHttpRequest.prototype.open = function captureXhrOpen(this: XMLHttpRequest, method: string, url: string | URL, ...args: unknown[]): void {
        xhrRequests.set(this, { method: method.toUpperCase(), url: new URL(String(url), location.href).toString() });
        Reflect.apply(originalXhrOpen, this, [method, String(url), ...args]);
      } as typeof XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.send = function captureXhrSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
        const request = xhrRequests.get(this);
        if (!request || request.method !== "GET") {
          // Mirror a completed, empty side request asynchronously. The request
          // is never sent, while fire-and-forget telemetry cannot synchronously
          // abort the subsequent invoice download logic.
          queueMicrotask(() => {
            this.dispatchEvent(new ProgressEvent("load"));
            this.dispatchEvent(new ProgressEvent("loadend"));
          });
          return;
        }
        this.addEventListener("loadend", () => {
          const contentType = (this.getResponseHeader("content-type") || "").toLowerCase();
          const invoiceBlob = this.responseType === "blob" && /invoice|receipt|statement/i.test(request.url);
          if (
            contentType.includes("application/pdf") || invoiceBlob ||
            /\.pdf(?:\?|$)|\/download(?:\/|\?|$)/i.test(this.responseURL || request.url)
          ) {
            if (this.responseType === "blob" && this.response instanceof Blob) {
              void capturePdfBlob(this.response).then((captured) => {
                if (!captured) {
                  add(request.url);
                  add(this.responseURL);
                }
              });
            } else {
              add(request.url);
              add(this.responseURL);
            }
          }
        }, { once: true });
        Reflect.apply(originalXhrSend, this, [body]);
      } as typeof XMLHttpRequest.prototype.send;
      HTMLFormElement.prototype.submit = function blockFormSubmit(): void {
        throw new DOMException("Form submission blocked during invoice download discovery", "NotAllowedError");
      };
      HTMLFormElement.prototype.requestSubmit = function blockFormRequestSubmit(): void {
        throw new DOMException("Form submission blocked during invoice download discovery", "NotAllowedError");
      };
      navigator.sendBeacon = (() => false) as typeof navigator.sendBeacon;
      const capturedBefore = values.size;
      control.click();
      await new Promise<void>((resolve) => {
        const actionDeadline = Math.min(semanticCaptureDeadline, Date.now() + 8_000);
        const poll = () => {
          if (values.size > capturedBefore || Date.now() >= actionDeadline) {
            resolve();
            return;
          }
          setTimeout(poll, 100);
        };
        poll();
      });
      if (values.size > capturedBefore) resolvedControls += 1;
      // Guards intentionally stay installed until the disposable tab closes so
      // delayed handlers cannot perform a mutation after the capture wait ends.
      if (Date.now() >= semanticCaptureDeadline) break;
    }
    const observedControls = availableControls.length || (sectionObserved ? 1 : 0);
    return {
      values: [...values].slice(0, 100),
      observedItems: observedControls,
      resolvedItems: resolvedControls,
      unresolvedItems: Math.max(0, observedControls - resolvedControls),
    };
  }
}

/** Self-contained continuation action serialized into the supplier tab. */
async function advanceDomPageInPage(
  documentSelector: string,
  allowScroll: boolean,
  labelPattern: string,
  changeTimeoutMs: number,
): Promise<DomAdvanceResult> {
  const label = new RegExp(labelPattern, "i");
  const documentElements = Array.from(document.querySelectorAll(documentSelector)).slice(0, 500);
  const fingerprint = (): string => {
    const elements = Array.from(document.querySelectorAll(documentSelector)).slice(0, 500);
    const roots = [...new Set(elements.map((element) =>
      element.closest('tr,[role="row"],li,[role="listitem"],article') ?? element))];
    return [
      `${location.pathname}${location.search}`,
      ...roots.map((root) => {
        const controls = Array.from(root.querySelectorAll(
          'a,button,[role="button"],[data-href],[data-url],svg,[data-lucide]',
        )).slice(0, 20);
        return [
          (root.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 320),
          ...controls.map((element) => [
            element.getAttribute("href") ?? "",
            element.getAttribute("data-href") ?? "",
            element.getAttribute("data-url") ?? "",
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("class") ?? "",
            element.getAttribute("data-lucide") ?? "",
          ].join("\u0000")),
        ].join("\u0001");
      }).sort(),
    ].join("\n");
  };
  const before = fingerprint();
  const documentNext = document.querySelector<HTMLLinkElement>('link[rel~="next"][href]');
  if (documentNext?.href) return { kind: "navigate", url: documentNext.href };
  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || element.closest("form")) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const regions = [...new Set(documentElements.map((element) =>
    element.closest('table,[role="table"],[role="list"],section,main')).filter((element): element is Element => Boolean(element)))];
  const controlsIn = (root: ParentNode): Element[] =>
    Array.from(root.querySelectorAll('a[rel~="next"],a,button,[role="button"]'));
  const scopedControls = regions.flatMap(controlsIn);
  const controls = scopedControls.length > 0 ? [...new Set(scopedControls)] : controlsIn(document);
  const control = controls.find((element) => {
    if (!visible(element) || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
    const text = (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim();
    return element.getAttribute("rel")?.split(/\s+/).includes("next") || label.test(text);
  });

  if (control instanceof HTMLAnchorElement) {
    const raw = control.getAttribute("href");
    if (raw && raw !== "#") {
      try {
        const next = new URL(raw, location.href);
        if (next.protocol !== "https:") return { kind: "failed" };
        return { kind: "navigate", url: next.toString() };
      } catch {
        return { kind: "failed" };
      }
    }
  }

  if (control instanceof HTMLElement) {
    control.click();
    return (await waitForDocumentChange(before)) ? { kind: "advanced" } : { kind: "failed" };
  }

  if (!allowScroll || document.documentElement.scrollHeight <= window.innerHeight + 20) return { kind: "exhausted" };
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  return (await waitForDocumentChange(before)) ? { kind: "advanced" } : { kind: "exhausted" };

  function waitForDocumentChange(previous: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (changed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (quietTimer) clearTimeout(quietTimer);
        observer.disconnect();
        resolve(changed);
      };
      const observer = new MutationObserver(() => {
        if (fingerprint() === previous) return;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(fingerprint() !== previous), 200);
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ["href", "data-href", "data-url", "aria-busy"],
      });
      const timer = setTimeout(
        () => finish(fingerprint() !== previous),
        Math.max(250, Math.min(5_000, changeTimeoutMs)),
      );
    });
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

function collectedSize(collected: Record<string, Set<string>>): number {
  return Math.max(0, ...Object.values(collected).map((values) => values.size));
}

function throwDomRunError(code: DomRunErrorCode, vendorId: string): never {
  if (code === "auth_expired") throw new AuthExpired(vendorId);
  if (code === "blocked_or_challenged") throw new AuthFailure("blocked_or_challenged", vendorId);
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
