import { describe, expect, it } from "vitest";
import { AuthExpired, DocumentInvalid, DocumentTooLarge, ResponseTooLarge } from "../../src/core/errors";
import { networkStrategy } from "../../src/core/strategies/network";
import { MAX_DOCUMENT_BYTES } from "../../src/core/document-size";
import type { HttpResponse, InvoiceRef, RunContext, VendorRecipe } from "../../src/core/types";

const recipe = {
  id: "integrity",
  name: "Integrity",
  homepage: "https://billing.example",
  hosts: ["https://billing.example/*"],
  auth: { check: { request: { url: "https://billing.example/me" }, expect: { statusIn: [200] } }, loginUrl: "https://billing.example/login" },
  invoices: {
    strategy: "network",
    list: { request: { url: "https://billing.example/invoices" }, items: "items", map: { id: "id" } },
    document: { contentType: "application/pdf" },
  },
} as unknown as VendorRecipe;

const ref: InvoiceRef = {
  vendorInvoiceId: "invoice-1",
  issuedAt: "2026-07-16",
  documentUrl: "https://billing.example/invoice-1.pdf",
};

describe("network PDF integrity", () => {
  it.each([
    ["valid PDF", "application/pdf; charset=binary", "%PDF-1.7", true],
    ["valid PDF without content type", null, "%PDF-1.7", true],
    ["valid PDF served as generic binary", "application/octet-stream", "%PDF-1.7", true],
    ["valid PDF served with stale HTML metadata", "text/html", "%PDF-1.7", true],
    ["HTML interstitial", "text/html", "<html>login</html>", false],
    ["mislabeled binary", "application/pdf", "NOT-A-PDF", false],
    ["empty body", "application/pdf", "", false],
  ])("handles %s", async (_name, contentType, body, accepted) => {
    const ctx = context(response(contentType, body));
    const operation = networkStrategy.fetchDocument(recipe, ref, {}, ctx);
    if (accepted) {
      await expect(operation).resolves.toMatchObject({ contentType: "application/pdf" });
    } else {
      await expect(operation).rejects.toBeInstanceOf(DocumentInvalid);
    }
  });

  it("surfaces a document-time 401 as an expired vendor session", async () => {
    await expect(networkStrategy.fetchDocument(recipe, ref, {}, context({
      ...response(null, ""),
      status: 401,
      ok: false,
    }))).rejects.toBeInstanceOf(AuthExpired);
  });

  it("rejects declared and streamed documents that exceed the byte budget", async () => {
    await expect(networkStrategy.fetchDocument(recipe, ref, {}, context({
      ...response("application/pdf", "%PDF"),
      headers: { get: (name) => name.toLowerCase() === "content-length" ? String(MAX_DOCUMENT_BYTES + 1) : "application/pdf" },
    }))).rejects.toBeInstanceOf(DocumentTooLarge);

    await expect(networkStrategy.fetchDocument(recipe, ref, {}, context({
      ...response("application/pdf", "%PDF"),
      arrayBuffer: async () => { throw new ResponseTooLarge(MAX_DOCUMENT_BYTES); },
    }))).rejects.toBeInstanceOf(DocumentTooLarge);

    await expect(networkStrategy.fetchDocument(recipe, ref, {}, context({
      ...response("application/pdf", "%PDF"),
      arrayBuffer: async () => new ArrayBuffer(MAX_DOCUMENT_BYTES + 1),
    }))).rejects.toBeInstanceOf(DocumentTooLarge);
  });
});

function context(result: HttpResponse): RunContext {
  return {
    companyId: "company",
    vars: {},
    seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
    fetch: async () => result,
  };
}

function response(contentType: string | null, body: string): HttpResponse {
  return {
    status: 200,
    ok: true,
    json: async () => ({}),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
  };
}
