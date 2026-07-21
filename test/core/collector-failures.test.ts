import { describe, expect, it } from "vitest";
import { runVendor, type StrategyMap } from "../../src/core/engine";
import { UnexpectedResponse } from "../../src/core/errors";
import { createInvoiceListResult } from "../../src/core/retrieval";
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

  it("keeps an all-scope document-fetch failure as an error", async () => {
    await expect(runVendor(recipe, context(["fetch-bad"]), strategies())).rejects.toThrow(/document unavailable/);
  });

  it("reports a genuine partial result when a sibling scope materializes a document", async () => {
    const result = await runVendor(recipe, context(["good", "fetch-bad"]), strategies());

    expect(result.documents).toHaveLength(1);
    expect(result.scopes).toMatchObject({ total: 2, succeeded: 1, empty: 0, failed: 1 });
  });

  it("preserves partial retrieval proof on the public run result", async () => {
    const result = await runVendor(recipe, context(["good", "partial"]), strategies());

    expect(result.documents).toHaveLength(1);
    expect(result.retrieval).toBe("partial");
    expect(result.retrievalProofs).toHaveLength(2);
    expect(result.retrievalProofs[1]).toMatchObject({
      completeness: "partial",
      termination: "page_cap",
    });
  });

  it("does not fall back to an unscoped invoice request when config discovery is empty", async () => {
    await expect(runVendor(recipe, context([]), strategies())).rejects.toThrow(/configuration discovery.*account/i);
  });
});

function strategies(): StrategyMap {
  const strategy = {
    async list(_recipe: VendorRecipe, vars: Record<string, unknown>) {
      if (vars.account === "bad") throw new UnexpectedResponse(403, "scope unavailable", "scopes");
      if (vars.account === "empty") return completeList([]);
      if (vars.account === "partial") return createInvoiceListResult([], {
        termination: "page_cap",
        pagesVisited: 100,
        observedItems: 1,
        resolvedItems: 0,
        unresolvedItems: 1,
      });
      return completeList([{ vendorInvoiceId: String(vars.account), issuedAt: "2026-07-16", documentUrl: "https://billing.example/invoice.pdf" }]);
    },
    async fetchDocument(_recipe: VendorRecipe, ref: { vendorInvoiceId: string }) {
      if (ref.vendorInvoiceId === "fetch-bad") throw new UnexpectedResponse(404, "document unavailable", "scopes");
      return { bytes: new TextEncoder().encode("%PDF").buffer, contentType: "application/pdf", filename: "invoice.pdf" };
    },
  };
  return { network: strategy, html: strategy, dom: strategy };
}

function completeList(refs: Array<{ vendorInvoiceId: string; issuedAt: string; documentUrl: string }>) {
  return createInvoiceListResult(refs, {
    termination: "explicit_end",
    pagesVisited: 1,
    observedItems: refs.length,
    resolvedItems: refs.length,
    unresolvedItems: 0,
  });
}

function context(accounts: string[]): RunContext {
  return {
    companyId: "company",
    vars: {},
    seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
    fetch: async (spec): Promise<HttpResponse> => ({
      status: 200,
      ok: true,
      json: async () => spec.url.endsWith("/accounts") ? { items: accounts.map((id) => ({ id })) } : {},
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => "application/json" },
    }),
  };
}
