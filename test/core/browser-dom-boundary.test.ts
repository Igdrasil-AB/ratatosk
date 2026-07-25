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
import { DISCOVERY_DOM_POLICY } from "../../collector/src/platform/discovery-dom-policy";
import { DocumentPermissionRequired } from "../../src/core/errors";

const driverSource = readFileSync("collector/src/platform/browser-dom-driver.ts", "utf8");
const discoverySource = readFileSync("collector/src/platform/discovery.ts", "utf8");
const observerSource = readFileSync("collector/src/platform/discovery-page-observer.ts", "utf8");
const policySource = readFileSync("collector/src/platform/discovery-dom-policy.ts", "utf8");
const pageRetrieval = { observedItems: 1, resolvedItems: 1, unresolvedItems: 0 };

describe("browser DOM boundary", () => {
  const origins = new Set(["https://vendor.example", "https://documents.example"]);

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
      [{ action: "click", selector: "button.load-more" }],
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
          ok: true,
          collected: { documents: ["https://documents.example/invoices/one.pdf"] },
          retrieval: { observedItems: 1, resolvedItems: 1, unresolvedItems: 0 },
        } }];
      }
      return [{ result: { kind: "exhausted" } }];
    });
    vi.stubGlobal("chrome", {
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
      scripting: { executeScript },
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
        ok: true,
        collected: { documents: [] },
        retrieval: { observedItems: 0, resolvedItems: 0, unresolvedItems: 0 },
      } }];
    });
    vi.stubGlobal("chrome", {
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
      scripting: { executeScript },
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
        ok: true,
        collected: { documents: [] },
        retrieval: { observedItems: 0, resolvedItems: 0, unresolvedItems: 0 },
      } }];
    });
    vi.stubGlobal("chrome", {
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
      scripting: { executeScript },
    });

    await new BrowserDomDriver(domRecipe()).run(
      "https://vendor.example/billing",
      [{ action: "extractSemanticDownloads", as: "documents", maxActions: 8 }],
    );

    expect(executeScript).toHaveBeenCalledOnce();
  });

  it("recovers a browser-observed document when navigation destroys the injected action context", async () => {
    const beforeRequest = new TestChromeEvent<Record<string, unknown>>();
    const headersReceived = new TestChromeEvent<Record<string, unknown>>();
    const beforeRedirect = new TestChromeEvent<Record<string, unknown>>();
    const downloadCreated = new TestChromeEvent<Record<string, unknown>>();
    let execution = 0;
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
          execution += 1;
          if (execution === 1) {
            beforeRequest.emit({
              tabId: 42,
              url: "https://documents.example/invoices/123.pdf",
              method: "GET",
            });
            headersReceived.emit({
              tabId: 42,
              url: "https://documents.example/invoices/123.pdf",
              method: "GET",
              responseHeaders: [{ name: "Content-Type", value: "application/pdf" }],
            });
            throw new Error("execution context was destroyed");
          }
          return [];
        }),
      },
      webRequest: {
        onBeforeRequest: beforeRequest,
        onHeadersReceived: headersReceived,
        onBeforeRedirect: beforeRedirect,
      },
      downloads: { onCreated: downloadCreated },
    });

    const driver = new BrowserDomDriver(domRecipe());
    const result = await driver.run("https://vendor.example/billing", [
      { action: "extractSemanticDownloads", as: "documents", maxActions: 8 },
    ]);

    expect(result.collected.documents).toEqual(["https://documents.example/invoices/123.pdf"]);
    expect(result.retrieval).toMatchObject({
      completeness: "complete",
      resolvedItems: 1,
      unresolvedItems: 0,
    });
    expect(beforeRequest.listenerCount).toBe(0);
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
    expect(driverSource).toContain('if (next.protocol !== "https:") return { kind: "failed" };');
    expect(driverSource).not.toContain('startsWith("javascript:")');
  });

  it("never clicks form-backed semantic controls", () => {
    expect(driverSource).toMatch(/if \(form\) \{[\s\S]{0,400}?continue;\n\s+\}/);
  });

  it("uses one run-scoped passive observer instead of per-control browser monkeypatches", () => {
    expect(driverSource).toContain("snapshotDocuments");
    expect(driverSource).not.toContain("navigator.sendBeacon =");
    expect(driverSource).not.toContain("HTMLFormElement.prototype.submit =");
    expect(driverSource).not.toContain("HTMLAnchorElement.prototype.click =");
    expect(driverSource).not.toContain("new Response(null, { status: 204 })");
    expect(observerSource).toContain("snapshotDocuments");
    expect(observerSource).toContain("snapshotActionDocuments");
    expect(observerSource).toContain("beginDocumentAction");
    expect(observerSource).toContain("originalWindowOpen");
    expect(driverSource).toContain("observer?.beginDocumentAction");
    expect(driverSource).toContain("observer?.endDocumentAction");
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
    expect(driverSource).toContain("invoiceContext");
    expect(driverSource).toContain("strongDocumentLabel");
    expect(policySource).toContain("(?:delete|remove|cancel|pay|purchase|checkout|upgrade|downgrade|authorize|logout)");
  });

  it("recognizes framework download anchors from bounded structural semantics", () => {
    expect(policySource).toContain('a:not([href])');
    expect(policySource).toContain('data-test');
    expect(policySource).toContain('data-testid');
    for (const source of [discoverySource, driverSource]) {
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
    expect(driverSource).toContain("revealInvoiceSection");
    expect(driverSource).toMatch(/sectionObserved = await revealInvoiceSection\(\)[\s\S]{0,240}?availableControls = downloadControls\(\)/);
  });

  it("waits for real download controls instead of treating an invoice section as ready", () => {
    expect(driverSource).toContain("waitForDownloadControls");
    expect(driverSource).toMatch(/await waitForDownloadControls\(\)[\s\S]{0,3500}?availableControls/);
    expect(driverSource).toContain("stableControlCountSince");
    expect(discoverySource).toContain("explicitDownloadAction");
    expect(discoverySource).toContain("semanticQuietTimer");
    expect(discoverySource).not.toMatch(/const semanticLabel = \/\(\?:download\|save\|pdf\|receipt\|invoice/);
  });

  it("dispatches custom no-href anchor controls instead of swallowing their event", () => {
    expect(driverSource).not.toContain("HTMLAnchorElement.prototype.click = function captureAnchorClick");
    expect(driverSource).toMatch(/control instanceof HTMLAnchorElement && control\.href[\s\S]{0,700}?continue;/);
    expect(driverSource).toContain("control.click()");
  });

  it("continues through lazy DOM content even when the first pass is empty", () => {
    expect(driverSource).not.toMatch(/collectedSize\(aggregate\) === 0/);
    expect(discoverySource).toContain("window.scrollTo({ top: document.documentElement.scrollHeight");
  });

  it("waits for asynchronous invoice generation instead of using a fixed click delay", () => {
    expect(driverSource).not.toContain("setTimeout(resolve, 600)");
    expect(driverSource).toContain("actionProducedDocument");
    expect(driverSource).toContain("await snapshotActionDocuments(metadata)");
    expect(driverSource).toContain("semanticCaptureDeadline");
    expect(observerSource).toMatch(
      /beginDocumentAction\(\): void \{[\s\S]{0,180}?actionDocuments\.length = 0;[\s\S]{0,120}?actionDocumentKeys\.clear\(\)/,
    );
  });

  it("applies the action cap after excluding view-only invoice controls", () => {
    expect(driverSource).toMatch(/const downloadControls =[\s\S]{0,1600}?return explicit \|\| contextualIcon/);
    expect(driverSource).toContain("controlFingerprint");
    expect(driverSource).toMatch(/for \(let actionIndex[\s\S]{0,500}?downloadControls\(\)/);
  });

  it("captures invoice-shaped blob XHRs even without a PDF content type", () => {
    expect(observerSource).toContain("this.response instanceof Blob");
    expect(observerSource).toContain("DOCUMENT_HINT");
    expect(observerSource).toContain("captureDocumentBlob");
    expect(observerSource).toContain("MAX_INLINE_PDF_BYTES");
  });

  it("captures click-generated PDF blob anchors instead of discarding their URLs", () => {
    expect(driverSource).toContain('target.protocol === "blob:"');
    expect(driverSource).toMatch(/window\.fetch\(target\.toString\(\)\)[\s\S]{0,180}?capturePdfBlob/);
    expect(observerSource).toContain("wrappedCreateObjectURL");
  });

  it("materializes a direct blob-backed anchor before treating it as a URL", () => {
    expect(driverSource).toMatch(
      /control instanceof HTMLAnchorElement && control\.href[\s\S]{0,400}?target\.protocol === "blob:"[\s\S]{0,300}?capturePdfBlob/,
    );
  });

  it("marks a recognized continuation control that does not advance as failed", () => {
    expect(driverSource).toMatch(
      /control instanceof HTMLElement[\s\S]{0,220}?kind: "advanced"[\s\S]{0,100}?kind: "failed"/,
    );
  });

  it("allows a verified download handler to mint its document without faking request outcomes", () => {
    expect(driverSource).not.toContain('if (method !== "GET") return new Response(null, { status: 204 })');
    expect(driverSource).not.toContain('this.dispatchEvent(new ProgressEvent("load"))');
    expect(driverSource).not.toContain('this.dispatchEvent(new ProgressEvent("loadend"))');
    expect(driverSource).toContain("control.click()");
  });
});

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
