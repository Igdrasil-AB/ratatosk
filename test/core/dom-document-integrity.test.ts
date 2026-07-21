import { describe, expect, it, vi } from "vitest";
import { makeDomStrategy, type DomDriver, type DomDriverRunResult } from "../../src/core/strategies/dom";
import { runVendor } from "../../src/core/engine";
import { idempotencyKey } from "../../src/core/dedup";
import { DocumentInvalid, DocumentTooLarge } from "../../src/core/errors";
import { MAX_DOCUMENT_BYTES } from "../../src/core/document-size";
import type { VendorRecipe } from "../../src/core/types";

const recipe: VendorRecipe = {
  id: "dom-test",
  name: "DOM Test",
  homepage: "https://vendor.example",
  hosts: ["https://vendor.example/*"],
  auth: { check: { request: { url: "https://vendor.example/account" }, expect: { statusIn: [200] } }, loginUrl: "https://vendor.example" },
  invoices: {
    strategy: "dom",
    list: {
      open: "https://vendor.example/billing",
      steps: [{ action: "extractAll", selector: 'a[href$=".pdf"]', attr: "href", as: "documents" }],
      continuation: { mode: "auto", maxActions: 8, maxDocuments: 500, timeoutMs: 30_000, allowScroll: true },
      hrefsFrom: "documents",
    },
    document: { contentType: "application/pdf" },
  },
};

describe("DOM document integrity", () => {
  it("rejects oversized browser-driver documents before they enter the engine", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun(["https://vendor.example/invoice.pdf"])),
      download: vi.fn(async () => ({ bytes: new ArrayBuffer(MAX_DOCUMENT_BYTES + 1), contentType: "application/pdf" })),
    };
    const strategy = makeDomStrategy(driver);
    const [document] = (await strategy.list(recipe, {}, {} as never)).refs;

    await expect(strategy.fetchDocument(recipe, document, {}, {} as never)).rejects.toBeInstanceOf(DocumentTooLarge);
  });

  it("deduplicates extensionless and .pdf variants of the same receipt", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun([
          "https://github.com/account/receipt/ch_example",
          "https://github.com/account/receipt/ch_example.pdf",
      ])),
      download: vi.fn(),
    };
    const strategy = makeDomStrategy(driver);

    await expect(strategy.list(recipe, {}, {} as never)).resolves.toMatchObject({ refs: [
      expect.objectContaining({
        documentUrl: "https://github.com/account/receipt/ch_example.pdf",
        identityAliases: ["ch_example"],
      }),
    ], retrieval: { completeness: "complete", unresolvedItems: 0 } });
    const [ref] = (await strategy.list(recipe, {}, {} as never)).refs;
    expect(ref.vendorInvoiceId).toMatch(/^ch_example-[a-f0-9]{24}$/);
    expect(driver.run).toHaveBeenCalledWith(
      "https://vendor.example/billing",
      recipe.invoices.strategy === "dom" ? recipe.invoices.list.steps : [],
      recipe.invoices.strategy === "dom" ? recipe.invoices.list.continuation : undefined,
    );
  });

  it("derives distinct stable identities for generic download endpoints", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun([
          "https://vendor.example/download?id=invoice-1",
          "https://vendor.example/download?id=invoice-2",
      ])),
      download: vi.fn(),
    };
    const strategy = makeDomStrategy(driver);

    const first = (await strategy.list(recipe, {}, {} as never)).refs;
    expect(first).toHaveLength(2);
    expect(first[0].vendorInvoiceId).not.toBe(first[1].vendorInvoiceId);
    expect(first.every((ref) => ref.vendorInvoiceId.startsWith("document-"))).toBe(true);

    driver.run = vi.fn(async () => domRun([
        "https://vendor.example/download?id=invoice-2",
        "https://vendor.example/download?id=invoice-1",
    ]));
    const reordered = (await strategy.list(recipe, {}, {} as never)).refs;
    expect(new Map(reordered.map((ref) => [ref.documentUrl, ref.vendorInvoiceId]))).toEqual(
      new Map(first.map((ref) => [ref.documentUrl, ref.vendorInvoiceId])),
    );
  });

  it("does not collapse distinct opaque token-addressed documents before fetching them", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun([
        "https://vendor.example/download?token=invoice-one",
        "https://vendor.example/download?token=invoice-two",
      ])),
      download: vi.fn(async (url: string) => ({
        bytes: new TextEncoder().encode(url.endsWith("invoice-one") ? "%PDF-1.7-one" : "%PDF-1.7-two").buffer,
        contentType: "application/pdf",
      })),
    };

    const strategy = makeDomStrategy(driver);
    const refs = (await strategy.list(recipe, {}, {} as never)).refs;

    expect(refs).toHaveLength(2);
    expect(refs[0].vendorInvoiceId).not.toBe(refs[1].vendorInvoiceId);

    const result = await runVendor(recipe, {
      companyId: "company",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
      fetch: vi.fn(),
    }, { dom: strategy, network: strategy, html: strategy });

    expect(driver.download).toHaveBeenCalledTimes(2);
    expect(result.documents).toHaveLength(2);
  });

  it("derives distinct stable identities when different documents share a filename", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun([
        "https://vendor.example/workspace-a/invoices/INV-001.pdf",
        "https://vendor.example/workspace-b/invoices/INV-001.pdf",
      ])),
      download: vi.fn(),
    };
    const refs = (await makeDomStrategy(driver).list(recipe, {}, {} as never)).refs;

    expect(refs).toHaveLength(2);
    expect(refs.map((ref) => ref.vendorInvoiceId)).toEqual([
      expect.stringMatching(/^INV-001-[a-f0-9]{24}$/),
      expect.stringMatching(/^INV-001-[a-f0-9]{24}$/),
    ]);
    expect(refs[0].vendorInvoiceId).not.toBe(refs[1].vendorInvoiceId);
  });

  it("fetches and emits distinct same-basename documents through engine scheduling", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun([
        "https://vendor.example/workspace-a/invoices/INV-001.pdf",
        "https://vendor.example/workspace-b/invoices/INV-001.pdf",
      ])),
      download: vi.fn(async (url: string) => ({
        bytes: new TextEncoder().encode(url.includes("workspace-a") ? "%PDF-1.7-A" : "%PDF-1.7-B").buffer,
        contentType: "application/pdf",
      })),
    };
    const strategy = makeDomStrategy(driver);

    const result = await runVendor(recipe, {
      companyId: "company",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
      fetch: vi.fn(),
    }, { dom: strategy, network: strategy, html: strategy });

    expect(driver.download).toHaveBeenCalledTimes(2);
    expect(result.documents).toHaveLength(2);
    expect(new Set(result.documents.map((document) => document.vendorInvoiceId))).toHaveLength(2);
  });

  it("keeps DOM invoice identities stable when signed query parameters rotate", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun([
        "https://attachments2.clickup.com/download?invoice_id=invoice-1&X-Amz-Date=20260720T120000Z&X-Amz-Signature=first",
      ])),
      download: vi.fn(),
    };
    const strategy = makeDomStrategy(driver);

    const first = (await strategy.list(recipe, {}, {} as never)).refs[0];
    driver.run = vi.fn(async () => domRun([
      "https://attachments2.clickup.com/download?X-Amz-Signature=second&X-Amz-Date=20260721T120000Z&invoice_id=invoice-1",
    ]));
    const second = (await strategy.list(recipe, {}, {} as never)).refs[0];

    expect(second.vendorInvoiceId).toBe(first.vendorInvoiceId);
    expect(second.identityAliases).not.toEqual(first.identityAliases);
  });

  it("migrates a delivered signed-URL identity without downloading it again", async () => {
    const href = "https://attachments2.clickup.com/download?invoice_id=invoice-1&X-Amz-Date=20260720T120000Z&X-Amz-Signature=first";
    const driver: DomDriver = {
      run: vi.fn(async () => domRun([href])),
      download: vi.fn(async () => ({ bytes: new TextEncoder().encode("%PDF-1.7").buffer, contentType: "application/pdf" })),
    };
    const strategy = makeDomStrategy(driver);
    const ref = (await strategy.list(recipe, {}, {} as never)).refs[0];
    const legacyIdentity = ref.identityAliases?.[0];
    expect(legacyIdentity).toBeDefined();
    const legacyKey = await idempotencyKey("company", `ext:${recipe.id}`, legacyIdentity!);
    const migratedKeys: string[] = [];

    const result = await runVendor(recipe, {
      companyId: "company",
      vars: {},
      seen: {
        has: async (key) => key === legacyKey,
        claimIfAbsent: async () => "test-reservation",
        release: async () => undefined,
        add: async (key) => { migratedKeys.push(key); },
      },
      fetch: vi.fn(),
    }, { dom: strategy, network: strategy, html: strategy });

    expect(result.documents).toEqual([]);
    expect(driver.download).not.toHaveBeenCalled();
    expect(migratedKeys).toEqual([
      await idempotencyKey("company", `ext:${recipe.id}`, ref.vendorInvoiceId),
    ]);
  });

  it("uses the exact DOM list as authentication evidence without a redundant page GET", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun(["https://vendor.example/invoice.pdf"])),
      download: vi.fn(async () => ({ bytes: new TextEncoder().encode("%PDF-1.7").buffer, contentType: "application/pdf" })),
    };
    const strategy = makeDomStrategy(driver);
    const fetch = vi.fn(async () => { throw new Error("the DOM recipe must not issue an auth GET"); });
    const result = await runVendor(recipe, {
      companyId: "company",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
      fetch,
    }, { dom: strategy, network: strategy, html: strategy });

    expect(result.documents).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a PDF signature and normalizes its content type", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun(["https://vendor.example/invoice.pdf"])),
      download: vi.fn(async () => ({ bytes: new TextEncoder().encode("%PDF-1.7").buffer, contentType: "application/pdf; charset=binary" })),
    };
    const strategy = makeDomStrategy(driver);
    const ref = (await strategy.list(recipe, {}, {} as never)).refs[0];
    await expect(strategy.fetchDocument(recipe, ref, {}, {} as never)).resolves.toMatchObject({ contentType: "application/pdf" });
  });

  it("accepts a magic-checked PDF even when object storage reports a generic MIME type", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun(["https://vendor.example/invoice.pdf"])),
      download: vi.fn(async () => ({ bytes: new TextEncoder().encode("%PDF-1.7").buffer, contentType: "application/octet-stream" })),
    };
    const strategy = makeDomStrategy(driver);
    const ref = (await strategy.list(recipe, {}, {} as never)).refs[0];

    await expect(strategy.fetchDocument(recipe, ref, {}, {} as never)).resolves.toMatchObject({
      contentType: "application/pdf",
    });
  });

  it("rejects an HTML login page disguised as an invoice", async () => {
    const driver: DomDriver = {
      run: vi.fn(async () => domRun([])),
      download: vi.fn(async () => ({ bytes: new TextEncoder().encode("<html>login</html>").buffer, contentType: "text/html" })),
    };
    const strategy = makeDomStrategy(driver);
    await expect(strategy.fetchDocument(recipe, {
      vendorInvoiceId: "invoice-1",
      issuedAt: "",
      documentUrl: "https://vendor.example/invoice.pdf",
    }, {}, {} as never)).rejects.toBeInstanceOf(DocumentInvalid);
  });
});

function domRun(documents: string[]): DomDriverRunResult {
  return {
    collected: { documents },
    retrieval: {
      completeness: "complete",
      termination: "explicit_end",
      pagesVisited: 1,
      observedItems: documents.length,
      resolvedItems: documents.length,
      unresolvedItems: 0,
    },
  };
}
