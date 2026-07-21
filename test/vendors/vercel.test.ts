import { describe, expect, it } from "vitest";
import vercel from "../../src/vendors/vercel";
import { mapListResponse, networkStrategy } from "../../src/core/strategies/network";
import type { HttpResponse, NetworkInvoices, RequestSpec, RunContext } from "../../src/core/types";
import fixture from "./fixtures/vercel.invoices.json";

describe("vercel recipe", () => {
  const list = (vercel.invoices as NetworkInvoices).list;

  it("maps invoices and carries a documentRef for the constructed PDF URL", () => {
    const refs = mapListResponse(vercel.id, list, fixture);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      vendorInvoiceId: "in_abc123",
      issuedAt: "2026-06-30",
      total: "20.00",
      currency: "USD",
      documentRef: "in_abc123", // no direct URL; document.request builds it from {documentRef}
    });
    expect(refs[0]?.documentUrl).toBeUndefined();
  });

  it("continues after a full 100-record page and returns the complete next page", async () => {
    const requests: string[] = [];
    const context: RunContext = {
      companyId: "company",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "reservation", release: async () => undefined, add: async () => undefined },
      fetch: async (request: RequestSpec, requestVars: Record<string, unknown>): Promise<HttpResponse> => {
        let url = request.url;
        for (const [key, value] of Object.entries(requestVars)) url = url.replaceAll(`{${key}}`, String(value));
        requests.push(url);
        const page = Number(new URL(url).searchParams.get("page"));
        const count = page === 1 ? 100 : 1;
        return json({
          invoices: Array.from({ length: count }, (_, index) => ({
            id: `page-${page}-invoice-${index}`,
            created: "2026-06-30T12:00:00Z",
            total: 2000,
            currency: "USD",
          })),
        });
      },
    };

    const result = await networkStrategy.list(vercel, {}, context);

    expect(requests).toEqual([
      "https://vercel.com/api/billing/invoices?limit=100&page=1",
      "https://vercel.com/api/billing/invoices?limit=100&page=2",
    ]);
    expect(result.refs).toHaveLength(101);
    expect(result.retrieval).toMatchObject({ completeness: "complete", pagesVisited: 2, observedItems: 101 });
  });
});

function json(body: unknown): HttpResponse {
  return {
    status: 200,
    ok: true,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => "application/json" },
  };
}
