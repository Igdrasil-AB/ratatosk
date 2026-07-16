import { describe, expect, it } from "vitest";
import { DocumentInvalid } from "../../src/core/errors";
import { networkStrategy } from "../../src/core/strategies/network";
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
});

function context(result: HttpResponse): RunContext {
  return {
    companyId: "company",
    vars: {},
    seen: { has: async () => false, add: async () => undefined },
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
