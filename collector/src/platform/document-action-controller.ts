import type { InvoiceMetadataEvidence } from "../../../src/core/types";
import {
  AuthExpired,
  AuthFailure,
  DocumentActionFailed,
  DocumentPermissionRequired,
  DomActionFailed,
} from "../../../src/core/errors";
import { exactPublicHttpsOriginPattern } from "../../../src/core/origin-policy";
import { acquireForegroundTabVisibility } from "./tab-visibility";
import { SemanticActionObserver } from "./semantic-action-observer";
import discoveryPageObserverScript from "./discovery-page-observer?script&iife";
import type { DISCOVERY_DOM_POLICY } from "./discovery-dom-policy";

export interface SemanticDocumentActionReference {
  actionId: string;
  vendorInvoiceId: string;
  evidence: InvoiceMetadataEvidence[];
}

export interface SemanticEnumerationResult {
  directDocuments: Array<{ url: string; evidence: InvoiceMetadataEvidence[] }>;
  actions: SemanticDocumentActionReference[];
  observedItems: number;
  resolvedItems: number;
  unresolvedItems: number;
  unstableItems: number;
  ambiguousItems: number;
  truncated: boolean;
  navigationSteps: number;
  sectionObserved: boolean;
}

export type SemanticResolutionResult =
  | { kind: "url"; url: string }
  | { kind: "inline_pdf"; dataUrl: string };

export interface SemanticActionRelocation {
  continuationActions: number;
  documentSelector: string;
  allowScroll: boolean;
  labelPattern: string;
}

type SemanticPageOperation =
  | { kind: "enumerate"; maximumActions: number }
  | { kind: "resolve"; actionId: string };

type SemanticPageResult =
  | ({ ok: true; kind: "enumeration" } & SemanticEnumerationResult)
  | { ok: true; kind: "url"; url: string }
  | { ok: true; kind: "inline_pdf"; dataUrl: string }
  | {
      ok: false;
      code:
        | "auth_expired"
        | "blocked_or_challenged"
        | "unstable_action_identity"
        | "document_action_ambiguous"
        | "document_action_timeout"
        | "action_failed";
    };

export type DomAdvanceResult =
  | { kind: "navigate"; url: string }
  | { kind: "advanced" }
  | { kind: "failed" }
  | { kind: "exhausted" };

/**
 * One owner for every click-capable Collector page operation.
 *
 * Browser request observation and a response-header blocker are armed only
 * around the exact disposable tab operation. Attachment responses are stopped
 * before Chrome can create a global DownloadItem; post-creation cancellation is
 * forbidden because DownloadItem does not identify its originating tab.
 */
export class DocumentActionController {
  constructor(
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly vendorId: string,
    private readonly onDocumentAction: () => void = () => undefined,
  ) {}

  async registerPageObserver(origin: string): Promise<{ dispose(tabId?: number): Promise<void> }> {
    if (!this.allowedOrigins.has(origin)) {
      throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
    }
    const registration = new SemanticPageObserverRegistration(origin);
    if (!await registration.start()) {
      throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
    }
    return registration;
  }

  async enumerateOnTab(
    tabId: number,
    maximumActions: number,
    semanticPolicy: typeof DISCOVERY_DOM_POLICY,
    runDeadline: number | null,
  ): Promise<SemanticEnumerationResult> {
    return this.runGuardedOnTab(tabId, "document_action_side_effect", async () => {
      const [injection] = await withinDeadline(chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: runSemanticDocumentOperationInPage,
        args: [
          { kind: "enumerate", maximumActions } satisfies SemanticPageOperation,
          [...this.allowedOrigins],
          semanticPolicy,
          runDeadline,
        ],
      }), runDeadline);
      const result = parseSemanticEnumeration(injection?.result, this.allowedOrigins);
      if (result.ambiguousItems > 0) {
        throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
      }
      if (result.unstableItems > 0) {
        throw new DocumentActionFailed("unstable_action_identity", this.vendorId);
      }
      return result;
    });
  }

  async resolve(
    pageUrl: string,
    actionId: string,
    semanticPolicy: typeof DISCOVERY_DOM_POLICY,
    signal?: AbortSignal,
    relocation?: SemanticActionRelocation,
  ): Promise<SemanticResolutionResult> {
    throwIfDocumentActionAborted(signal);
    const page = new URL(pageUrl);
    if (!this.allowedOrigins.has(page.origin)) {
      throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
    }
    const pageObserver = new SemanticPageObserverRegistration(page.origin);
    if (!await pageObserver.start()) {
      throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
    }
    let tabId: number | undefined;
    let releaseForeground = async (): Promise<void> => undefined;
    try {
      const shell = await chrome.tabs.create({ url: "about:blank", active: false });
      if (shell.id == null) throw new DomActionFailed("could not open the supplier billing page", this.vendorId);
      tabId = shell.id;
      releaseForeground = await acquireForegroundTabVisibility(tabId);
      const navigationDeadline = Date.now() + 20_000;
      await withinDeadline(
        chrome.tabs.update(tabId, { url: page.toString(), active: true }),
        navigationDeadline,
      );
      await waitForSupplierTabCommit(tabId, page.toString(), navigationDeadline);
      throwIfDocumentActionAborted(signal);
      for (let index = 0; index < (relocation?.continuationActions ?? 0); index += 1) {
        throwIfDocumentActionAborted(signal);
        const advance = await this.advanceOnTab(
          tabId,
          relocation!.documentSelector,
          relocation!.allowScroll,
          relocation!.labelPattern,
          5_000,
          Date.now() + 6_000,
        );
        if (advance.kind === "failed" || advance.kind === "exhausted") {
          throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
        }
        if (advance.kind === "navigate") {
          const next = new URL(advance.url);
          if (next.origin !== page.origin) {
            throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
          }
          const updateDeadline = Date.now() + 8_000;
          await withinDeadline(chrome.tabs.update(tabId, { url: next.toString(), active: true }), updateDeadline);
          await waitForSupplierTabCommit(tabId, next.toString(), updateDeadline);
        }
        throwIfDocumentActionAborted(signal);
      }
      throwIfDocumentActionAborted(signal);
      return await this.runGuardedOnTab(tabId, "browser_download_unsupported", async () => {
        throwIfDocumentActionAborted(signal);
        // This is the single metric boundary for document-producing page
        // activation. It contains no URL, selector, row data, or invoice data.
        try { this.onDocumentAction(); } catch { /* observability cannot change acquisition */ }
        const actionDeadline = Date.now() + 30_000;
        const [injection] = await withinDeadline(chrome.scripting.executeScript({
          target: { tabId: tabId! },
          world: "MAIN",
          func: runSemanticDocumentOperationInPage,
          args: [
            { kind: "resolve", actionId } satisfies SemanticPageOperation,
            [...this.allowedOrigins],
            semanticPolicy,
            actionDeadline,
          ],
        }), actionDeadline);
        throwIfDocumentActionAborted(signal);
        return this.parseSemanticResolution(injection?.result);
      });
    } finally {
      await releaseForeground();
      await pageObserver.dispose(tabId);
      if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  }

  async advanceOnTab(
    tabId: number,
    documentSelector: string,
    allowScroll: boolean,
    labelPattern: string,
    changeTimeoutMs: number,
    runDeadline: number | null,
  ): Promise<DomAdvanceResult> {
    return this.runGuardedOnTab(tabId, "document_action_side_effect", async () => {
      const [injection] = await withinDeadline(chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: advanceDomPageInPage,
        args: [documentSelector, allowScroll, labelPattern, changeTimeoutMs],
      }), runDeadline);
      return parseDomAdvanceResult(injection?.result);
    });
  }

  /**
   * Discovery may reveal inert account/settings UI through its existing page
   * probe. This wrapper gives that operation the same download containment
   * invariant without allowing browser metadata to become candidate proof.
   */
  async runDiscoveryProbe<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    if (!await setPageDocumentActionScope(tabId, true)) {
      throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
    }
    try {
      return await this.runGuardedOnTab(tabId, "document_action_side_effect", operation);
    } finally {
      await setPageDocumentActionScope(tabId, false);
    }
  }

  private async runGuardedOnTab<T>(
    tabId: number,
    downloadFailure: "document_action_side_effect" | "browser_download_unsupported",
    operation: () => Promise<T>,
  ): Promise<T> {
    const observer = new SemanticActionObserver(this.allowedOrigins);
    let releaseNativeDownloadGuard: (() => Promise<void>) | undefined;
    try {
      releaseNativeDownloadGuard = await installNativeDownloadGuard(tabId);
    } catch {
      throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
    }
    if (!observer.start(tabId)) {
      await releaseNativeDownloadGuard().catch(() => undefined);
      throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
    }
    observer.beginAction();
    let value: T | undefined;
    let failure: unknown;
    try {
      value = await operation();
    } catch (error) {
      failure = error;
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      observer.endAction();
    }
    const nativeDownloadAttempted = observer.snapshotNativeDownloadAttempted();
    observer.stop();
    try {
      await releaseNativeDownloadGuard();
    } catch {
      throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
    }
    if (nativeDownloadAttempted) {
      throw new DocumentActionFailed(downloadFailure, this.vendorId);
    }
    if (failure) {
      if (failure instanceof DeadlineExceeded) {
        throw new DocumentActionFailed("document_action_timeout", this.vendorId);
      }
      throw failure;
    }
    return value as T;
  }

  private parseSemanticResolution(value: unknown): SemanticResolutionResult {
    const parsed = parseSemanticPageResult(value);
    if (!parsed.ok) throw semanticPageError(parsed.code, this.vendorId);
    if (parsed.kind === "url") {
      let url: URL;
      try { url = new URL(parsed.url); } catch {
        throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
      }
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
      }
      if (!this.allowedOrigins.has(url.origin)) {
        throw new DocumentPermissionRequired(
          "semantic_action",
          [exactPublicHttpsOriginPattern(url.origin)],
          this.vendorId,
        );
      }
      url.hash = "";
      return { kind: "url", url: url.toString() };
    }
    if (parsed.kind === "inline_pdf") return { kind: "inline_pdf", dataUrl: parsed.dataUrl };
    throw new DocumentActionFailed("document_action_ambiguous", this.vendorId);
  }
}

function parseSemanticEnumeration(
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
): SemanticEnumerationResult {
  const parsed = parseSemanticPageResult(value, allowedOrigins);
  if (!parsed.ok) throw semanticPageError(parsed.code);
  if (parsed.kind !== "enumeration") throw new Error("semantic enumeration result is invalid");
  return {
    directDocuments: parsed.directDocuments,
    actions: parsed.actions,
    observedItems: parsed.observedItems,
    resolvedItems: parsed.resolvedItems,
    unresolvedItems: parsed.unresolvedItems,
    unstableItems: parsed.unstableItems,
    ambiguousItems: parsed.ambiguousItems,
    truncated: parsed.truncated,
    navigationSteps: parsed.navigationSteps,
    sectionObserved: parsed.sectionObserved,
  };
}

function parseSemanticPageResult(
  value: unknown,
  allowedOrigins?: ReadonlySet<string>,
): SemanticPageResult {
  const invalid = (): never => { throw new Error("semantic document action result is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  if (raw.ok === false) {
    const codes = new Set([
      "auth_expired",
      "blocked_or_challenged",
      "unstable_action_identity",
      "document_action_ambiguous",
      "document_action_timeout",
      "action_failed",
    ]);
    if (!codes.has(String(raw.code))) return invalid();
    return { ok: false, code: raw.code as Extract<SemanticPageResult, { ok: false }>["code"] };
  }
  if (raw.ok !== true) return invalid();
  if (raw.kind === "url") {
    if (typeof raw.url !== "string" || raw.url.length > 2_048) return invalid();
    return { ok: true, kind: "url", url: raw.url };
  }
  if (raw.kind === "inline_pdf") {
    if (
      typeof raw.dataUrl !== "string" ||
      raw.dataUrl.length > 12_000_000 ||
      !raw.dataUrl.startsWith("data:application/pdf;base64,JVBER")
    ) return invalid();
    return { ok: true, kind: "inline_pdf", dataUrl: raw.dataUrl };
  }
  if (raw.kind !== "enumeration") return invalid();
  for (const field of [
    "observedItems",
    "resolvedItems",
    "unresolvedItems",
    "unstableItems",
    "ambiguousItems",
    "navigationSteps",
  ] as const) {
    if (!Number.isInteger(raw[field]) || Number(raw[field]) < 0 || Number(raw[field]) > 10_000) return invalid();
  }
  if (typeof raw.truncated !== "boolean" || typeof raw.sectionObserved !== "boolean") return invalid();
  if (!Array.isArray(raw.directDocuments) || raw.directDocuments.length > 500) return invalid();
  if (!Array.isArray(raw.actions) || raw.actions.length > 100) return invalid();
  if (!allowedOrigins) return invalid();
  const directDocuments = raw.directDocuments.map((item) => parseDirectDocument(item, allowedOrigins));
  const actions = raw.actions.map((item) => parseActionReference(item));
  if (new Set(actions.map((item) => item.actionId)).size !== actions.length) return invalid();
  if (new Set(actions.map((item) => item.vendorInvoiceId)).size !== actions.length) return invalid();
  return {
    ok: true,
    kind: "enumeration",
    directDocuments,
    actions,
    observedItems: Number(raw.observedItems),
    resolvedItems: Number(raw.resolvedItems),
    unresolvedItems: Number(raw.unresolvedItems),
    unstableItems: Number(raw.unstableItems),
    ambiguousItems: Number(raw.ambiguousItems),
    truncated: raw.truncated,
    navigationSteps: Number(raw.navigationSteps),
    sectionObserved: raw.sectionObserved,
  };
}

function parseDirectDocument(
  raw: unknown,
  allowedOrigins: ReadonlySet<string>,
): { url: string; evidence: InvoiceMetadataEvidence[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("semantic document action result is invalid");
  const item = raw as Record<string, unknown>;
  if (typeof item.url !== "string" || item.url.length > 2_048 || !Array.isArray(item.evidence) || item.evidence.length > 8) {
    throw new Error("semantic document action result is invalid");
  }
  let url: URL;
  try { url = new URL(item.url); } catch { throw new Error("semantic document action result is invalid"); }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    !allowedOrigins.has(url.origin)
  ) throw new Error("semantic document action result is invalid");
  url.hash = "";
  return { url: url.toString(), evidence: item.evidence.map(parseMetadataEvidence) };
}

function parseActionReference(raw: unknown): SemanticDocumentActionReference {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("semantic document action result is invalid");
  const item = raw as Record<string, unknown>;
  if (
    typeof item.actionId !== "string" || !/^[a-f0-9]{32}$/.test(item.actionId) ||
    typeof item.vendorInvoiceId !== "string" || !/^semantic-[a-f0-9]{32}$/.test(item.vendorInvoiceId) ||
    !Array.isArray(item.evidence) || item.evidence.length > 8
  ) throw new Error("semantic document action result is invalid");
  return {
    actionId: item.actionId,
    vendorInvoiceId: item.vendorInvoiceId,
    evidence: item.evidence.map(parseMetadataEvidence),
  };
}

function parseMetadataEvidence(raw: unknown): InvoiceMetadataEvidence {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("semantic document action result is invalid");
  const value = raw as Record<string, unknown>;
  if (
    value.source !== "dom-row" || value.confidence !== "high"
  ) throw new Error("semantic document action result is invalid");
  const result: InvoiceMetadataEvidence = { source: "dom-row", confidence: "high" };
  for (const field of ["invoiceNumber", "issuedAt", "total", "currency"] as const) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.length > 240) {
      throw new Error("semantic document action result is invalid");
    }
    result[field] = candidate;
  }
  return result;
}

function semanticPageError(
  code: Extract<SemanticPageResult, { ok: false }>["code"],
  vendorId?: string,
): Error {
  if (code === "auth_expired") return new AuthExpired(vendorId);
  if (code === "blocked_or_challenged") return new AuthFailure("blocked_or_challenged", vendorId);
  if (code === "action_failed") return new DomActionFailed("supplier invoice action failed", vendorId);
  return new DocumentActionFailed(code, vendorId);
}

const NATIVE_DOWNLOAD_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "object",
  "other",
] as const;

export async function removeStaleNativeDownloadGuards(): Promise<void> {
  const api = chrome.declarativeNetRequest;
  if (!api?.getSessionRules || !api.updateSessionRules) return;
  const rules = await api.getSessionRules();
  const removeRuleIds = rules.filter(isNativeDownloadGuardRule).map((rule) => rule.id);
  if (removeRuleIds.length) await api.updateSessionRules({ removeRuleIds });
}

function isNativeDownloadGuardRule(rule: chrome.declarativeNetRequest.Rule): boolean {
  const condition = rule.condition as chrome.declarativeNetRequest.Rule["condition"] & {
    responseHeaders?: Array<{ header?: string; values?: string[] }>;
  };
  return (
    rule.action.type === ("block" as chrome.declarativeNetRequest.RuleActionType) &&
    rule.priority === 1 &&
    condition.urlFilter === "|https" &&
    condition.tabIds?.length === 1 &&
    condition.tabIds[0] === rule.id &&
    condition.responseHeaders?.some((header) =>
      header.header === "content-disposition" &&
      header.values?.length === 1 &&
      header.values[0] === "*attachment*"
    ) === true
  );
}

async function installNativeDownloadGuard(tabId: number): Promise<() => Promise<void>> {
  if (!Number.isSafeInteger(tabId) || tabId < 1) throw new Error("invalid action tab");
  // This extension owns no other session rules. Using the exact tab id makes
  // concurrent guards collision-free, while remove+add atomically replaces a
  // stale rule left by a terminated service worker.
  const ruleId = tabId;
  const rule = {
    id: ruleId,
    priority: 1,
    action: { type: "block" },
    condition: {
      tabIds: [tabId],
      urlFilter: "|https",
      resourceTypes: NATIVE_DOWNLOAD_RESOURCE_TYPES,
      responseHeaders: [
        { header: "content-disposition", values: ["*attachment*"] },
        { header: "content-type", values: [
          "*application/octet-stream*",
          "*application/force-download*",
          "*application/x-download*",
        ] },
      ],
    },
  };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    // @types/chrome 0.0.x predates Chrome 128 responseHeaders conditions.
    // The manifest's minimum Chrome version and package tests enforce that
    // this documented RuleCondition shape is available at runtime.
    addRules: [rule as unknown as chrome.declarativeNetRequest.Rule],
  });
  let released = false;
  return async () => {
    if (released) return;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    released = true;
  };
}

async function setPageDocumentActionScope(tabId: number, active: boolean): Promise<boolean> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (enabled: boolean): boolean => {
        const observer = (window as Window & {
          __ratatoskDiscoveryObserverV1?: {
            beginDocumentAction?: () => void;
            endDocumentAction?: () => void;
          };
        }).__ratatoskDiscoveryObserverV1;
        const operation = enabled
          ? observer?.beginDocumentAction
          : observer?.endDocumentAction;
        if (typeof operation !== "function") return false;
        operation.call(observer);
        return true;
      },
      args: [active],
    });
    return injection?.result === true;
  } catch {
    return false;
  }
}

class SemanticPageObserverRegistration {
  private readonly id = `ratatosk_semantic_${crypto.randomUUID().replaceAll("-", "")}`;
  private registered = false;

  constructor(private readonly origin: string) {}

  async start(): Promise<boolean> {
    try {
      await chrome.scripting.registerContentScripts([{
        id: this.id,
        matches: [`${this.origin}/*`],
        js: [discoveryPageObserverScript],
        runAt: "document_start",
        world: "MAIN",
        allFrames: false,
        persistAcrossSessions: false,
      }]);
      this.registered = true;
      return true;
    } catch {
      return false;
    }
  }

  async dispose(tabId?: number): Promise<void> {
    if (!this.registered) return;
    this.registered = false;
    if (tabId !== undefined) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const observer = (window as Window & {
            __ratatoskDiscoveryObserverV1?: { stop?: () => void };
          }).__ratatoskDiscoveryObserverV1;
          observer?.stop?.();
        },
      }).catch(() => undefined);
    }
    await chrome.scripting.unregisterContentScripts({ ids: [this.id] }).catch(() => undefined);
  }
}

class DeadlineExceeded extends Error {}

function throwIfDocumentActionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("document action aborted", "AbortError");
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number | null): Promise<T> {
  if (deadline === null) return promise;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DeadlineExceeded();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceeded()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForSupplierTabCommit(tabId: number, requestedUrl: string, deadline: number): Promise<void> {
  const expectedOrigin = new URL(requestedUrl).origin;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      try {
        if (new URL(tab.url).origin === expectedOrigin && tab.status === "complete") return;
      } catch {
        // Keep waiting for the requested public page.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new DeadlineExceeded();
}

/**
 * Self-contained MAIN-world operation. The same identity and safety policy is
 * used for read-only enumeration and the later exact action re-location.
 */
export async function runSemanticDocumentOperationInPage(
  operation: SemanticPageOperation,
  allowedOrigins: string[],
  semanticPolicy: typeof DISCOVERY_DOM_POLICY,
  runDeadline: number | null,
): Promise<SemanticPageResult> {
  const explicitAction = new RegExp(semanticPolicy.explicitActionPattern, "i");
  const strongDocumentLabel = new RegExp(semanticPolicy.strongDocumentPattern, "i");
  const documentIcon = new RegExp(semanticPolicy.documentIconPattern, "i");
  const invoiceContext = new RegExp(semanticPolicy.invoiceContextPattern, "i");
  const invoiceRow = new RegExp(semanticPolicy.invoiceRowPattern, "i");
  const actionColumn = new RegExp(semanticPolicy.actionColumnPattern, "i");
  const documentNumberHeader = new RegExp(semanticPolicy.documentNumberPattern, "i");
  const unsafe = new RegExp(semanticPolicy.unsafeLabelPattern, "i");
  const unsafePath = new RegExp(semanticPolicy.unsafePathPattern, "i");
  const invoiceSectionLabel = new RegExp(semanticPolicy.invoiceSectionPattern, "i");
  const semanticNavigation = new RegExp(semanticPolicy.semanticNavigationPattern, "i");
  const profileNavigation = new RegExp(semanticPolicy.profileNavigationPattern, "i");
  const settingsNavigation = new RegExp(semanticPolicy.settingsNavigationPattern, "i");
  const billingNavigation = new RegExp(semanticPolicy.billingNavigationPattern, "i");
  const allowed = new Set(allowedOrigins.slice(0, 9));
  const deadline = Math.min(Date.now() + 30_000, runDeadline ?? Number.POSITIVE_INFINITY);
  const normalize = (value: string | null | undefined, maximum = 500): string =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
  const visible = (element: HTMLElement): boolean => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.visibility !== "collapse" && Number(style.opacity) !== 0 &&
      rect.width > 0 && rect.height > 0 &&
      !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
  };
  const accessibleLabelSources = (element: Element, maximum = 160): string[] => {
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/).filter(Boolean).slice(0, 4)
      .map((id) => document.getElementById(id)?.textContent)
      .filter((value): value is string => Boolean(value));
    const associated = [
      element.closest("label")?.textContent,
      ...(element.id
        ? Array.from(document.querySelectorAll<HTMLLabelElement>("label[for]"))
          .filter((label) => label.htmlFor === element.id).slice(0, 4).map((label) => label.textContent)
        : []),
    ].filter((value): value is string => Boolean(value));
    const sources: Record<(typeof semanticPolicy.accessibleNameOrder)[number], string | null | undefined> = {
      "aria-labelledby": labelledBy.join(" "),
      "aria-label": element.getAttribute("aria-label"),
      "associated-label": associated.join(" "),
      title: element.getAttribute("title"),
      alt: element.getAttribute("alt"),
      value: element.getAttribute("value"),
      "visible-text": element.textContent,
    };
    return semanticPolicy.accessibleNameOrder
      .map((source) => normalize(sources[source], maximum))
      .filter(Boolean);
  };
  const labelOf = (element: Element): string => {
    const icon = element.querySelector("svg,[icon],[name],[data-lucide]");
    return normalize([
      ...accessibleLabelSources(element, 320),
      element.getAttribute("data-test"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-lucide"),
      icon?.getAttribute("class"),
      icon?.getAttribute("data-lucide"),
      icon?.getAttribute("icon"),
      icon?.getAttribute("name"),
      element.getAttribute("class"),
    ].filter(Boolean).join(" "), 320);
  };
  const rowOf = (element: Element): Element | null => element.closest(semanticPolicy.rowSelector);
  const contextRootOf = (row: Element): Element | null => {
    const table = row.closest(semanticPolicy.tableSelector);
    if (table) return table;
    let root = row.parentElement;
    for (let depth = 0; root && depth < 5; depth += 1, root = root.parentElement) {
      if (root.querySelector(semanticPolicy.headerRowSelector)) return root;
    }
    return null;
  };
  const rowContextOf = (element: Element): string => normalize(
    rowOf(element)?.textContent ?? element.closest(semanticPolicy.contextSelector)?.textContent,
  );
  const columnContextOf = (element: Element): string => {
    const cell = element.closest(semanticPolicy.cellSelector);
    const row = rowOf(element);
    const table = row ? contextRootOf(row) : null;
    if (!cell || !row || !table) return "";
    const cells = Array.from(row.querySelectorAll(semanticPolicy.cellSelector));
    const index = cells.indexOf(cell);
    if (index < 0) return "";
    for (const headerRow of Array.from(table.querySelectorAll(semanticPolicy.headerRowSelector)).slice(0, 5)) {
      const headers = Array.from(headerRow.querySelectorAll(semanticPolicy.headerCellSelector));
      const text = normalize(headers[index]?.textContent, 120);
      if (text) return text;
    }
    return "";
  };
  const tableContextOf = (element: Element): string => normalize(
    Array.from(element.closest(semanticPolicy.tableSelector)?.querySelectorAll(
      'thead th,[role="columnheader"]',
    ) || []).slice(0, 20).map((header) => header.textContent).join(" "),
  );
  const pageContext = (): string => normalize(`${document.title} ${
    Array.from(document.querySelectorAll("h1,h2,h3,caption"))
      .slice(0, 12).map((element) => element.textContent).join(" ")
  }`, 240);
  const downloadControls = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(
    semanticPolicy.controlSelector,
  )).filter((element) => {
    const label = labelOf(element);
    if (!label || unsafe.test(label) || element.closest("form") || !visible(element)) return false;
    const row = rowContextOf(element);
    const table = tableContextOf(element);
    const page = pageContext();
    const explicit = explicitAction.test(label) &&
      (strongDocumentLabel.test(label) || invoiceContext.test(`${row} ${table} ${page}`));
    const contextualIcon = documentIcon.test(label) &&
      actionColumn.test(columnContextOf(element)) &&
      (invoiceRow.test(row) || invoiceContext.test(table)) &&
      invoiceContext.test(`${table} ${page}`);
    return explicit || contextualIcon;
  });
  const actionObserver = (): {
    snapshotActionDocuments?: () => Promise<string[]>;
    beginDocumentAction?: () => void;
    endDocumentAction?: () => void;
  } | undefined => (window as Window & {
    __ratatoskDiscoveryObserverV1?: {
      snapshotActionDocuments?: () => Promise<string[]>;
      beginDocumentAction?: () => void;
      endDocumentAction?: () => void;
    };
  }).__ratatoskDiscoveryObserverV1;
  const safeNavigationClick = (control: HTMLElement): void => {
    const observer = actionObserver();
    observer?.beginDocumentAction?.();
    try { control.click(); } finally { observer?.endDocumentAction?.(); }
  };
  const navigationLabelsOf = (element: Element): string[] => accessibleLabelSources(element, 120);
  const navigationControl = (tier: RegExp): HTMLElement | undefined => Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="button"],[role="menuitem"],[role="tab"],a:not([href])'),
  ).find((element) => {
    const labels = navigationLabelsOf(element);
    return Boolean(
      labels.length && !labels.some((label) => unsafe.test(label)) &&
      labels.some((label) => semanticNavigation.test(label) && tier.test(label)) &&
      !element.closest("form") && visible(element)
    );
  });
  let navigationSteps = 0;
  const revealBillingSurface = async (): Promise<void> => {
    if (downloadControls().length > 0) return;
    const tiers = [
      profileNavigation,
      settingsNavigation,
      billingNavigation,
    ];
    let mounting = true;
    for (const tier of tiers) {
      if (Date.now() >= deadline || navigationSteps >= 3) return;
      const tierDeadline = mounting ? Math.min(deadline, Date.now() + 3_000) : 0;
      let control = navigationControl(tier);
      while (!control && Date.now() < tierDeadline) {
        if (downloadControls().length) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
        control = navigationControl(tier);
      }
      mounting = Boolean(control);
      if (!control) continue;
      safeNavigationClick(control);
      navigationSteps += 1;
    }
  };
  let sectionObserved = false;
  const revealInvoiceSection = async (): Promise<void> => {
    if (downloadControls().length > 0) return;
    const section = Array.from(document.querySelectorAll<HTMLElement>(
      semanticPolicy.sectionSelector,
    )).find((element) => {
      const labels = accessibleLabelSources(element, 120);
      if (!labels.some((label) => invoiceSectionLabel.test(label)) || labels.some((label) => unsafe.test(label)) || element.closest("form") || !visible(element)) {
        return false;
      }
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
    if (!section) return;
    sectionObserved = true;
    if (section.getAttribute("aria-selected") !== "true") safeNavigationClick(section);
  };
  const waitForControls = async (): Promise<HTMLElement[]> => {
    await revealBillingSurface();
    await revealInvoiceSection();
    let controls = downloadControls();
    let stableCount = -1;
    let stableSince = Date.now();
    const waitDeadline = Math.min(deadline, Date.now() + 8_000);
    while (Date.now() < waitDeadline) {
      if (controls.length !== stableCount) {
        stableCount = controls.length;
        stableSince = Date.now();
      } else if (controls.length && Date.now() - stableSince >= semanticPolicy.stableMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!sectionObserved) await revealInvoiceSection();
      controls = downloadControls();
    }
    return controls;
  };
  const metadataForElement = (element: Element): InvoiceMetadataEvidence[] => {
    const row = rowOf(element);
    if (!row) return [];
    const table = contextRootOf(row);
    const cells = Array.from(row.querySelectorAll(semanticPolicy.cellSelector));
    if (!cells.length) return [];
    const headers: string[] = [];
    if (table) {
      for (const headerRow of Array.from(table.querySelectorAll(semanticPolicy.headerRowSelector)).slice(0, 5)) {
        const found = Array.from(headerRow.querySelectorAll(semanticPolicy.headerCellSelector));
        if (found.length >= cells.length) {
          for (let index = 0; index < cells.length; index += 1) headers[index] = normalize(found[index]?.textContent, 120);
          break;
        }
      }
    }
    for (let index = 0; index < cells.length; index += 1) {
      headers[index] ||= normalize(
        cells[index].getAttribute("aria-label") ||
        cells[index].getAttribute("data-label") ||
        cells[index].getAttribute("data-title"),
        120,
      );
    }
    const claim: InvoiceMetadataEvidence = { source: "dom-row", confidence: "high" };
    for (let index = 0; index < cells.length; index += 1) {
      const header = headers[index].toLowerCase();
      const cell = cells[index];
      const text = normalize(cell.textContent, 240);
      if (!header || !text) continue;
      if (
        !claim.invoiceNumber &&
        documentNumberHeader.test(header)
      ) claim.invoiceNumber = text;
      else if (
        !claim.issuedAt && !/(?:due|paid|period|service|subscription|renew)/i.test(header) &&
        /(?:invoice|receipt|issue|issued|created)?\s*date/i.test(header)
      ) claim.issuedAt = structuredDate(cell, text);
      else if (!claim.total && /^(?:total|amount|gross|invoice amount|amount paid|paid)$/i.test(header)) {
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
  };
  const stableMaterial = (element: Element, evidence: InvoiceMetadataEvidence[]): string | undefined => {
    const row = rowOf(element);
    if (!row) return undefined;
    const stableAttributes = (candidate: Element): string[] => [
      "data-invoice-id",
      "data-receipt-id",
      "data-document-id",
      "data-row-id",
    ].flatMap((name) => {
      const value = normalize(candidate.getAttribute(name), 160);
      return value && !/(?:token|secret|signature|bearer|eyJ[A-Za-z0-9_-]{20,})/i.test(value)
        ? [`${name}=${value}`]
        : [];
    });
    const attributes = [...stableAttributes(row), ...stableAttributes(element)];
    const explicitAttribute = attributes[0];
    const invoiceNumber = evidence.find((claim) => claim.invoiceNumber)?.invoiceNumber;
    const datedAmount = evidence.find((claim) =>
      claim.issuedAt && claim.total && claim.currency);
    // Presentation text, action labels, row position, and column headings can
    // change between schedules. They may admit a control but cannot identify
    // its invoice. Use the strongest available identity alone so optional
    // lower-priority evidence cannot make the digest drift between schedules.
    // Collisions are rejected below rather than disambiguated by position.
    if (explicitAttribute) return explicitAttribute;
    if (invoiceNumber) return `invoice=${normalize(invoiceNumber, 160)}`;
    if (datedAmount) {
      return `date=${datedAmount.issuedAt}\u0001total=${datedAmount.total}\u0001currency=${datedAmount.currency}`;
    }
    return undefined;
  };
  const digest = async (value: string): Promise<string> => {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const directUrl = (element: HTMLElement): string | undefined => {
    const raw = element.getAttribute("data-href") || element.getAttribute("data-url") ||
      (element instanceof HTMLAnchorElement ? element.href : "");
    if (!raw) return undefined;
    try {
      const url = new URL(raw, location.href);
      if (
        url.protocol !== "https:" || url.username || url.password ||
        !allowed.has(url.origin)
      ) return undefined;
      url.hash = "";
      return url.toString();
    } catch {
      return undefined;
    }
  };
  const capturePdfBlob = async (blob: Blob): Promise<string | undefined> => {
    if (blob.size === 0 || blob.size > 8 * 1024 * 1024) return undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return undefined;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 32_768)));
    }
    return `data:application/pdf;base64,${btoa(binary)}`;
  };
  const controls = await waitForControls();
  if (Date.now() >= deadline) return { ok: false, code: "document_action_timeout" };
  if (looksLoggedOut()) return { ok: false, code: "auth_expired" };
  if (looksChallenged()) return { ok: false, code: "blocked_or_challenged" };

  const candidates: Array<{
    control: HTMLElement;
    actionId?: string;
    vendorInvoiceId?: string;
    url?: string;
    evidence: InvoiceMetadataEvidence[];
  }> = [];
  for (const control of controls.slice(0, 500)) {
    const evidence = metadataForElement(control);
    const url = directUrl(control);
    if (url) {
      candidates.push({ control, url, evidence });
      continue;
    }
    const material = stableMaterial(control, evidence);
    if (!material) {
      candidates.push({ control, evidence });
      continue;
    }
    const actionId = await digest(material);
    candidates.push({
      control,
      actionId,
      vendorInvoiceId: `semantic-${actionId}`,
      evidence,
    });
  }

  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.actionId) counts.set(candidate.actionId, (counts.get(candidate.actionId) ?? 0) + 1);
  }
  if (operation.kind === "enumerate") {
    const directDocuments = candidates.flatMap((candidate) =>
      candidate.url ? [{ url: candidate.url, evidence: candidate.evidence }] : []);
    const stableActions = candidates.filter((candidate) =>
      candidate.actionId && candidate.vendorInvoiceId && counts.get(candidate.actionId) === 1);
    const actions = stableActions.slice(0, Math.max(1, Math.min(12, operation.maximumActions))).map((candidate) => ({
      actionId: candidate.actionId!,
      vendorInvoiceId: candidate.vendorInvoiceId!,
      evidence: candidate.evidence,
    }));
    const unstableItems = candidates.filter((candidate) =>
      !candidate.url && !candidate.actionId).length;
    const ambiguousItems = candidates.filter((candidate) =>
      candidate.actionId && (counts.get(candidate.actionId) ?? 0) > 1).length;
    const unresolvedItems = candidates.length - directDocuments.length - actions.length;
    return {
      ok: true,
      kind: "enumeration",
      directDocuments,
      actions,
      observedItems: candidates.length || (sectionObserved ? 1 : 0),
      resolvedItems: directDocuments.length + actions.length,
      unresolvedItems: Math.max(0, unresolvedItems),
      unstableItems,
      ambiguousItems,
      truncated: stableActions.length > actions.length,
      navigationSteps,
      sectionObserved,
    };
  }

  const matches = candidates.filter((candidate) => candidate.actionId === operation.actionId);
  if (matches.length !== 1) {
    return { ok: false, code: matches.length ? "document_action_ambiguous" : "unstable_action_identity" };
  }
  const candidate = matches[0];
  if (candidate.control instanceof HTMLAnchorElement && candidate.control.href) {
    let target: URL;
    try { target = new URL(candidate.control.href, location.href); } catch {
      return { ok: false, code: "action_failed" };
    }
    if (target.protocol === "blob:" && target.origin === location.origin) {
      const captured = await window.fetch(target.toString())
        .then((response) => response.blob())
        .then((blob) => capturePdfBlob(blob))
        .catch(() => undefined);
      return captured
        ? { ok: true, kind: "inline_pdf", dataUrl: captured }
        : { ok: false, code: "action_failed" };
    }
  }
  if (
    candidate.url || !visible(candidate.control) || candidate.control.closest("form") ||
    unsafe.test(labelOf(candidate.control))
  ) return { ok: false, code: "document_action_ambiguous" };
  const observer = actionObserver();
  if (
    typeof observer?.beginDocumentAction !== "function" ||
    typeof observer.snapshotActionDocuments !== "function" ||
    typeof observer.endDocumentAction !== "function"
  ) return { ok: false, code: "action_failed" };
  observer.beginDocumentAction();
  try {
    candidate.control.click();
    const actionDeadline = Math.min(deadline, Date.now() + 2_500);
    let documents: string[] = [];
    while (Date.now() < actionDeadline) {
      documents = await Promise.race([
        Promise.resolve(observer.snapshotActionDocuments()),
        new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 800)),
      ]);
      if (documents.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    documents = await Promise.resolve(observer.snapshotActionDocuments());
    const unique = [...new Set(documents)].slice(0, 3);
    if (unique.length !== 1) {
      return { ok: false, code: unique.length > 1 ? "document_action_ambiguous" : "document_action_timeout" };
    }
    const value = unique[0];
    if (value.startsWith("data:application/pdf;base64,JVBER")) {
      return { ok: true, kind: "inline_pdf", dataUrl: value };
    }
    let url: URL;
    try { url = new URL(value); } catch { return { ok: false, code: "action_failed" }; }
    if (url.protocol !== "https:" || url.username || url.password) return { ok: false, code: "action_failed" };
    url.hash = "";
    return { ok: true, kind: "url", url: url.toString() };
  } catch {
    return { ok: false, code: "action_failed" };
  } finally {
    observer.endDocumentAction();
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
      return !element.hidden && element.getAttribute("aria-hidden") !== "true" &&
        style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 && bounds.width >= 2 && bounds.height >= 2;
    });
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
    return undefined;
  }

  function validCalendarDate(year: number, month: number, day: number): string | undefined {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      year < 2000 || year > 2100 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    ) return undefined;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function displayedAmount(text: string): { total: string; currency?: string } | undefined {
    const explicitCode = text.match(/\b[A-Za-z]{3}\b/)?.[0]?.toUpperCase();
    const symbolCurrency = text.includes("€") ? "EUR" : text.includes("£") ? "GBP" : undefined;
    const currency = explicitCode && /^[A-Z]{3}$/.test(explicitCode) ? explicitCode : symbolCurrency;
    let numeric = text.replace(/\b[A-Za-z]{3}\b/g, "").replace(/[€£$¥]/g, "")
      .replace(/[\s\u00a0']/g, "").trim();
    if (!/^-?[\d.,]+$/.test(numeric)) return undefined;
    const comma = numeric.lastIndexOf(",");
    const dot = numeric.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? "," : ".";
      numeric = numeric.replace(decimal === "," ? /\./g : /,/g, "").replace(decimal, ".");
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

/** Self-contained continuation operation; it is called only through the
 * controller's action-scoped side-effect guard. */
export async function advanceDomPageInPage(
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
      ...roots.map((root) => (root.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 320)).sort(),
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

export function parseDomAdvanceResult(value: unknown): DomAdvanceResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("supplier continuation result is invalid");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "advanced" || raw.kind === "failed" || raw.kind === "exhausted") return { kind: raw.kind };
  if (raw.kind === "navigate" && typeof raw.url === "string" && raw.url.length <= 1_200) {
    let url: URL;
    try { url = new URL(raw.url); } catch { throw new Error("supplier continuation result is invalid"); }
    if (url.protocol === "https:" && !url.username && !url.password) return { kind: "navigate", url: url.toString() };
  }
  throw new Error("supplier continuation result is invalid");
}
