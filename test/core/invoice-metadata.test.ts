import { describe, expect, it } from "vitest";
import { resolveInvoiceMetadata } from "../../src/core/invoice-metadata";

describe("invoice metadata reconciliation", () => {
  it("resolves labelled DOM evidence without changing the stable document identity", () => {
    const ref = {
      vendorInvoiceId: "document-stable-hash",
      documentUrl: "https://assets.example/download?token=rotating",
      metadataEvidence: [{
        source: "dom-row" as const,
        confidence: "high" as const,
        invoiceNumber: "INV-1042",
        issuedAt: "2026-07-01",
        total: "499.00",
        currency: "sek",
      }],
    };

    expect(resolveInvoiceMetadata(ref)).toEqual({
      invoiceNumber: "INV-1042",
      issuedAt: "2026-07-01",
      total: "499.00",
      currency: "SEK",
    });
    expect(ref.vendorInvoiceId).toBe("document-stable-hash");
  });

  it("withholds equally strong conflicting fields instead of guessing", () => {
    expect(resolveInvoiceMetadata({
      vendorInvoiceId: "document-1",
      metadataEvidence: [
        { source: "dom-row", confidence: "high", issuedAt: "2026-07-01", total: "10.00" },
        { source: "network", confidence: "high", issuedAt: "2026-07-02", total: "20.00" },
      ],
    })).toEqual({
      conflicts: ["issuedAt", "total"],
    });
  });

  it("rejects ambiguous amounts, currency symbols, and invalid calendar dates", () => {
    expect(resolveInvoiceMetadata({
      vendorInvoiceId: "document-1",
      metadataEvidence: [{
        source: "dom-row",
        confidence: "high",
        issuedAt: "2026-02-30",
        total: "1,234,56",
        currency: "$",
      }],
    })).toEqual({});
  });

  it("lets corroborated medium evidence outrank one different medium claim", () => {
    expect(resolveInvoiceMetadata({
      vendorInvoiceId: "document-1",
      metadataEvidence: [
        { source: "download-filename", confidence: "medium", invoiceNumber: "INV-9" },
        { source: "content-disposition", confidence: "medium", invoiceNumber: "INV-9" },
        { source: "dom-row", confidence: "medium", invoiceNumber: "INV-8" },
      ],
    }).invoiceNumber).toBe("INV-9");
  });
});
