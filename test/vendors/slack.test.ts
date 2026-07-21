import { describe, expect, it } from "vitest";
import slack from "../../src/vendors/slack";
import { runVendor } from "../../src/core/engine";
import { mapListResponse, networkStrategy } from "../../src/core/strategies/network";
import { htmlStrategy } from "../../src/core/strategies/html";
import { unavailableDomStrategy } from "../../src/core/strategies/dom";
import { render } from "../../src/core/template";
import type { HttpResponse, NetworkInvoices, RunContext } from "../../src/core/types";
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

  it("discovers workspaces across cursor pages before listing each scope", async () => {
    const requests: string[] = [];
    const response = (body: unknown): HttpResponse => ({
      status: 200,
      ok: true,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => "application/json" },
    });
    const context: RunContext = {
      companyId: "company",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "reservation", release: async () => undefined, add: async () => undefined },
      fetch: async (spec, vars) => {
        const url = render(spec.url, vars);
        requests.push(url);
        if (url.includes("team.info")) return response({ ok: true });
        if (url.includes("admin.workspaces.list")) {
          return url.endsWith("cursor=")
            ? response({ workspaces: [{ domain: "acme" }], response_metadata: { next_cursor: "next-page" } })
            : response({ workspaces: [{ domain: "beta" }], response_metadata: { next_cursor: "" } });
        }
        if (url.includes("billing.invoices.list")) return response({ invoices: [], response_metadata: { next_cursor: "" } });
        throw new Error(`unexpected URL: ${url}`);
      },
    };

    await runVendor(slack, context, { network: networkStrategy, html: htmlStrategy, dom: unavailableDomStrategy });

    expect(requests.filter((url) => url.includes("admin.workspaces.list"))).toEqual([
      "https://app.slack.com/api/admin.workspaces.list?limit=50&cursor=",
      "https://app.slack.com/api/admin.workspaces.list?limit=50&cursor=next-page",
    ]);
    expect(requests.filter((url) => url.includes("billing.invoices.list"))).toEqual([
      "https://acme.slack.com/api/billing.invoices.list",
      "https://beta.slack.com/api/billing.invoices.list",
    ]);
  });
});
