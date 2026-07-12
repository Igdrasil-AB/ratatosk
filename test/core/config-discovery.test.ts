import { describe, expect, it } from "vitest";
import { runVendor } from "../../src/core/engine";
import { networkStrategy } from "../../src/core/strategies/network";
import { htmlStrategy } from "../../src/core/strategies/html";
import { unavailableDomStrategy } from "../../src/core/strategies/dom";
import { render } from "../../src/core/template";
import type { HttpResponse, RequestSpec, RunContext, VendorRecipe } from "../../src/core/types";

/**
 * Scalar config discovery: a recipe can discover a SINGLE value (no `items`
 * array) — e.g. the account_id a multi-tenant API needs in its URL — read
 * straight off the response root, then template it into the list request. This
 * is what makes a recorder-authored, id-in-the-URL recipe work for any user.
 */
const recipe = {
  id: "scoped",
  name: "Scoped",
  homepage: "https://api.example",
  hosts: ["https://api.example/*"],
  auth: { check: { request: { url: "https://api.example/me" }, expect: { statusIn: [200] } }, loginUrl: "https://api.example/login" },
  config: [
    {
      id: "account_id",
      discover: { request: { url: "https://api.example/accounts/check" }, value: "accounts.default.account.account_id" },
    },
  ],
  invoices: {
    strategy: "network",
    list: {
      request: { url: "https://api.example/invoices?account_id={account_id}" },
      items: "data",
      map: { id: "id", issuedAt: { path: "created", transforms: [{ kind: "date" }] }, documentUrl: "pdf" },
    },
    document: { contentType: "application/pdf" },
  },
} as unknown as VendorRecipe;

describe("scalar config discovery", () => {
  it("discovers a single id off the root and templates it into the list URL", async () => {
    let invoicesUrl = "";
    const fetch = (spec: RequestSpec, vars: Record<string, unknown>): Promise<HttpResponse> => {
      const url = render(spec.url, vars);
      if (url.endsWith("/me")) return json(200, { ok: true });
      if (url.includes("/accounts/check")) {
        return json(200, { accounts: { default: { account: { account_id: "acct_123" } } } });
      }
      if (url.includes("/invoices")) {
        invoicesUrl = url; // capture the resolved URL
        return json(200, { data: [{ id: "in_1", created: "2026-06-01T00:00:00Z", pdf: "https://api.example/in_1.pdf" }] });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode("%PDF").buffer,
        headers: { get: () => "application/pdf" },
      });
    };
    const ctx: RunContext = { companyId: "co", vars: {}, seen: { has: async () => false, add: async () => {} }, fetch };

    const result = await runVendor(recipe, ctx, { network: networkStrategy, dom: unavailableDomStrategy, html: htmlStrategy });

    expect(invoicesUrl).toBe("https://api.example/invoices?account_id=acct_123"); // the discovered id was substituted
    expect(result.documents).toHaveLength(1);
  });
});

function json(status: number, body: unknown): Promise<HttpResponse> {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => "application/json" },
  });
}
