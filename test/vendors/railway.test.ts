import { describe, expect, it } from "vitest";
import railway from "../../src/vendors/railway";
import { mapListResponse } from "../../src/core/strategies/network";
import type { NetworkInvoices } from "../../src/core/types";
import fixture from "./fixtures/railway.invoices.json";

/**
 * The first recorder-authored recipe. Proves that ALL invoices in the GraphQL
 * list are mapped (not just one), cents are divided, and the Stripe hosted URL
 * is turned into the actual PDF via the `replace` transform.
 */
describe("railway recipe", () => {
  const list = (railway.invoices as NetworkInvoices).list;

  it("maps every invoice in the list", () => {
    const refs = mapListResponse(railway.id, list, fixture);
    expect(refs).toHaveLength(2); // the whole array, not just the one clicked
  });

  it("divides cents and rewrites the hosted URL to a PDF", () => {
    const refs = mapListResponse(railway.id, list, fixture);
    expect(refs[0]).toMatchObject({
      vendorInvoiceId: "in_test1",
      issuedAt: "2026-06-14",
      total: "47.62", // 4762 cents
      documentUrl: "https://pay.stripe.com/invoice/acct_TEST/live_TEST1/pdf?s=ap", // hosted page → direct PDF
    });
    expect(refs[1]?.total).toBe("20.00");
  });

  it("uses a GraphQL POST with the query body for both list and auth check", () => {
    expect(list.request.method).toBe("POST");
    expect(list.request.body).toContain("enrichCustomer");
    expect(list.request.headers?.["content-type"]).toBe("application/json"); // GraphQL needs it
    expect((railway.auth.check.request as { method?: string }).method).toBe("POST");
  });

  it("is multi-tenant: workspaceId is discovered from `me`, not hardcoded", () => {
    // No workspace uuid baked anywhere in the recipe.
    expect(JSON.stringify(railway)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    // The list body templates the discovered id…
    expect(list.request.body).toContain('"workspaceId":"{workspaceId}"');
    // …resolved from the `me` query at the workspaces path.
    const opt = railway.config?.[0];
    expect(opt?.id).toBe("workspaceId");
    expect(opt?.discover.value).toBe("data.me.workspaces.0.id");
    expect(opt?.discover.request.body).toContain('"me"');
  });
});
