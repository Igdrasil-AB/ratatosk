import { describe, expect, it } from "vitest";
import anthropic from "../../src/vendors/anthropic";
import { mapListResponse } from "../../src/core/strategies/network";
import type { NetworkInvoices } from "../../src/core/types";
import fixture from "./fixtures/anthropic.invoices.json";

/**
 * Real capture from claude.ai billing (PII stripped). Exercises the two tricky
 * bits: there is no invoice id (dedup on created_ts) and dates are unix seconds.
 */
describe("anthropic recipe", () => {
  const list = (anthropic.invoices as NetworkInvoices).list;

  it("maps claude.ai invoices using created_ts as the stable id and epoch-seconds dates", () => {
    const refs = mapListResponse(anthropic.id, list, fixture);

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      vendorInvoiceId: "1782543567", // created_ts (no explicit id in the payload)
      issuedAt: "2026-06-27", // unix seconds → ISO date
      total: "90.00", // 9000 minor units ÷ 100
      currency: "EUR", // "eur" upper-cased
      documentUrl: "https://pay.stripe.com/invoice/acct_TEST/live_TESTTOKEN1/pdf?s=ap",
    });
  });

  it("uses cursor pagination keyed on next_page", () => {
    expect(list.paginate).toMatchObject({ cursor: "next_page" });
  });
});
