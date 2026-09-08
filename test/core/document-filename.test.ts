import { afterEach, describe, expect, it, vi } from "vitest";
import { filenameFromContentDisposition, safeDocumentFilename } from "../../src/core/document-filename";
import { decodePageResult, pageFetchInPage, parsePageFetchResult } from "../../collector/src/platform/page-fetch";
import { networkStrategy } from "../../src/core/strategies/network";
import { makeDomStrategy } from "../../src/core/strategies/dom";
import type { InvoiceRef, RunContext, VendorRecipe } from "../../src/core/types";

const recipe = {
  id: "supplier", name: "Supplier", homepage: "https://supplier.example", hosts: ["https://supplier.example/*"],
  auth: { loginUrl: "https://supplier.example", check: { request: { url: "https://supplier.example" }, expect: { statusIn: [200] } } },
  invoices: { strategy: "network", list: { request: { url: "https://supplier.example/list" }, items: "items", map: { id: "id" } }, document: {} },
} satisfies VendorRecipe;
const ref: InvoiceRef = { vendorInvoiceId: "123", documentUrl: "https://supplier.example/document", metadataEvidence: [
  { source: "download-filename", confidence: "medium", filename: "Link  name.pdf" },
] };
afterEach(() => vi.unstubAllGlobals());

describe("supplier filenames", () => {
  it.each([
    ['attachment; filename="Invoice  123.pdf"', "Invoice  123.pdf"],
    ["attachment; filename=basic.pdf; filename*=UTF-8'sv'Faktura%20%C3%A5.pdf", "Faktura å.pdf"],
    ["inline; filename=basic.pdf; filename*=UTF-8''bad%ZZ", "basic.pdf"],
    ['attachment; filename="semi;colon.pdf"', "semi;colon.pdf"],
    ['attachment; filename="../Invoice.pdf"', "Invoice.pdf"],
    ['attachment; filename="CON.pdf"', "_CON.pdf"],
    ['attachment; filename="a.pdf"; filename="b.pdf"', undefined],
    ['attachment; filename="x.pdf"\r\nInjected: x', undefined],
    ["attachment", undefined],
  ])("parses %s", (header, expected) => expect(filenameFromContentDisposition(header)).toBe(expected));

  it("bounds Unicode names in bytes while keeping the extension and internal spaces", () => {
    const name = safeDocumentFilename("å".repeat(240) + ".PDF")!;
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(240);
    expect(name).toMatch(/\.PDF$/);
    expect(safeDocumentFilename("Invoice  123.pdf")).toBe("Invoice  123.pdf");
    expect(safeDocumentFilename("../..")).toBeUndefined();
    expect(safeDocumentFilename("invoice.cmd", "application/pdf")).toBe("invoice.cmd.pdf");
    expect(safeDocumentFilename("a".repeat(4_097))).toBeUndefined();
  });

  it("carries the header through injected page fetch, decoding, and network strategy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-1.7", {
      headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename*=UTF-8''Faktura%20%C3%A5.pdf" },
    })));
    const captured = await pageFetchInPage({ url: ref.documentUrl! });
    const response = decodePageResult({ ...captured, finalUrl: ref.documentUrl });
    const ctx = { fetch: async () => response } as unknown as RunContext;
    expect((await networkStrategy.fetchDocument(recipe, ref, {}, ctx)).filename).toBe("Faktura å.pdf");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed boundary metadata", () => {
    for (const contentDisposition of [42, "a".repeat(4_097), "a\r\nb"]) {
      expect(() => parsePageFetchResult({ ok: true, status: 200, contentType: null, base64: "", contentDisposition })).toThrow();
    }
  });

  it("uses link evidence, then generated names when the supplier supplies no header", async () => {
    const ctx = { fetch: async () => new Response("%PDF-1.7") } as unknown as RunContext;
    expect((await networkStrategy.fetchDocument(recipe, ref, {}, ctx)).filename).toBe("Link  name.pdf");
    expect((await networkStrategy.fetchDocument(recipe, { ...ref, metadataEvidence: [] }, {}, ctx)).filename)
      .toBe("supplier-unknown-123.pdf");
  });

  it.each(["direct", "url-action", "blob-action"])("preserves the filename for %s", async (mode) => {
    const document = { bytes: new TextEncoder().encode("%PDF-1.7").buffer, contentType: "application/pdf", filename: "Original.pdf" };
    const strategy = makeDomStrategy({
      run: vi.fn(), download: vi.fn(async () => document),
      resolve: async () => mode === "blob-action" ? { kind: "bytes", ...document } : { kind: "url", url: ref.documentUrl!, filename: "Action.pdf" },
    });
    const domRecipe: VendorRecipe = { ...recipe, invoices: { strategy: "dom", list: { open: recipe.homepage, steps: [], hrefsFrom: "documents" }, document: {} } };
    const actionRef: InvoiceRef = mode === "direct" ? ref : { ...ref, resolution: { kind: "semantic_action", handle: "handle" } };
    expect((await strategy.fetchDocument(domRecipe, actionRef, {}, {} as RunContext)).filename).toBe("Original.pdf");
  });
});
