import { describe, expect, it } from "vitest";
import railway from "../../src/vendors/railway";
import { mapListResponse } from "../../src/core/strategies/network";
import { runVendor, type StrategyMap } from "../../src/core/engine";
import { createInvoiceListResult } from "../../src/core/retrieval";
import { AuthFailure } from "../../src/core/errors";
import type { HttpResponse, NetworkInvoices, RequestSpec, RunContext } from "../../src/core/types";
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

  it.each([
    ["GraphQL errors", { errors: [{ message: "not authenticated" }], data: { me: null } }],
    ["missing user data", { data: {} }],
    ["empty application response", {}],
  ])("rejects a status-200 auth response with %s", async (_label, body) => {
    const strategy = {
      list: async () => { throw new Error("listing must not run"); },
      fetchDocument: async () => { throw new Error("document fetch must not run"); },
    };
    const ctx: RunContext = {
      companyId: "company",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "reservation", release: async () => undefined, add: async () => undefined },
      fetch: async () => response(body),
    };

    await expect(runVendor(railway, ctx, {
      network: strategy,
      html: strategy,
      dom: strategy,
    } as unknown as StrategyMap)).rejects.toBeInstanceOf(AuthFailure);
  });

  it("is multi-tenant: workspaceId is discovered from every `me` workspace, not hardcoded", () => {
    // No workspace uuid baked anywhere in the recipe.
    expect(JSON.stringify(railway)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    // The list body templates the discovered id…
    expect(list.request.body).toContain('"workspaceId":"{workspaceId}"');
    // …resolved from every workspace in the `me` query.
    const opt = railway.config?.[0];
    expect(opt?.id).toBe("workspaceId");
    expect(opt?.discover.items).toBe("data.me.workspaces");
    expect(opt?.discover.value).toBe("id");
    expect(opt?.discover.request.body).toContain('"me"');
  });

  it("executes a list traversal for each discovered billed workspace", async () => {
    const listedScopes: string[] = [];
    const strategy = {
      list: async (_recipe: typeof railway, vars: Record<string, unknown>) => {
        listedScopes.push(String(vars.workspaceId));
        return createInvoiceListResult([], {
          termination: "explicit_end",
          pagesVisited: 1,
          observedItems: 0,
          resolvedItems: 0,
          unresolvedItems: 0,
        });
      },
      fetchDocument: async () => {
        throw new Error("no documents should be fetched for empty workspace fixtures");
      },
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as unknown as StrategyMap;
    const ctx: RunContext = {
      companyId: "company",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
      fetch: async (request: RequestSpec): Promise<HttpResponse> => {
        if (request.body?.includes('"operationName":"me"')) {
          return response({ data: { me: { workspaces: [{ id: "workspace-a" }, { id: "workspace-b" }] } } });
        }
        return response({}); // Railway auth probe
      },
    };

    const result = await runVendor(railway, ctx, strategies);

    expect(listedScopes).toEqual(["workspace-a", "workspace-b"]);
    expect(result.scopes).toMatchObject({ total: 2, succeeded: 2, empty: 2, failed: 0 });
  });
});

function response(body: unknown): HttpResponse {
  return {
    status: 200,
    ok: true,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => "application/json" },
  };
}
