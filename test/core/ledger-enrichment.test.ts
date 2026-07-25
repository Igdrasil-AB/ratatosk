import { describe, expect, it } from "vitest";
import { mergeLedgerEntry, type LedgerEntry } from "../../collector/src/platform/storage";

describe("ledger metadata enrichment", () => {
  it("adds later metadata while preserving the original collection time and key", () => {
    const original: LedgerEntry = {
      key: "stable-key",
      vendorId: "supplier",
      vendorName: "Supplier",
      vendorInvoiceId: "stable-id",
      collectedAt: 100,
    };
    const enriched: LedgerEntry = {
      ...original,
      invoiceNumber: "INV-42",
      issuedAt: "2026-07-04",
      total: "42.00",
      currency: "EUR",
      collectedAt: 200,
    };

    expect(mergeLedgerEntry(original, enriched)).toMatchObject({
      key: "stable-key",
      vendorInvoiceId: "stable-id",
      invoiceNumber: "INV-42",
      issuedAt: "2026-07-04",
      total: "42.00",
      currency: "EUR",
      collectedAt: 100,
    });
  });

  it("does not erase known fields when a later retry lacks metadata", () => {
    const original: LedgerEntry = {
      key: "stable-key",
      vendorId: "supplier",
      vendorName: "Supplier",
      invoiceNumber: "INV-42",
      issuedAt: "2026-07-04",
      collectedAt: 100,
    };
    const retry: LedgerEntry = {
      key: "stable-key",
      vendorId: "supplier",
      vendorName: "Supplier",
      collectedAt: 200,
    };

    expect(mergeLedgerEntry(original, retry)).toMatchObject({
      invoiceNumber: "INV-42",
      issuedAt: "2026-07-04",
      collectedAt: 100,
    });
  });
});
