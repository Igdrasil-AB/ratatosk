import { describe, expect, it } from "vitest";
import anthropic from "../../src/vendors/anthropic";
import { runVendor } from "../../src/core/engine";
import { networkStrategy } from "../../src/core/strategies/network";
import { htmlStrategy } from "../../src/core/strategies/html";
import { unavailableDomStrategy } from "../../src/core/strategies/dom";
import { render } from "../../src/core/template";
import { idempotencyKey } from "../../src/core/dedup";
import type { HttpResponse, RequestSpec, RunContext, SeenStore } from "../../src/core/types";
import orgs from "./fixtures/anthropic.organizations.json";
import invoices from "./fixtures/anthropic.invoices.json";

/**
 * Full engine run for a real, tricky vendor — with NO browser and NO network.
 * Exercises the whole path: auth probe → org discovery (2 scopes) → list →
 * dedup → PDF download. It also proves per-scope resilience: the API org's
 * invoices endpoint 404s, and that must NOT stop the subscription org's
 * invoices from being collected.
 */

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => null },
  };
}

function pdfResponse(): HttpResponse {
  const bytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;
  return {
    status: 200,
    ok: true,
    json: async () => ({}),
    arrayBuffer: async () => bytes,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/pdf" : null) },
  };
}

function mockFetch(spec: RequestSpec, vars: Record<string, unknown>): Promise<HttpResponse> {
  const url = render(spec.url, vars);

  if (url.includes("/api/organizations")) return Promise.resolve(jsonResponse(200, orgs));

  if (url.includes("/api/stripe/") && url.includes("/invoices")) {
    // The API-eval org returns 403 on its invoices (no Stripe subscription) — the
    // real case seen live. It must be skipped, not treated as a dead session.
    if (url.includes("org-api-0000")) return Promise.resolve(jsonResponse(403, {}));
    return Promise.resolve(jsonResponse(200, { ...invoices, has_more: false, next_page: null }));
  }

  if (url.includes("pay.stripe.com")) return Promise.resolve(pdfResponse());

  return Promise.reject(new Error(`unexpected url: ${url}`));
}

function makeContext(): RunContext {
  const set = new Set<string>();
  const seen: SeenStore = {
    has: async (k) => set.has(k),
    add: async (k) => void set.add(k),
  };
  return { companyId: "co_test", vars: {}, seen, fetch: mockFetch };
}

describe("anthropic — full engine run", () => {
  const strategies = { network: networkStrategy, dom: unavailableDomStrategy, html: htmlStrategy };

  it("discovers both orgs, skips the failing one, and collects the subscription invoices", async () => {
    const result = await runVendor(anthropic, makeContext(), strategies);

    // 2 invoices from the subscription org; the 404 API org was skipped, not fatal.
    expect(result.vendorId).toBe("anthropic");
    expect(result.documents).toHaveLength(2);

    const [first] = result.documents;
    expect(first?.source).toBe("ext:anthropic");
    expect(first?.vendorInvoiceId).toBe("1782543567");
    expect(first?.contentType).toBe("application/pdf");
    expect(first?.bytes.byteLength).toBeGreaterThan(0);
    expect(first?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("dedups: a second run with those keys already seen collects nothing", async () => {
    const ctx = makeContext();
    await ctx.seen.add(await idempotencyKey("co_test", "ext:anthropic", "1782543567"));
    await ctx.seen.add(await idempotencyKey("co_test", "ext:anthropic", "1782521674"));

    const result = await runVendor(anthropic, ctx, strategies);
    expect(result.documents).toHaveLength(0);
  });
});
