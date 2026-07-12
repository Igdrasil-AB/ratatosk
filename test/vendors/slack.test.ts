import { describe, expect, it } from "vitest";
import slack from "../../src/vendors/slack";
import { mapListResponse } from "../../src/core/strategies/network";
import type { NetworkInvoices } from "../../src/core/types";
import fixture from "./fixtures/slack.invoices.json";

/**
 * Every vendor ships a fixture test like this. Record one real list response,
 * assert the mapping. No network, no browser — just proof the paths and
 * transforms produce correct normalized refs. CI requires one per vendor.
 */
describe("slack recipe", () => {
  const list = (slack.invoices as NetworkInvoices).list;

  it("maps the list fixture into normalized invoice refs", () => {
    const refs = mapListResponse(slack.id, list, fixture);

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      vendorInvoiceId: "INV-2026-06",
      issuedAt: "2026-06-30", // ISO date, via the `date` transform
      total: "49.00", // 4900 minor units ÷ 100
      currency: "USD",
      documentUrl: "https://acme.slack.com/files/inv/INV-2026-06.pdf",
    });
  });
});
