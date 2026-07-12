import { describe, expect, it } from "vitest";
import vercel from "../../src/vendors/vercel";
import { mapListResponse } from "../../src/core/strategies/network";
import type { NetworkInvoices } from "../../src/core/types";
import fixture from "./fixtures/vercel.invoices.json";

describe("vercel recipe", () => {
  const list = (vercel.invoices as NetworkInvoices).list;

  it("maps invoices and carries a documentRef for the constructed PDF URL", () => {
    const refs = mapListResponse(vercel.id, list, fixture);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      vendorInvoiceId: "in_abc123",
      issuedAt: "2026-06-30",
      total: "20.00",
      currency: "USD",
      documentRef: "in_abc123", // no direct URL; document.request builds it from {documentRef}
    });
    expect(refs[0]?.documentUrl).toBeUndefined();
  });
});
