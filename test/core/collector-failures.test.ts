import { describe, expect, it } from "vitest";
import { runVendor, type StrategyMap } from "../../src/core/engine";
import { UnexpectedResponse } from "../../src/core/errors";
import type { HttpResponse, RunContext, VendorRecipe } from "../../src/core/types";

const recipe = {
  id: "scopes",
  name: "Scopes",
  homepage: "https://billing.example",
  hosts: ["https://billing.example/*"],
  auth: { check: { request: { url: "https://billing.example/me" }, expect: { statusIn: [200] } }, loginUrl: "https://billing.example/login" },
  config: [{ id: "account", discover: { request: { url: "https://billing.example/accounts" }, items: "items", value: "id" } }],
  invoices: { strategy: "network", list: { request: { url: "https://billing.example/invoices" }, items: "items", map: { id: "id" } }, document: {} },
} as unknown as VendorRecipe;

describe("Collector operational outcomes", () => {
  it("returns documents with bounded partial-scope metadata and represents empty scopes", async () => {
    const result = await runVendor(recipe, context(["good", "empty", "bad"]), strategies());
    expect(result.documents).toHaveLength(1);
    expect(result.scopes).toEqual({
      total: 3,
      succeeded: 2,
      empty: 1,
      failed: 1,
      failureCodes: ["recipe_incompatible"],
    });
  });

  it("keeps an all-scope failure as an error", async () => {
    await expect(runVendor(recipe, context(["bad"]), strategies())).rejects.toBeInstanceOf(UnexpectedResponse);
  });
});

function strategies(): StrategyMap {
  const strategy = {
    async list(_recipe: VendorRecipe, vars: Record<string, unknown>) {
      if (vars.account === "bad") throw new UnexpectedResponse(403, "scope unavailable", "scopes");
      if (vars.account === "empty") return [];
      return [{ vendorInvoiceId: "invoice-1", issuedAt: "2026-07-16", documentUrl: "https://billing.example/invoice.pdf" }];
    },
    async fetchDocument() {
      return { bytes: new TextEncoder().encode("%PDF").buffer, contentType: "application/pdf", filename: "invoice.pdf" };
    },
  };
  return { network: strategy, html: strategy, dom: strategy };
}

function context(accounts: string[]): RunContext {
  return {
    companyId: "company",
    vars: {},
    seen: { has: async () => false, add: async () => undefined },
    fetch: async (spec): Promise<HttpResponse> => ({
      status: 200,
      ok: true,
      json: async () => spec.url.endsWith("/accounts") ? { items: accounts.map((id) => ({ id })) } : {},
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => "application/json" },
    }),
  };
}
