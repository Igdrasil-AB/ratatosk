import { describe, expect, it } from "vitest";
import { MAX_CONFIG_VALUES_PER_OPTION, MAX_EXPANDED_SCOPES, runVendor } from "../../src/core/engine";
import { networkStrategy } from "../../src/core/strategies/network";
import { htmlStrategy } from "../../src/core/strategies/html";
import { unavailableDomStrategy } from "../../src/core/strategies/dom";
import { render } from "../../src/core/template";
import { AuthExpired } from "../../src/core/errors";
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
    const ctx: RunContext = { companyId: "co", vars: {}, seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => {} }, fetch };

    const result = await runVendor(recipe, ctx, { network: networkStrategy, dom: unavailableDomStrategy, html: htmlStrategy });

    expect(invoicesUrl).toBe("https://api.example/invoices?account_id=acct_123"); // the discovered id was substituted
    expect(result.documents).toHaveLength(1);
  });

  it.each([
    ["an empty account response", 200, { accounts: {} }, /yielded no value.*account_id/i],
    ["a failed account response", 502, { error: "unavailable" }, /configuration discovery failed.*account_id/i],
  ])("fails before listing for %s", async (_label, status, body, expected) => {
    let listCalled = false;
    const ctx: RunContext = {
      companyId: "co",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "reservation", release: async () => undefined, add: async () => undefined },
      fetch: async (spec) => {
        if (spec.url.endsWith("/me")) return json(200, { ok: true });
        if (spec.url.includes("/accounts/check")) return json(status, body);
        listCalled = true;
        return json(200, { data: [] });
      },
    };

    await expect(runVendor(recipe, ctx, {
      network: networkStrategy,
      dom: unavailableDomStrategy,
      html: htmlStrategy,
    })).rejects.toThrow(expected);
    expect(listCalled).toBe(false);
  });

  it("classifies a configuration-time 401 as an expired vendor session", async () => {
    let listCalled = false;
    const ctx: RunContext = {
      companyId: "co",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "reservation", release: async () => undefined, add: async () => undefined },
      fetch: async (spec) => {
        if (spec.url.endsWith("/me")) return json(200, { ok: true });
        if (spec.url.includes("/accounts/check")) return json(401, { error: "expired" });
        listCalled = true;
        return json(200, { data: [] });
      },
    };

    await expect(runVendor(recipe, ctx, {
      network: networkStrategy,
      dom: unavailableDomStrategy,
      html: htmlStrategy,
    })).rejects.toBeInstanceOf(AuthExpired);
    expect(listCalled).toBe(false);
  });

  it("rejects a capability-shaped runtime value for a discovered tenant scope", async () => {
    const discovered = structuredClone(recipe);
    discovered.id = "discovered-scoped";
    discovered.config = [{
      id: "teamId",
      discover: { request: { url: "https://api.example/teams/current" }, value: "team.id" },
    }];
    const ctx: RunContext = {
      companyId: "co",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => {} },
      fetch: async (spec) => {
        if (spec.url.endsWith("/me")) return json(200, { ok: true });
        if (spec.url.endsWith("/teams/current")) return json(200, { team: { id: "eyJcapability_value_that_is_not_an_id" } });
        throw new Error("list request must not run");
      },
    };

    await expect(runVendor(discovered, ctx, {
      network: networkStrategy,
      dom: unavailableDomStrategy,
      html: htmlStrategy,
    })).rejects.toThrow(/bounded tenant identifier/);
  });

  it("fails before listing when a discovered config option exceeds its value cap", async () => {
    const bounded = structuredClone(recipe);
    bounded.config = [{
      id: "workspaceId",
      discover: { request: { url: "https://api.example/workspaces" }, items: "workspaces", value: "id" },
    }];
    let listCalled = false;

    await expect(runVendor(bounded, {
      companyId: "co",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
      fetch: async (spec) => {
        if (spec.url.endsWith("/me")) return json(200, { ok: true });
        if (spec.url.endsWith("/workspaces")) return json(200, {
          workspaces: Array.from({ length: MAX_CONFIG_VALUES_PER_OPTION + 1 }, (_, index) => ({ id: `workspace-${index}` })),
        });
        listCalled = true;
        return json(200, { data: [] });
      },
    }, { network: networkStrategy, dom: unavailableDomStrategy, html: htmlStrategy })).rejects.toThrow(/exceeded .*values/i);
    expect(listCalled).toBe(false);
  });

  it("fails before listing when config dimensions would exceed the total scope cap", async () => {
    const bounded = structuredClone(recipe);
    bounded.config = [
      { id: "teamId", discover: { request: { url: "https://api.example/teams" }, items: "teams", value: "id" } },
      { id: "regionId", discover: { request: { url: "https://api.example/regions" }, items: "regions", value: "id" } },
    ];
    const dimension = Math.floor(Math.sqrt(MAX_EXPANDED_SCOPES)) + 1;
    let listCalled = false;

    await expect(runVendor(bounded, {
      companyId: "co",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
      fetch: async (spec) => {
        if (spec.url.endsWith("/me")) return json(200, { ok: true });
        if (spec.url.endsWith("/teams")) return json(200, { teams: Array.from({ length: dimension }, (_, index) => ({ id: `team-${index}` })) });
        if (spec.url.endsWith("/regions")) return json(200, { regions: Array.from({ length: dimension }, (_, index) => ({ id: `region-${index}` })) });
        listCalled = true;
        return json(200, { data: [] });
      },
    }, { network: networkStrategy, dom: unavailableDomStrategy, html: htmlStrategy })).rejects.toThrow(/expanded scopes/i);
    expect(listCalled).toBe(false);
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
