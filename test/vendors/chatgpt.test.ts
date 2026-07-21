import { describe, expect, it } from "vitest";
import chatgpt from "../../src/vendors/chatgpt";
import { mapListResponse, networkStrategy } from "../../src/core/strategies/network";
import type { HttpResponse, NetworkInvoices, RequestSpec, RunContext, TokenSpec } from "../../src/core/types";
import fixture from "./fixtures/chatgpt.invoices.json";

/**
 * The recorder-authored ChatGPT recipe. The billing API is Stripe-shaped, so this
 * checks the field mapping (epoch-seconds date, cents→decimal, currency upper,
 * the DIRECT invoice_pdf) and that the finalized auth wiring is present: a cookie→
 * bearer token exchange plus the Authorization header on the backend-api calls.
 */
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

  it("continues Stripe-style history after the first 100 invoices", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `in_${index + 1}`,
      created: 1744158410 - index,
      amount_due: 2000,
      currency: "usd",
      invoice_pdf: `https://pay.stripe.com/invoice/acct_X/in_${index + 1}/pdf`,
    }));
    const requests: string[] = [];
    const response = (body: unknown): HttpResponse => ({
      status: 200,
      ok: true,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => "application/json" },
    });
    const context: RunContext = {
      companyId: "co_test",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
      fetch: async (request: RequestSpec, vars: Record<string, unknown>) => {
        const url = request.url.replace(/\{(\w+)\}/g, (_match, key) => String(vars[key] ?? ""));
        requests.push(url);
        return requests.length === 1
          ? response({ data: firstPage, has_more: true })
          : response({ data: [{ ...firstPage[0], id: "in_101" }], has_more: false });
      },
    };

    const result = await networkStrategy.list(chatgpt, { account_id: "acct_X" }, context);

    expect(result.refs).toHaveLength(101);
    expect(result.refs.at(-1)?.vendorInvoiceId).toBe("in_101");
    expect(requests).toEqual([
      "https://chatgpt.com/backend-api/invoices?limit=100&account_id=acct_X&starting_after=",
      "https://chatgpt.com/backend-api/invoices?limit=100&account_id=acct_X&starting_after=in_100",
    ]);
    expect(result.retrieval.completeness).toBe("complete");
  });

  it("marks a full page partial when continuation metadata and the last cursor are unusable", async () => {
    const capped = Array.from({ length: 100 }, (_, index) => ({
      id: index === 99 ? { unexpected: "cursor shape" } : `in_${index + 1}`,
      created: 1744158410 - index,
      amount_due: 2000,
      currency: "usd",
      invoice_pdf: `https://pay.stripe.com/invoice/acct_X/in_${index + 1}/pdf`,
    }));
    const context: RunContext = {
      companyId: "co_test",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "reservation", release: async () => undefined, add: async () => undefined },
      fetch: async () => ({
        status: 200,
        ok: true,
        json: async () => ({ data: capped }),
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => "application/json" },
      }),
    };

    const result = await networkStrategy.list(chatgpt, { account_id: "acct_X" }, context);

    expect(result.retrieval).toMatchObject({ completeness: "partial", termination: "continuation_failed", pagesVisited: 1 });
  });
});
