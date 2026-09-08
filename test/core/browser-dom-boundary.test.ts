import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserDomDriver,
  InlineDocumentStore,
  isSafeInvoiceSectionLabel,
  materializeInlinePdfDataUrl,
  parseDomAdvanceResult,
  parseDomRunResult,
  requiresDisposableDomTab,
  runDomStepsInPage,
} from "../../collector/src/platform/browser-dom-driver";
import {
  DocumentActionController,
  removeStaleNativeDownloadGuards,
  runSemanticDocumentOperationInPage,
} from "../../collector/src/platform/document-action-controller";
import { DISCOVERY_DOM_POLICY } from "../../collector/src/platform/discovery-dom-policy";
import { collectPageEvidenceInPage } from "../../collector/src/platform/discovery";
import { EXPLORATION_ROUTE_POLICY } from "../../collector/src/platform/discovery-explorer";
import { AuthExpired, DocumentPermissionRequired } from "../../src/core/errors";

const driverSource = readFileSync("collector/src/platform/browser-dom-driver.ts", "utf8");
const actionControllerSource = readFileSync("collector/src/platform/document-action-controller.ts", "utf8");
const discoverySource = readFileSync("collector/src/platform/discovery.ts", "utf8");
const collectorSource = readFileSync("collector/src/platform/collector.ts", "utf8");
const runtimeSource = readFileSync("collector/src/platform/runtime.ts", "utf8");
const observerSource = readFileSync("collector/src/platform/discovery-page-observer.ts", "utf8");
const policySource = readFileSync("collector/src/platform/discovery-dom-policy.ts", "utf8");
const pageRetrieval = { observedItems: 1, resolvedItems: 1, unresolvedItems: 0 };
const emptySemanticEnumeration = {
  ok: true,
  kind: "enumeration",
  directDocuments: [],
  actions: [],
  observedItems: 0,
  resolvedItems: 0,
  unresolvedItems: 0,
  unstableItems: 0,
  ambiguousItems: 0,
  truncated: false,
  navigationSteps: 0,
  sectionObserved: false,
  replay: {
    planKind: "semantic_dom",
    phases: [{ phase: "document_enumeration", result: "complete", durationMs: 0 }],
  },
} as const;

describe("browser DOM boundary", () => {
  const origins = new Set(["https://vendor.example", "https://documents.example"]);

  it("keeps preview and connected collection on one browser replay executor", () => {
    expect(discoverySource).toContain("buildStrategies(previewRecipe");
    expect(collectorSource).toContain("buildStrategies(recipe");
    expect(runtimeSource.match(/new BrowserDomDriver\(/g)).toHaveLength(1);
    expect(discoverySource).not.toContain("new BrowserDomDriver(");
    expect(collectorSource).not.toContain("new BrowserDomDriver(");
  });

  it("uses the same bounded accessible-name inputs in discovery and document collection", () => {
    for (const source of [discoverySource, actionControllerSource]) {
      expect(source).toContain("accessibleLabelSources");
      expect(source).toContain('getAttribute("aria-labelledby")');
      expect(source).toContain('querySelectorAll<HTMLLabelElement>("label[for]")');
      expect(source).toContain('getAttribute("aria-label")');
    }
  });

  it("records passive SPA routes without retaining query values or changing action ownership", () => {
    expect(observerSource).toContain("snapshotRoutes");
    expect(observerSource).toContain("captureObservedNavigation");
    expect(observerSource).toContain("wrappedPushState");
    expect(observerSource).toContain("history.pushState = originalPushState");
    expect(observerSource).not.toContain("Cookie");
  });

  it("proves a speculative menu branch by finding Settings inside the revealed menu", () => {
    expect(discoverySource).toContain("settingsControlAfterMenu");
    expect(discoverySource).toContain("'[role=\"menu\"]'");
    expect(discoverySource).toContain("semanticNavigationControl(settingsNavigation, root)");
    expect(discoverySource).not.toContain("let settingsReady = Boolean(semanticNavigationControl(settingsNavigation))");
  });

  it("keeps same-origin frame discovery passive and network-only", () => {
    expect(discoverySource).toContain("target: { tabId, allFrames: true }");
    expect(discoverySource).toContain("topLevelFrame && options.allowSemanticNavigation !== false");
    expect(discoverySource).toContain("mergeFrameNetworkEvidence(main, frames, options.maxResources)");
    expect(discoverySource).not.toContain("[data-route],[routerlink],[ng-reflect-router-link],iframe[src]");
  });

  it.each([
    ["blocks a mutation", "{}", true, false, false],
    ["allows an explicit read-only GraphQL query", JSON.stringify({ query: "query Billing { invoices { id } }" }), false, false, true],
    ["ignores a blocked background mutation", "{}", false, true, false],
  ] as const)("%s from a pre-connect navigation control", async (_name, body, blocked, background, reachesNetwork) => {
    const originalFetch = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    class PageElement {
      textContent = "Workspace menu";
      id = "";
      parentElement = null;
      getAttribute(name: string): string | null {
        return name === "aria-haspopup" ? "menu" : name === "aria-label" ? "Workspace menu" : null;
      }
      hasAttribute(): boolean { return false; }
      closest(): null { return null; }
      querySelector(): null { return null; }
      querySelectorAll(): unknown[] { return []; }
      getBoundingClientRect() { return { width: 120, height: 32 }; }
      click(): void {
        if (!background) {
          void (window.fetch as typeof fetch)("https://vendor.example/api/account", { method: "POST", body }).catch(() => undefined);
        }
      }
      dispatchEvent(): boolean { return true; }
    }
    const trigger = new PageElement();
    let backgroundQueued = false;
    const documentStub = {
      title: "Vendor",
      activeElement: trigger,
      documentElement: { outerHTML: "<html></html>", scrollHeight: 0 },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("aria-haspopup") && background && !backgroundQueued) {
          backgroundQueued = true;
          queueMicrotask(() => {
            void (window.fetch as typeof fetch)("https://vendor.example/api/background", { method: "POST", body }).catch(() => undefined);
          });
        }
        return selector.includes("aria-haspopup") ? [trigger] : [];
      },
    };
    const windowStub: Record<string, unknown> = {
      fetch: originalFetch,
      open: vi.fn(),
      scrollTo: vi.fn(),
    };
    windowStub.top = windowStub;
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal("location", {
      origin: "https://vendor.example",
      href: "https://vendor.example/home",
      pathname: "/home",
      search: "",
    });
    vi.stubGlobal("fetch", originalFetch);
    vi.stubGlobal("performance", { getEntriesByType: () => [] });
    vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    vi.stubGlobal("HTMLElement", PageElement);
    vi.stubGlobal("HTMLAnchorElement", class extends PageElement {});
    vi.stubGlobal("KeyboardEvent", class {});

    try {
      const probe = collectPageEvidenceInPage(
        { settleMs: 0, maxResources: 1, deadlineMs: 25, allowSemanticNavigation: true },
        { ...EXPLORATION_ROUTE_POLICY, documentSelector: "[data-document]" },
        DISCOVERY_DOM_POLICY,
      );
      if (blocked) {
        await expect(probe).resolves.toMatchObject({
          origin: "https://vendor.example",
          stats: { semanticNavigationStatus: "mutation_blocked" },
        });
        expect(originalFetch).not.toHaveBeenCalled();
      } else {
        await expect(probe).resolves.toMatchObject({
          origin: "https://vendor.example",
          stats: { semanticNavigationStatus: "complete" },
        });
        expect(originalFetch).toHaveBeenCalledTimes(reachesNetwork ? 1 : 0);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("emits every packaged passive route-evidence lane from the real page probe", async () => {
    const observedRequest = "https://vendor.example/api/billing-feed";
    const resourceRoute = "https://vendor.example/receipts-history";
    const structuredRoute = "https://vendor.example/surface/r7";
    const script = { textContent: JSON.stringify({ invoiceRoute: structuredRoute }), outerHTML: "<script></script>" };
    const pageFetch = vi.fn(async () => new Response(JSON.stringify({ ready: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const windowStub: Record<string, unknown> = {
      fetch: pageFetch,
      open: vi.fn(),
      scrollTo: vi.fn(),
      __ratatoskDiscoveryObserverV1: {
        snapshotRoutes: async () => [],
        snapshot: async () => [{
          url: observedRequest,
          method: "GET",
          status: 200,
          contentType: "application/json",
          responseBody: JSON.stringify({ ready: true }),
        }],
      },
    };
    windowStub.top = windowStub;
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("document", {
      title: "Vendor",
      documentElement: { outerHTML: "<html></html>", scrollHeight: 0 },
      querySelector: (selector: string) => selector.includes('script[type="application/json"]') ? script : null,
      querySelectorAll: (selector: string) => selector.includes('script[type="application/json"]') ? [script] : [],
    });
    vi.stubGlobal("location", {
      origin: "https://vendor.example",
      href: "https://vendor.example/home",
      pathname: "/home",
      search: "",
    });
    vi.stubGlobal("fetch", pageFetch);
    vi.stubGlobal("performance", { getEntriesByType: () => [{ name: resourceRoute }] });

    try {
      const evidence = await collectPageEvidenceInPage(
        { settleMs: 0, maxResources: 4, deadlineMs: 1_000, allowSemanticNavigation: false, allowScroll: false },
        { ...EXPLORATION_ROUTE_POLICY, documentSelector: "[data-document]" },
        DISCOVERY_DOM_POLICY,
      );
      if ("__ratatoskProbeError" in evidence) throw new Error("expected page evidence");
      expect(evidence.navigationUrls).toEqual(expect.arrayContaining([
        expect.objectContaining({ url: observedRequest, hintSource: "observed_request" }),
        expect.objectContaining({ url: resourceRoute, hintSource: "resource_timing" }),
        expect.objectContaining({ url: structuredRoute, hintSource: "structured_data" }),
      ]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts only bounded HTTPS results from recipe-approved origins", () => {
    expect(parseDomRunResult({
      ok: true,
      collected: { documents: ["https://documents.example/invoice.pdf"] },
      retrieval: pageRetrieval,
    }, origins)).toEqual({
      ok: true,
      collected: { documents: ["https://documents.example/invoice.pdf"] },
      retrieval: pageRetrieval,
    });

    expect(() => parseDomRunResult({
      ok: true,
      collected: { documents: ["https://attacker.example/invoice.pdf"] },
      retrieval: pageRetrieval,
    }, origins)).toThrow(/DOM result/);
    expect(() => parseDomRunResult({
      ok: true,
      collected: { documents: Array.from({ length: 501 }, (_, index) => `https://vendor.example/${index}.pdf`) },
      retrieval: pageRetrieval,
    }, origins)).toThrow(/DOM result/);
  });

  it("admits bounded metadata only when it belongs to a collected document URL", () => {
    expect(parseDomRunResult({
      ok: true,
      collected: { documents: ["https://documents.example/invoice.pdf"] },
      documents: [{
        url: "https://documents.example/invoice.pdf",
        evidence: [{
          source: "dom-row",
          confidence: "high",
          invoiceNumber: "INV-4",
          issuedAt: "2026-07-04",
          total: "49.00",
          currency: "EUR",
        }],
      }, {
        url: "https://documents.example/not-collected.pdf",
        evidence: [{ source: "dom-row", confidence: "high", invoiceNumber: "wrong" }],
      }],
      retrieval: pageRetrieval,
    }, origins)).toMatchObject({
      documents: [{
        url: "https://documents.example/invoice.pdf",
        evidence: [expect.objectContaining({ invoiceNumber: "INV-4" })],
      }],
    });
  });

  it("turns action-produced foreign document URLs into exact permission requirements", () => {
    let error: unknown;
    try {
      parseDomRunResult({
        ok: true,
        collected: {
          documents: [
            "https://assets.withorb.com/invoices/one?signature=secret-one",
            "https://assets.withorb.com/invoices/two?signature=secret-two",
          ],
        },
        retrieval: { observedItems: 2, resolvedItems: 2, unresolvedItems: 0 },
      }, origins, true);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DocumentPermissionRequired);
    expect((error as DocumentPermissionRequired).provider).toBe("semantic_action");
    expect((error as DocumentPermissionRequired).requiredOrigins).toEqual([
      "https://assets.withorb.com/*",
    ]);
    expect(JSON.stringify(error)).not.toContain("signature");
  });

  it("accepts a bounded PDF captured from a session-authenticated blob response", () => {
    const inlinePdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.7\ninvoice").toString("base64")}`;
    expect(parseDomRunResult({
      ok: true,
      collected: { documents: [inlinePdf] },
      retrieval: pageRetrieval,
    }, origins)).toEqual({
      ok: true,
      collected: { documents: [inlinePdf] },
      retrieval: pageRetrieval,
    });

    expect(() => parseDomRunResult({
      ok: true,
      collected: { documents: [`data:text/html;base64,${Buffer.from("<html>").toString("base64")}`] },
      retrieval: pageRetrieval,
    }, origins)).toThrow(/DOM result/);
  });

  it("materializes three distinct authenticated invoice blobs without collapsing them", async () => {
    const invoices = ["one", "two", "three"].map((value) =>
      `data:application/pdf;base64,${Buffer.from(`%PDF-1.7\n${value}`).toString("base64")}`);
    const materialized = await Promise.all(invoices.map((invoice) => materializeInlinePdfDataUrl(invoice)));

    expect(materialized.every(Boolean)).toBe(true);
    expect(new Set(materialized.map((document) => document?.url)).size).toBe(3);
    expect(materialized.map((document) => new TextDecoder().decode(document!.bytes))).toEqual([
      "%PDF-1.7\none",
      "%PDF-1.7\ntwo",
      "%PDF-1.7\nthree",
    ]);
  });

  it("uses a disposable tab for every continuation, not only semantic actions", () => {
    expect(requiresDisposableDomTab(
      [{ action: "extractAll", selector: 'a[href$=".pdf"]', attr: "href", as: "documents" }],
      { mode: "auto", maxActions: 8, maxDocuments: 500, timeoutMs: 30_000, allowScroll: true },
    )).toBe(true);
    expect(requiresDisposableDomTab(
      [{ action: "extractAll", selector: 'a[href$=".pdf"]', attr: "href", as: "documents" }],
      undefined,
    )).toBe(false);
    expect(requiresDisposableDomTab(
      [{ action: "extractSemanticDownloads", as: "documents", maxActions: 8 }],
      undefined,
    )).toBe(true);
  });

  it("starts the semantic action budget after the temporary supplier tab is ready", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let execution = 0;
    const create = vi.fn(async (properties: chrome.tabs.CreateProperties) => ({
      id: 42,
      windowId: 7,
      url: properties.url,
      status: "complete" as const,
    }));
    const update = vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
      if (properties.url) {
        // Loading the foreground SPA consumes nearly the full navigation
        // budget, but must not consume the later semantic action budget.
        now += 29_999;
      }
      return { id: tabId, windowId: 7, url: properties.url, status: "complete" as const };
    });
    const executeScript = vi.fn(async () => {
      execution += 1;
      if (execution === 1) {
        return [{ result: {
          ...emptySemanticEnumeration,
          directDocuments: [{
            url: "https://documents.example/invoices/one.pdf",
            evidence: [],
          }],
          observedItems: 1,
          resolvedItems: 1,
        } }];
      }
      return [{ result: { kind: "exhausted" } }];
    });
    vi.stubGlobal("chrome", {
      ...actionBoundaryChromeApis(),
      tabs: {
        create,
        get: vi.fn(async () => ({
          id: 42,
          windowId: 7,
          url: "https://vendor.example/billing",
          status: "complete",
        })),
        query: vi.fn(async () => [{ id: 11, windowId: 7, active: true, status: "complete" }]),
        update,
        remove: vi.fn(async () => undefined),
        onUpdated: new TestChromeEvent<Record<string, unknown>>(),
      },
      scripting: semanticScripting(executeScript),
    });

    try {
      const result = await new BrowserDomDriver(domRecipe()).run(
        "https://vendor.example/billing",
        [{ action: "extractSemanticDownloads", as: "documents", maxActions: 8 }],
        { mode: "auto", maxActions: 8, maxDocuments: 100, timeoutMs: 30_000, allowScroll: true },
      );

      expect(result.collected.documents).toEqual([
        "https://documents.example/invoices/one.pdf",
      ]);
      expect(create).toHaveBeenCalledWith({ url: "about:blank", active: false });
      expect(update).toHaveBeenNthCalledWith(1, 42, { active: true });
      expect(update).toHaveBeenNthCalledWith(2, 42, {
        url: "https://vendor.example/billing",
        active: true,
      });
      expect(executeScript).toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps a semantic verification tab visible and restores the previous tab", async () => {
    let activeTabId = 11;
    let currentUrl = "about:blank";
    const update = vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
      if (properties.active) activeTabId = tabId;
      if (properties.url) currentUrl = properties.url;
      return { id: tabId, windowId: 7, url: currentUrl, status: "complete" } as chrome.tabs.Tab;
    });
    const executeScript = vi.fn(async () => {
      expect(activeTabId).toBe(42);
      expect(currentUrl).toBe("https://vendor.example/billing");
      return [{ result: {
        ...emptySemanticEnumeration,
      } }];
    });
    vi.stubGlobal("chrome", {
      ...actionBoundaryChromeApis(),
      tabs: {
        create: vi.fn(async () => ({ id: 42, windowId: 7, url: "about:blank", status: "complete" })),
        get: vi.fn(async () => ({
          id: 42,
          windowId: 7,
          url: currentUrl,
          status: "complete",
        })),
        query: vi.fn(async () => [{ id: activeTabId, windowId: 7, status: "complete" }]),
        update,
        remove: vi.fn(async () => undefined),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: semanticScripting(executeScript),
    });

    const driver = new BrowserDomDriver(domRecipe());
    await driver.run("https://vendor.example/billing", [
      { action: "extractSemanticDownloads", as: "documents", maxActions: 8 },
    ]);

    expect(update).toHaveBeenNthCalledWith(1, 42, { active: true });
    expect(update).toHaveBeenNthCalledWith(2, 42, {
      url: "https://vendor.example/billing",
      active: true,
    });
    expect(update).toHaveBeenNthCalledWith(3, 11, { active: true });
    expect(activeTabId).toBe(11);
  });

  it("waits for the supplier URL to commit instead of trusting the about:blank status", async () => {
    const onUpdated = new TestChromeEvent<unknown>();
    let committed = false;
    const executeScript = vi.fn(async () => {
      expect(committed).toBe(true);
      return [{ result: {
        ...emptySemanticEnumeration,
      } }];
    });
    vi.stubGlobal("chrome", {
      ...actionBoundaryChromeApis(),
      tabs: {
        create: vi.fn(async () => ({
          id: 42,
          windowId: 7,
          url: "about:blank",
          status: "complete",
        })),
        get: vi.fn(async () => ({
          id: 42,
          windowId: 7,
          url: committed ? "https://vendor.example/billing" : "about:blank",
          status: "complete",
        })),
        query: vi.fn(async () => [{ id: 11, windowId: 7, active: true, status: "complete" }]),
        update: vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
          if (properties.url) {
            setTimeout(() => {
              committed = true;
              onUpdated.emit(tabId, {
                status: "complete",
                url: "https://vendor.example/billing",
              });
            }, 0);
            // Chrome may briefly report the pre-navigation document here.
            return { id: tabId, windowId: 7, url: "about:blank", status: "complete" };
          }
          return { id: tabId, windowId: 7, url: "about:blank", status: "complete" };
        }),
        remove: vi.fn(async () => undefined),
        onUpdated,
      },
      scripting: semanticScripting(executeScript),
    });

    await new BrowserDomDriver(domRecipe()).run(
      "https://vendor.example/billing",
      [{ action: "extractSemanticDownloads", as: "documents", maxActions: 8 }],
    );

    expectSemanticOperationCalledOnce(executeScript);
  });

  it("blocks native responses on the exact action tab without touching global downloads", async () => {
    const beforeRequest = new TestChromeEvent<Record<string, unknown>>();
    const headersReceived = new TestChromeEvent<Record<string, unknown>>();
    const beforeRedirect = new TestChromeEvent<Record<string, unknown>>();
    const downloadCreated = new TestChromeEvent<Record<string, unknown>>();
    const cancel = vi.fn(async () => undefined);
    const removeFile = vi.fn(async () => undefined);
    const erase = vi.fn(async () => []);
    const updateSessionRules = vi.fn(async (
      _options: chrome.declarativeNetRequest.UpdateRuleOptions,
    ) => undefined);
    vi.stubGlobal("chrome", {
      tabs: {
        create: vi.fn(async () => ({ id: 42, windowId: 7, status: "complete" })),
        get: vi.fn(async () => ({
          id: 42,
          windowId: 7,
          url: "https://vendor.example/billing",
          status: "complete",
        })),
        query: vi.fn(async () => [{ id: 11, windowId: 7, active: true, status: "complete" }]),
        update: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 7, status: "complete" })),
        remove: vi.fn(async () => undefined),
        onUpdated: new TestChromeEvent<Record<string, unknown>>(),
      },
      scripting: {
        registerContentScripts: vi.fn(async () => undefined),
        unregisterContentScripts: vi.fn(async () => undefined),
        executeScript: vi.fn(async () => {
          beforeRequest.emit({
            requestId: "request-1",
            tabId: 42,
            url: "https://documents.example/invoices/123.pdf",
            method: "GET",
          });
          headersReceived.emit({
            requestId: "request-1",
            tabId: 42,
            url: "https://documents.example/invoices/123.pdf",
            method: "GET",
            responseHeaders: [
              { name: "Content-Type", value: "application/pdf" },
              { name: "Content-Disposition", value: 'attachment; filename="invoice.pdf"' },
            ],
          });
          // DownloadItem has no tab id. These two events are intentionally
          // indistinguishable by URL and must both remain outside Ratatosk's
          // ownership boundary.
          downloadCreated.emit({
            id: 91,
            url: "https://documents.example/invoices/123.pdf",
            finalUrl: "https://documents.example/invoices/123.pdf",
            mime: "application/pdf",
            filename: "/Downloads/invoice.pdf",
          });
          downloadCreated.emit({
            id: 92,
            url: "https://documents.example/invoices/123.pdf",
            finalUrl: "https://documents.example/invoices/123.pdf",
            mime: "application/pdf",
            filename: "/Downloads/unrelated-user.pdf",
          });
          throw new Error("execution context was destroyed");
        }),
      },
      webRequest: {
        onBeforeRequest: beforeRequest,
        onHeadersReceived: headersReceived,
        onBeforeRedirect: beforeRedirect,
      },
      declarativeNetRequest: { updateSessionRules },
      downloads: { onCreated: downloadCreated, cancel, removeFile, erase },
    });

    const pageOwnedDownloadObservations: boolean[] = [];
    const driver = new BrowserDomDriver(
      domRecipe(),
      undefined,
      undefined,
      (attempted) => pageOwnedDownloadObservations.push(attempted),
    );
    await expect(driver.run("https://vendor.example/billing", [
      { action: "extractSemanticDownloads", as: "documents", maxActions: 8 },
    ])).rejects.toMatchObject({ kind: "document_action_side_effect" });

    expect(updateSessionRules.mock.calls[0]?.[0]).toMatchObject({
      addRules: [{
        action: { type: "block" },
        condition: {
          tabIds: [42],
          responseHeaders: expect.arrayContaining([
            { header: "content-disposition", values: ["*attachment*"] },
          ]),
        },
      }],
    });
    expect(updateSessionRules.mock.calls.at(-1)?.[0]).toMatchObject({
      removeRuleIds: expect.any(Array),
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(removeFile).not.toHaveBeenCalled();
    expect(erase).not.toHaveBeenCalled();
    expect(pageOwnedDownloadObservations).toEqual([true]);
    expect(beforeRequest.listenerCount).toBe(0);
    expect(downloadCreated.listenerCount).toBe(0);
  });

  it("removes only stale native-response guards after a worker restart", async () => {
    const updateSessionRules = vi.fn(async (
      _options: chrome.declarativeNetRequest.UpdateRuleOptions,
    ) => undefined);
    vi.stubGlobal("chrome", {
      declarativeNetRequest: {
        getSessionRules: vi.fn(async () => [
          nativeDownloadGuardRule(42),
          {
            id: 99,
            priority: 1,
            action: { type: "block" },
            condition: { tabIds: [99], urlFilter: "unrelated" },
          },
        ]),
        updateSessionRules,
      },
    });

    await removeStaleNativeDownloadGuards();

    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [42] });
  });

  it("rejects a stable semantic identity repeated across continuation pages", async () => {
    const actionId = "a".repeat(32);
    let enumeration = 0;
    const executeScript = vi.fn(async (details: { func?: unknown }) => {
      if (details.func === runSemanticDocumentOperationInPage) {
        enumeration += 1;
        return [{ result: {
          ...emptySemanticEnumeration,
          actions: [{
            actionId,
            vendorInvoiceId: `semantic-${actionId}`,
            evidence: [],
          }],
          observedItems: 1,
          resolvedItems: 1,
        } }];
      }
      return [{ result: { kind: "advanced" } }];
    });
    vi.stubGlobal("chrome", {
      ...actionBoundaryChromeApis(),
      tabs: {
        create: vi.fn(async () => ({ id: 42, windowId: 7, url: "about:blank", status: "complete" })),
        get: vi.fn(async () => ({
          id: 42,
          windowId: 7,
          url: "https://vendor.example/billing",
          status: "complete",
        })),
        query: vi.fn(async () => [{ id: 11, windowId: 7, active: true, status: "complete" }]),
        update: vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => ({
          id: tabId,
          windowId: 7,
          url: properties.url ?? "https://vendor.example/billing",
          status: "complete",
        })),
        remove: vi.fn(async () => undefined),
        onUpdated: new TestChromeEvent<Record<string, unknown>>(),
      },
      scripting: semanticScripting(executeScript),
    });

    await expect(new BrowserDomDriver(domRecipe()).run(
      "https://vendor.example/billing",
      [{ action: "extractSemanticDownloads", as: "documents", maxActions: 8 }],
      { mode: "auto", maxActions: 1, maxDocuments: 100, timeoutMs: 30_000, allowScroll: true },
    )).rejects.toMatchObject({ kind: "document_action_ambiguous" });
    expect(enumeration).toBe(2);
  });

  it("fails closed before activation when semantic identities are ambiguous or unstable", async () => {
    for (const counts of [
      { unstableItems: 1, ambiguousItems: 0, kind: "unstable_action_identity" },
      { unstableItems: 0, ambiguousItems: 2, kind: "document_action_ambiguous" },
    ]) {
      vi.stubGlobal("chrome", {
        ...actionBoundaryChromeApis(),
        scripting: {
          executeScript: vi.fn(async () => [{ result: {
            ...emptySemanticEnumeration,
            observedItems: counts.unstableItems + counts.ambiguousItems,
            unresolvedItems: counts.unstableItems + counts.ambiguousItems,
            unstableItems: counts.unstableItems,
            ambiguousItems: counts.ambiguousItems,
          } }]),
        },
      });
      const controller = new DocumentActionController(origins, "vendor");
      await expect(controller.enumerateOnTab(
        7,
        8,
        DISCOVERY_DOM_POLICY,
        Date.now() + 2_000,
      )).rejects.toMatchObject({ kind: counts.kind });
    }
  });

  it("preserves semantic authentication outcomes and refuses an unarmed page observer", async () => {
    vi.stubGlobal("chrome", {
      ...actionBoundaryChromeApis(),
      scripting: {
        registerContentScripts: vi.fn(async () => { throw new Error("unavailable"); }),
        unregisterContentScripts: vi.fn(async () => undefined),
        executeScript: vi.fn(async () => [{ result: {
          ok: false,
          code: "auth_expired",
          replay: {
            planKind: "semantic_dom",
            phases: [{ phase: "document_enumeration", result: "not_present", durationMs: 0 }],
            firstFailure: { phase: "document_enumeration", result: "not_present" },
          },
        } }]),
      },
    });
    const controller = new DocumentActionController(origins, "vendor");

    await expect(controller.registerPageObserver("https://vendor.example"))
      .rejects.toMatchObject({ kind: "document_action_ambiguous" });
    await expect(controller.enumerateOnTab(
      7,
      8,
      DISCOVERY_DOM_POLICY,
      Date.now() + 2_000,
    )).rejects.toBeInstanceOf(AuthExpired);
  });

  it("does not arm or activate a semantic action after cancellation", async () => {
    const registerContentScripts = vi.fn(async () => undefined);
    const executeScript = vi.fn(async () => []);
    vi.stubGlobal("chrome", {
      ...actionBoundaryChromeApis(),
      scripting: {
        registerContentScripts,
        unregisterContentScripts: vi.fn(async () => undefined),
        executeScript,
      },
    });
    const controller = new DocumentActionController(origins, "vendor");
    const abort = new AbortController();
    abort.abort();

    await expect(controller.resolve(
      "https://vendor.example/billing",
      "a".repeat(32),
      DISCOVERY_DOM_POLICY,
      abort.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(registerContentScripts).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("counts exactly one privacy-safe activation at the shared document-action boundary", async () => {
    let currentUrl = "about:blank";
    const onDocumentAction = vi.fn();
    const executeScript = vi.fn(async (details: { func?: unknown }) => {
      if (details.func === runSemanticDocumentOperationInPage) {
        return [{ result: {
          ok: true,
          kind: "url",
          url: "https://documents.example/invoices/one.pdf",
        } }];
      }
      return [{ result: undefined }];
    });
    vi.stubGlobal("chrome", {
      ...actionBoundaryChromeApis(),
      tabs: {
        create: vi.fn(async () => ({ id: 42, windowId: 7, url: "about:blank", status: "complete" })),
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 7,
          url: currentUrl,
          status: "complete",
        })),
        query: vi.fn(async () => [{ id: 11, windowId: 7, active: true, status: "complete" }]),
        update: vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
          if (properties.url) currentUrl = properties.url;
          return { id: tabId, windowId: 7, url: currentUrl, status: "complete" };
        }),
        remove: vi.fn(async () => undefined),
        onUpdated: new TestChromeEvent<Record<string, unknown>>(),
      },
      scripting: semanticScripting(executeScript),
    });
    const controller = new DocumentActionController(origins, "vendor", onDocumentAction);

    await expect(controller.resolve(
      "https://vendor.example/billing",
      "a".repeat(32),
      DISCOVERY_DOM_POLICY,
    )).resolves.toEqual({
      kind: "url",
      url: "https://documents.example/invoices/one.pdf",
    });
    expect(onDocumentAction).toHaveBeenCalledOnce();
  });

  it("rejects an untrusted direct-document origin returned by page code", async () => {
    vi.stubGlobal("chrome", {
      ...actionBoundaryChromeApis(),
      scripting: {
        executeScript: vi.fn(async () => [{ result: {
          ...emptySemanticEnumeration,
          directDocuments: [{ url: "https://attacker.example/invoice.pdf", evidence: [] }],
          observedItems: 1,
          resolvedItems: 1,
        } }]),
      },
    });
    const controller = new DocumentActionController(origins, "vendor");

    await expect(controller.enumerateOnTab(
      7,
      8,
      DISCOVERY_DOM_POLICY,
      Date.now() + 2_000,
    )).rejects.toThrow(/result is invalid/);
  });

  it("enforces one retained inline-PDF budget across page passes", async () => {
    const first = `data:application/pdf;base64,${Buffer.from("%PDF-first").toString("base64")}`;
    const second = `data:application/pdf;base64,${Buffer.from("%PDF-second").toString("base64")}`;
    const store = new InlineDocumentStore(12, 10);

    expect(await store.add(first)).toMatch(/^https:\/\/inline\.ratatosk\.invalid\//);
    expect(await store.add(second)).toBeUndefined();
    expect(store.retainedBytes).toBe(Buffer.byteLength("%PDF-first"));
    expect(store.exhausted).toBe(true);
  });

  it("returns a retained duplicate near the byte cap without exhausting the store", async () => {
    const first = `data:application/pdf;base64,${Buffer.from("%PDF-first").toString("base64")}`;
    const unique = `data:application/pdf;base64,${Buffer.from("%PDF-other").toString("base64")}`;
    const store = new InlineDocumentStore(Buffer.byteLength("%PDF-first"), 10);

    const retained = await store.add(first);
    expect(await store.add(first)).toBe(retained);
    expect(store.retainedBytes).toBe(Buffer.byteLength("%PDF-first"));
    expect(store.exhausted).toBe(false);

    expect(await store.add(unique)).toBeUndefined();
    expect(store.exhausted).toBe(true);
  });

  it("serializes concurrent admission so distinct PDFs cannot exceed one-document capacity", async () => {
    const values = ["first", "other"].map((suffix) =>
      `data:application/pdf;base64,${Buffer.from(`%PDF-${suffix}`).toString("base64")}`);
    const store = new InlineDocumentStore(10, 1);

    const admitted = await Promise.all(values.map((value) => store.add(value)));

    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(store.retainedBytes).toBeLessThanOrEqual(10);
    expect(store.exhausted).toBe(true);
  });

  it("uses the shared bounded document reader for remote DOM downloads", () => {
    expect(driverSource).toContain('readDocumentBytes(response, this.recipe.id)');
  });

  it("applies the recipe document cap before retaining inline PDFs", async () => {
    const first = `data:application/pdf;base64,${Buffer.from("%PDF-first").toString("base64")}`;
    const second = `data:application/pdf;base64,${Buffer.from("%PDF-second").toString("base64")}`;
    const store = new InlineDocumentStore(1_000, 10);

    expect(await store.add(first, 1)).toBeDefined();
    expect(await store.add(second, 1)).toBeUndefined();
    expect(store.exhausted).toBe(true);
  });

  it("uses a fresh inline store for each driver run", async () => {
    const inlinePdf = `data:application/pdf;base64,${Buffer.from("%PDF-one").toString("base64")}`;
    const createStore = vi.fn(() => new InlineDocumentStore(9, 1));
    const driver = new BrowserDomDriver(domRecipe(), createStore);
    stubDomRun(inlinePdf);
    const steps = [{ action: "extractAll" as const, selector: 'a[href$=".pdf"]', attr: "href", as: "documents" }];

    const first = await driver.run("https://vendor.example/billing", steps);
    const second = await driver.run("https://vendor.example/billing", steps);

    expect(createStore).toHaveBeenCalledTimes(2);
    expect(first.collected.documents).toHaveLength(1);
    expect(second.collected.documents).toHaveLength(1);
    expect(second.collected.documents).not.toEqual(first.collected.documents);
    expect(second.retrieval.completeness).toBe("complete");
    await expect(driver.download(first.collected.documents[0])).resolves.toMatchObject({ contentType: "application/pdf" });
    await expect(driver.download(second.collected.documents[0])).resolves.toMatchObject({ contentType: "application/pdf" });
  });

  it("reports rejected inline materialization as unresolved and partial", async () => {
    const inlinePdf = `data:application/pdf;base64,${Buffer.from("%PDF-too-large").toString("base64")}`;
    const driver = new BrowserDomDriver(domRecipe(), () => new InlineDocumentStore(1, 1));
    stubDomRun(inlinePdf);

    const result = await driver.run("https://vendor.example/billing", [
      { action: "extractAll", selector: 'a[href$=".pdf"]', attr: "href", as: "documents" },
    ]);

    expect(result.collected.documents).toEqual([]);
    expect(result.retrieval).toMatchObject({
      completeness: "partial",
      observedItems: 1,
      resolvedItems: 0,
      unresolvedItems: 1,
    });
  });

  it("stops injected wait steps at the absolute continuation deadline", async () => {
    vi.useFakeTimers();
    const queried: string[] = [];
    vi.stubGlobal("document", {
      querySelector: vi.fn((selector: string) => { queried.push(selector); return null; }),
    });
    vi.stubGlobal("location", { pathname: "/billing" });
    const deadline = Date.now() + 1_000;
    const execution = runDomStepsInPage([
      { action: "waitFor", selector: "#first", timeoutMs: 10_000 },
      { action: "waitFor", selector: "#later", timeoutMs: 10_000 },
    ], ["https://vendor.example"], DISCOVERY_DOM_POLICY, deadline);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(execution).resolves.toMatchObject({ ok: true, timedOut: true });
    expect(queried).toContain("#first");
    expect(queried).not.toContain("#later");
    vi.useRealTimers();
  });

  it("does not treat a dormant hidden captcha iframe as a supplier challenge", async () => {
    const hiddenCaptcha = {
      hidden: false,
      getAttribute: (name: string) => name === "aria-hidden" ? "true" : null,
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    };
    vi.stubGlobal("document", {
      querySelector: vi.fn((selector: string) =>
        selector.includes("challenge") || selector.includes("captcha") ? hiddenCaptcha : null),
      querySelectorAll: vi.fn(() => [hiddenCaptcha]),
    });
    vi.stubGlobal("getComputedStyle", vi.fn(() => ({
      display: "none",
      visibility: "visible",
      opacity: "1",
    })));
    vi.stubGlobal("location", { pathname: "/dashboard/org/example/billing" });

    await expect(runDomStepsInPage([
      { action: "waitFor", selector: "#invoice-list", timeoutMs: 0 },
    ], ["https://vendor.example"], DISCOVERY_DOM_POLICY, null)).resolves.toMatchObject({
      ok: false,
      code: "selector_miss",
    });
  });

  it("bounds a stalled page injection by the continuation deadline", async () => {
    vi.useFakeTimers();
    const remove = vi.fn(async () => undefined);
    const executeScript = vi.fn(() => new Promise<never>(() => undefined));
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: {
        create: vi.fn(async () => ({ id: 9, status: "complete" })),
        get: vi.fn(async () => ({ id: 9, status: "complete" })),
        remove,
        onUpdated: { addListener, removeListener },
      },
      scripting: { executeScript },
    });
    const driver = new BrowserDomDriver(domRecipe());
    const execution = driver.run("https://vendor.example/billing", [
      { action: "extractAll", selector: 'a[href$=".pdf"]', attr: "href", as: "documents" },
    ], { mode: "auto", timeoutMs: 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(executeScript).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(execution).resolves.toMatchObject({
      retrieval: { completeness: "partial", termination: "time_cap" },
    });
    expect(remove).toHaveBeenCalledWith(9);
    vi.useRealTimers();
  });

  it("parses only the closed continuation result vocabulary", () => {
    expect(parseDomAdvanceResult({ kind: "advanced" })).toEqual({ kind: "advanced" });
    expect(parseDomAdvanceResult({ kind: "failed" })).toEqual({ kind: "failed" });
    expect(parseDomAdvanceResult({ kind: "navigate", url: "https://vendor.example/billing?page=2" })).toEqual({
      kind: "navigate",
      url: "https://vendor.example/billing?page=2",
    });
    expect(() => parseDomAdvanceResult({ kind: "clicked", url: "javascript:alert(1)" })).toThrow(/continuation result/);
  });

  it("allows only HTTPS navigation from supplier pagination controls", () => {
    expect(actionControllerSource).toContain('if (next.protocol !== "https:") return { kind: "failed" };');
    expect(actionControllerSource).not.toContain('startsWith("javascript:")');
  });

  it("never clicks form-backed semantic controls", () => {
    expect(actionControllerSource).toContain('element.closest("form")');
    expect(actionControllerSource).toContain('candidate.control.closest("form")');
  });

  it("uses one action-scoped controller instead of promoting passive browser observations", () => {
    expect(driverSource).toContain("DocumentActionController");
    expect(actionControllerSource).toContain("beginAction");
    expect(actionControllerSource).toContain("snapshotNativeDownloadAttempted");
    expect(actionControllerSource).toContain("updateSessionRules");
    expect(actionControllerSource).not.toContain("chrome.downloads.cancel");
    expect(actionControllerSource).not.toContain("snapshotDocuments()");
    expect(driverSource).not.toContain("navigator.sendBeacon =");
    expect(driverSource).not.toContain("HTMLFormElement.prototype.submit =");
    expect(driverSource).not.toContain("HTMLAnchorElement.prototype.click =");
    expect(driverSource).not.toContain("new Response(null, { status: 204 })");
    expect(observerSource).toContain("snapshotDocuments");
    expect(observerSource).toContain("snapshotActionDocuments");
    expect(observerSource).toContain("beginDocumentAction");
    expect(observerSource).toContain("originalWindowOpen");
    expect(observerSource).toContain("captureActionNavigation");
    expect(observerSource).toContain("event.preventDefault()");
    expect(actionControllerSource).toContain("beginDocumentAction");
    expect(actionControllerSource).toContain("endDocumentAction");
    expect(observerSource).toContain("originalCreateObjectURL");
  });

  it("correlates action documents at request initiation instead of response completion", () => {
    expect(observerSource).toContain("actionScopedAtRequestStart");
    expect(observerSource).toMatch(
      /const actionScopedAtRequestStart = documentActionActive[\s\S]{0,1000}?captureJsonDocumentUrls\(body, actionScopedAtRequestStart\)/,
    );
    expect(observerSource).not.toContain("if (documentActionActive) keepActionDocumentUrl(value)");
  });

  it("requires generic download controls to sit in invoice-shaped context", () => {
    expect(actionControllerSource).toContain("invoiceContext");
    expect(actionControllerSource).toContain("strongDocumentLabel");
    expect(policySource).toContain("(?:delete|remove|cancel|pay|purchase|checkout|upgrade|downgrade|authorize|logout)");
  });

  it("recognizes framework download anchors from bounded structural semantics", () => {
    expect(policySource).toContain('a:not([href])');
    expect(policySource).toContain('data-test');
    expect(policySource).toContain('data-testid');
    for (const source of [discoverySource, actionControllerSource]) {
      expect(source).toContain("DISCOVERY_DOM_POLICY");
      expect(source).toContain('querySelector("svg,[icon],[name],[data-lucide]")');
      expect(source.indexOf('icon?.getAttribute("class")')).toBeLessThan(
        source.indexOf('element.getAttribute("class")'),
      );
    }
  });

  it("recognizes only explicit invoice-history section labels for safe reveal", () => {
    for (const label of ["Invoices", "Invoice history", "Receipts", "Billing history"]) {
      expect(isSafeInvoiceSectionLabel(label)).toBe(true);
    }
    for (const label of ["Billing", "Upgrade", "Pay invoice", "Delete invoices", "Transactions export"]) {
      expect(isSafeInvoiceSectionLabel(label)).toBe(false);
    }
  });

  it("reveals an invoice section before enumerating its per-row download controls", () => {
    expect(actionControllerSource).toContain("revealInvoiceSection");
    expect(actionControllerSource).toMatch(/await revealInvoiceSection\(\)[\s\S]{0,240}?controls = downloadControls\(\)/);
    expect(discoverySource).toContain("semanticPolicy.navigationTriggerMountMs");
    expect(actionControllerSource).toContain("semanticPolicy.navigationTriggerMountMs");
  });

  it("waits for real download controls instead of treating an invoice section as ready", () => {
    expect(actionControllerSource).toContain("waitForControls");
    expect(actionControllerSource).toMatch(/await waitForControls\(\)[\s\S]{0,3500}?candidates/);
    expect(actionControllerSource).toContain("stableSince");
    expect(discoverySource).toContain("explicitDownloadAction");
    expect(discoverySource).toContain("semanticQuietTimer");
    expect(discoverySource).not.toMatch(/const semanticLabel = \/\(\?:download\|save\|pdf\|receipt\|invoice/);
  });

  it("enumerates direct anchors without activating them and resolves no-href controls later", () => {
    expect(actionControllerSource).not.toContain("HTMLAnchorElement.prototype.click = function captureAnchorClick");
    expect(actionControllerSource).toContain("const directUrl");
    expect(actionControllerSource).toContain("candidate.control.click()");
  });

  it("continues through lazy DOM content even when the first pass is empty", () => {
    expect(driverSource).not.toMatch(/collectedSize\(aggregate\) === 0/);
    expect(discoverySource).toContain("window.scrollTo({ top: document.documentElement.scrollHeight");
  });

  it("waits for asynchronous invoice generation instead of using a fixed click delay", () => {
    expect(actionControllerSource).not.toContain("setTimeout(resolve, 600)");
    expect(actionControllerSource).toContain("observer.snapshotActionDocuments()");
    expect(actionControllerSource).toContain("actionDeadline");
    expect(observerSource).toMatch(
      /beginDocumentAction\(\): void \{[\s\S]{0,180}?actionDocuments\.length = 0;[\s\S]{0,120}?actionDocumentKeys\.clear\(\)/,
    );
  });

  it("applies the action cap after excluding view-only invoice controls", () => {
    expect(actionControllerSource).toMatch(/const downloadControls =[\s\S]{0,1600}?return explicit \|\| contextualIcon/);
    expect(actionControllerSource).toContain("stableMaterial");
    expect(actionControllerSource).toContain("operation.maximumActions");
  });

  it("never derives a cross-run action identity from presentation text or row position", () => {
    const start = actionControllerSource.indexOf("const stableMaterial");
    const end = actionControllerSource.indexOf("const digest", start);
    const identityPolicy = actionControllerSource.slice(start, end);

    expect(identityPolicy).toContain("explicitAttribute");
    expect(identityPolicy).toContain("invoiceNumber");
    expect(identityPolicy).toContain("datedAmount");
    expect(identityPolicy).toContain("stableAttributes");
    expect(identityPolicy).not.toContain("row.textContent");
    expect(identityPolicy).not.toContain("labelOf(element)");
    expect(identityPolicy).not.toContain("columnContextOf(element)");
    expect(driverSource).toContain('throw new DocumentActionFailed("document_action_ambiguous"');
  });

  it("captures invoice-shaped blob XHRs even without a PDF content type", () => {
    expect(observerSource).toContain("this.response instanceof Blob");
    expect(observerSource).toContain("DOCUMENT_HINT");
    expect(observerSource).toContain("captureDocumentBlob");
    expect(observerSource).toContain("MAX_INLINE_PDF_BYTES");
  });

  it("captures click-generated PDF blob anchors instead of discarding their URLs", () => {
    expect(actionControllerSource).toContain('target.protocol === "blob:"');
    expect(actionControllerSource).toContain("capturePdfBlob");
    expect(observerSource).toContain("wrappedCreateObjectURL");
  });

  it("materializes a direct blob-backed anchor before treating it as a URL", () => {
    expect(actionControllerSource).toMatch(
      /candidate\.control instanceof HTMLAnchorElement[\s\S]{0,400}?target\.protocol === "blob:"[\s\S]{0,400}?capturePdfBlob/,
    );
  });

  it("marks a recognized continuation control that does not advance as failed", () => {
    expect(actionControllerSource).toMatch(
      /control instanceof HTMLElement[\s\S]{0,220}?kind: "advanced"[\s\S]{0,100}?kind: "failed"/,
    );
  });

  it("allows a verified download handler to mint its document without faking request outcomes", () => {
    expect(actionControllerSource).not.toContain('if (method !== "GET") return new Response(null, { status: 204 })');
    expect(actionControllerSource).not.toContain('this.dispatchEvent(new ProgressEvent("load"))');
    expect(actionControllerSource).not.toContain('this.dispatchEvent(new ProgressEvent("loadend"))');
    expect(actionControllerSource).toContain("candidate.control.click()");
  });

  it.each([
    ["invoice", "Invoice Number"],
    ["receipt", "Receipt Number"],
    ["statement", "Statement Number"],
  ])("gives div-based %s rows a stable action identity", async (kind, numberHeader) => {
    const page = stubDivDocumentPage(kind, numberHeader);
    try {
      const result = await runSemanticDocumentOperationInPage(
        { kind: "enumerate", maximumActions: 8 },
        ["https://vendor.example"],
        DISCOVERY_DOM_POLICY,
        Date.now() + 5_000,
      );

      expect(result).toMatchObject({
        ok: true,
        kind: "enumeration",
        observedItems: 1,
        resolvedItems: 1,
        unresolvedItems: 0,
        actions: [{ evidence: [expect.objectContaining({ invoiceNumber: "DOC-001" })] }],
      });
    } finally {
      page.restore();
    }
  });

  it("extracts metadata from direct links in div-based document rows", async () => {
    const page = stubDivDocumentPage("receipt", "Receipt Number", "https://vendor.example/receipts/DOC-001.pdf");
    try {
      await expect(runDomStepsInPage([{
        action: "extractAll",
        selector: "[data-document-link]",
        attr: "data-url",
        as: "documents",
      }], ["https://vendor.example"], DISCOVERY_DOM_POLICY, null)).resolves.toMatchObject({
        ok: true,
        documents: [{ evidence: [expect.objectContaining({ invoiceNumber: "DOC-001" })] }],
      });
    } finally {
      page.restore();
    }
  });

  it("waits for each revealed billing tier to mount instead of racing one mutation", async () => {
    // Every tier of an account menu mounts asynchronously. A framework flips an
    // unrelated attribute immediately, so a single mutation resolves long
    // before the next tier exists.
    const page = stubSemanticPage();
    try {
      const result = await runSemanticDocumentOperationInPage(
        { kind: "enumerate", maximumActions: 8 },
        ["https://vendor.example"],
        DISCOVERY_DOM_POLICY,
        Date.now() + 20_000,
      );

      expect(result).toMatchObject({
        ok: true,
        kind: "enumeration",
        directDocuments: [{ url: "https://vendor.example/invoices/one.pdf" }],
      });
      expect(page.clicked).toEqual(["Open profile menu", "Settings", "Billing"]);
    } finally {
      page.restore();
    }
  }, 20_000);

  it("uses a newly revealed Settings control from a generic menu overlay", async () => {
    const page = stubSemanticPage({
      menuTriggerCount: 4,
      settingsMountDelayMs: 0,
      mountDelayMs: 900,
    });
    try {
      const result = await runSemanticDocumentOperationInPage(
        { kind: "enumerate", maximumActions: 8 },
        ["https://vendor.example"],
        DISCOVERY_DOM_POLICY,
        Date.now() + 3_400,
      );

      expect(result).toMatchObject({
        ok: true,
        kind: "enumeration",
        directDocuments: [{ url: "https://vendor.example/invoices/one.pdf" }],
      });
      expect(page.clicked).toEqual(["Open profile menu", "Settings", "Billing"]);
    } finally {
      page.restore();
    }
  }, 10_000);

  it.each([
    ["Inställningar", "Fakturering"],
    ["Einstellungen", "Abrechnung"],
    ["Paramètres", "Facturation"],
    ["Configuración", "Facturación"],
  ])("uses the packaged localized navigation policy for %s", async (settings, billing) => {
    const page = stubSemanticPage({ settings, billing, mountDelayMs: 0 });
    try {
      const result = await runSemanticDocumentOperationInPage(
        { kind: "enumerate", maximumActions: 8 },
        ["https://vendor.example"],
        DISCOVERY_DOM_POLICY,
        Date.now() + 3_000,
      );

      expect(result).toMatchObject({
        ok: true,
        kind: "enumeration",
        directDocuments: [{ url: "https://vendor.example/invoices/one.pdf" }],
      });
      expect(page.clicked).toEqual(["Open profile menu", settings, billing]);
    } finally {
      page.restore();
    }
  });

  it("treats a same-origin address-bar rewrite as the requested page committing", async () => {
    // Applications routinely restore their shell URL while keeping the
    // requested surface mounted. Demanding the exact path back would strand
    // every such supplier on a navigation timeout.
    const executeScript = vi.fn(async () => [{ result: {
      ...emptySemanticEnumeration,
    } }]);
    let committedUrl = "about:blank";
    vi.stubGlobal("chrome", {
      ...actionBoundaryChromeApis(),
      tabs: {
        create: vi.fn(async () => ({ id: 42, windowId: 7, url: "about:blank", status: "complete" })),
        get: vi.fn(async () => ({ id: 42, windowId: 7, url: committedUrl, status: "complete" })),
        query: vi.fn(async () => [{ id: 11, windowId: 7, active: true, status: "complete" }]),
        update: vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
          // The application settles the address bar back on its own shell.
          if (properties.url) committedUrl = "https://vendor.example/";
          return { id: tabId, windowId: 7, url: committedUrl, status: "complete" };
        }),
        remove: vi.fn(async () => undefined),
        onUpdated: new TestChromeEvent<Record<string, unknown>>(),
      },
      scripting: semanticScripting(executeScript),
    });

    await new BrowserDomDriver(domRecipe()).run(
      "https://vendor.example/settings/billing",
      [{ action: "extractSemanticDownloads", as: "documents", maxActions: 8 }],
    );

    expectSemanticOperationCalledOnce(executeScript);
  });
});

/**
 * A minimal account menu whose tiers mount only after the previous click.
 *
 * The elements are plain objects because the injected function is serialized
 * into a page and may only rely on the DOM surface it actually reads.
 */
function stubSemanticPage(options: {
  settings?: string;
  billing?: string;
  mountDelayMs?: number;
  settingsMountDelayMs?: number;
  menuTriggerCount?: number;
} = {}): { clicked: string[]; restore: () => void } {
  const clicked: string[] = [];
  const navigation: unknown[] = [];
  const downloads: unknown[] = [];
  const mountDelayMs = options.mountDelayMs ?? 300;
  const settingsMountDelayMs = options.settingsMountDelayMs ?? mountDelayMs;

  const control = (
    attributes: Record<string, string>,
    text: string,
    onClick: () => void = () => undefined,
  ): unknown => ({
    tagName: "BUTTON",
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 120, height: 32 }),
    textContent: text,
    click: () => {
      clicked.push(text);
      onClick();
    },
  });

  const mount = (target: unknown[], element: unknown): void => {
    setTimeout(() => target.push(element), mountDelayMs);
  };

  const billingTab = control({ role: "tab" }, options.billing ?? "Billing", () => {
    mount(downloads, control(
      { "data-href": "https://vendor.example/invoices/one.pdf" },
      "Download invoice PDF",
    ));
  });
  const settingsItem = control({ role: "menuitem" }, options.settings ?? "Settings", () => {
    mount(navigation, billingTab);
  });
  const profileTrigger = control({
    role: "button",
    "aria-label": "Open profile menu",
    "aria-haspopup": "menu",
  }, "Open profile menu", () => {
    setTimeout(() => navigation.push(settingsItem), settingsMountDelayMs);
  });
  navigation.push(profileTrigger);
  const menuTriggers = options.menuTriggerCount
    ? [profileTrigger, ...Array.from({ length: options.menuTriggerCount - 1 }, (_, index) =>
      control({ role: "button", "aria-haspopup": "menu" }, `Menu ${index + 2}`))]
    : [];

  const navigationSelector = 'button,[role="button"],[role="menuitem"],[role="tab"],a:not([href])';
  const menuTriggerSelector = 'button,[role="button"],[aria-haspopup="menu"],[aria-haspopup="true"]';
  vi.stubGlobal("document", {
    title: "Vendor",
    activeElement: { dispatchEvent: () => true },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === navigationSelector) return [...navigation];
      if (selector === menuTriggerSelector) return [...menuTriggers];
      if (selector === DISCOVERY_DOM_POLICY.controlSelector) return [...navigation, ...downloads];
      return [];
    },
  });
  vi.stubGlobal("location", { href: "https://vendor.example/settings/billing", pathname: "/settings/billing" });
  vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "1" }));
  vi.stubGlobal("window", {});
  // A framework mutation lands immediately and says nothing about the tier
  // that is still mounting.
  vi.stubGlobal("MutationObserver", class {
    constructor(private readonly callback: () => void) {}
    observe(): void { this.callback(); }
    disconnect(): void { /* no observation to release */ }
  });
  for (const name of ["HTMLElement", "HTMLAnchorElement", "HTMLButtonElement", "HTMLInputElement"]) {
    vi.stubGlobal(name, class {});
  }
  vi.stubGlobal("KeyboardEvent", class {});

  return { clicked, restore: () => vi.unstubAllGlobals() };
}

function stubDivDocumentPage(
  kind: string,
  numberHeader: string,
  documentUrl?: string,
): { restore: () => void } {
  const node = (text = "", attributes: Record<string, string> = {}) => ({
    textContent: text,
    children: [] as unknown[],
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    querySelector: () => null,
    querySelectorAll: () => [] as unknown[],
    closest: () => null,
    getBoundingClientRect: () => ({ width: 120, height: 32 }),
  });
  const headers = [node("Date"), node(numberHeader), node("Invoice Total"), node("")];
  const headerRow = { ...node(), children: headers, querySelectorAll: () => headers };
  const cells = [node("2026-08-17"), node("DOC-001"), node("$30"), node("")];
  const section = { ...node(), querySelector: () => headerRow, querySelectorAll: () => [headerRow] };
  const row = {
    ...node(`2026-08-17 DOC-001 $30 ${kind}`),
    children: cells,
    parentElement: section,
    querySelectorAll: () => cells,
    closest: (selector: string) => selector === "section,article" ? section : null,
  };
  const control = {
    ...node("", { title: `Download ${kind}`, ...(documentUrl ? { "data-url": documentUrl } : {}) }),
    closest: (selector: string) => {
      if (selector === "form") return null;
      if (selector === DISCOVERY_DOM_POLICY.cellSelector) return cells[3];
      if (selector === DISCOVERY_DOM_POLICY.rowSelector || selector === DISCOVERY_DOM_POLICY.contextSelector) return row;
      return null;
    },
  };

  vi.stubGlobal("document", {
    title: "Billing",
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === DISCOVERY_DOM_POLICY.controlSelector || selector === "[data-document-link]"
      ? [control]
      : selector === "h1,h2,h3,caption" ? [node(`${kind}s`)] : [],
  });
  vi.stubGlobal("location", { href: "https://vendor.example/settings/billing", pathname: "/settings/billing" });
  vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "1" }));
  vi.stubGlobal("window", {});
  for (const name of ["HTMLElement", "HTMLAnchorElement"]) vi.stubGlobal(name, class {});
  return { restore: () => vi.unstubAllGlobals() };
}

function domRecipe() {
  return {
    id: "dom-test",
    name: "DOM Test",
    homepage: "https://vendor.example",
    category: "test",
    hosts: ["https://vendor.example/*", "https://documents.example/*"],
    auth: { check: { request: { url: "https://vendor.example/me" }, expect: { statusIn: [200] } }, loginUrl: "https://vendor.example/login" },
    invoices: {
      strategy: "dom" as const,
      list: { open: "https://vendor.example/billing", steps: [], hrefsFrom: "documents" },
      document: { contentType: "application/pdf" },
    },
  };
}

function stubDomRun(inlinePdf: string): void {
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: "https://vendor.example/billing", status: "complete" }]),
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: {
        ok: true,
        collected: { documents: [inlinePdf] },
        retrieval: { observedItems: 1, resolvedItems: 1, unresolvedItems: 0 },
      } }]),
    },
  });
}

function actionBoundaryChromeApis(): {
  webRequest: {
    onBeforeRequest: TestChromeEvent<Record<string, unknown>>;
    onHeadersReceived: TestChromeEvent<Record<string, unknown>>;
    onBeforeRedirect: TestChromeEvent<Record<string, unknown>>;
  };
  downloads: {
    onCreated: TestChromeEvent<Record<string, unknown>>;
    cancel: ReturnType<typeof vi.fn>;
    removeFile: ReturnType<typeof vi.fn>;
    erase: ReturnType<typeof vi.fn>;
  };
  declarativeNetRequest: {
    updateSessionRules: ReturnType<typeof vi.fn>;
  };
} {
  return {
    webRequest: {
      onBeforeRequest: new TestChromeEvent<Record<string, unknown>>(),
      onHeadersReceived: new TestChromeEvent<Record<string, unknown>>(),
      onBeforeRedirect: new TestChromeEvent<Record<string, unknown>>(),
    },
    downloads: {
      onCreated: new TestChromeEvent<Record<string, unknown>>(),
      cancel: vi.fn(async () => undefined),
      removeFile: vi.fn(async () => undefined),
      erase: vi.fn(async () => []),
    },
    declarativeNetRequest: {
      updateSessionRules: vi.fn(async (
        _options: chrome.declarativeNetRequest.UpdateRuleOptions,
      ) => undefined),
    },
  };
}

function nativeDownloadGuardRule(tabId: number): chrome.declarativeNetRequest.Rule {
  return {
    id: tabId,
    priority: 1,
    action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      tabIds: [tabId],
      urlFilter: "|https",
      resourceTypes: [],
      responseHeaders: [
        { header: "content-disposition", values: ["*attachment*"] },
      ],
    },
  } as unknown as chrome.declarativeNetRequest.Rule;
}

function semanticScripting(executeScript: ReturnType<typeof vi.fn>) {
  return {
    registerContentScripts: vi.fn(async () => undefined),
    unregisterContentScripts: vi.fn(async () => undefined),
    executeScript,
  };
}

function expectSemanticOperationCalledOnce(executeScript: ReturnType<typeof vi.fn>): void {
  expect(executeScript.mock.calls.filter(([details]) =>
    details.func === runSemanticDocumentOperationInPage)).toHaveLength(1);
}

class TestChromeEvent<T> {
  private readonly listeners = new Set<(...args: T[]) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  addListener(listener: (...args: T[]) => void): void {
    this.listeners.add(listener);
  }

  removeListener(listener: (...args: T[]) => void): void {
    this.listeners.delete(listener);
  }

  emit(...args: T[]): void {
    for (const listener of this.listeners) listener(...args);
  }
}
