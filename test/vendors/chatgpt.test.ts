import { describe, expect, it } from "vitest";
import chatgpt from "../../src/vendors/chatgpt";
import { mapListResponse } from "../../src/core/strategies/network";
import type { NetworkInvoices, TokenSpec } from "../../src/core/types";

/**
 * The recorder-authored ChatGPT recipe. The billing API is Stripe-shaped, so this
 * checks the field mapping (epoch-seconds date, cents→decimal, currency upper,
 * the DIRECT invoice_pdf) and that the finalized auth wiring is present: a cookie→
 * bearer token exchange plus the Authorization header on the backend-api calls.
 */
const fixture = {
  data: [
    { id: "in_1", created: 1744158410, amount_due: 2000, currency: "usd", invoice_pdf: "https://pay.stripe.com/invoice/acct_X/live_A/pdf?s=ap" },
    { id: "in_2", created: 1741566410, amount_due: 9900, currency: "usd", invoice_pdf: "https://pay.stripe.com/invoice/acct_X/live_B/pdf?s=ap" },
  ],
};

describe("chatgpt recipe", () => {
  const list = (chatgpt.invoices as NetworkInvoices).list;

  it("maps every Stripe-shaped invoice", () => {
    const refs = mapListResponse(chatgpt.id, list, fixture);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      vendorInvoiceId: "in_1",
      total: "20.00", // 2000 cents
      currency: "USD",
      documentUrl: "https://pay.stripe.com/invoice/acct_X/live_A/pdf?s=ap",
    });
    expect(refs[0].issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/); // created is epoch seconds
    expect(refs[1].total).toBe("99.00");
  });

  it("fetches first-party and carries a bearer token on backend-api calls", () => {
    expect(chatgpt.fetchContext).toBe("page"); // Cloudflare
    const token = chatgpt.auth.token as TokenSpec;
    expect(token.request.url).toContain("/api/auth/session");
    expect(token.value).toBe("accessToken");
    expect(list.request.headers?.authorization).toBe("Bearer {token}");
    expect(chatgpt.auth.check.request.headers?.authorization).toBe("Bearer {token}");
  });

  it("is multi-tenant: account_id is discovered per user, not hardcoded", () => {
    // No literal account uuid anywhere in the recipe.
    expect(JSON.stringify(chatgpt)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    // The list URL templates the discovered id…
    expect(list.request.url).toContain("account_id={account_id}");
    // …resolved from the accounts endpoint (with the bearer header, at the stable path).
    const opt = chatgpt.config?.[0];
    expect(opt?.id).toBe("account_id");
    expect(opt?.discover.request.url).toContain("/backend-api/accounts/check");
    expect(opt?.discover.request.headers?.authorization).toBe("Bearer {token}");
    expect(opt?.discover.value).toBe("accounts.default.account.account_id");
    expect(opt?.discover.items).toBeUndefined(); // scalar discovery (single value)
  });
});
