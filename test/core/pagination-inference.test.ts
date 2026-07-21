import { describe, expect, it } from "vitest";
import { inferRecipe } from "../../src/core/recorder/infer";
import type { CaptureSession } from "../../src/core/recorder/types";
import type { NetworkInvoices } from "../../src/core/types";

describe("pagination-shape inference", () => {
  it("infers nested GraphQL cursor plus hasNextPage evidence", () => {
    const draft = inferRecipe(session(
      "https://vendor.example/api/invoices?after=initial",
      {
        data: {
          invoices: {
            edges: rows().map((node) => ({ node })),
            pageInfo: { endCursor: "cursor-two", hasNextPage: true },
          },
        },
      },
    ));
    const list = (draft?.recipe.invoices as NetworkInvoices).list;
    expect(list.paginate).toEqual({
      cursor: "data.invoices.pageInfo.endCursor",
      hasMore: "data.invoices.pageInfo.hasNextPage",
    });
    expect(list.request.url).toBe("https://vendor.example/api/invoices?after={cursor}");
  });

  it("infers returned next URLs and numbered or offset query variables", () => {
    const next = inferRecipe(session("https://vendor.example/api/invoices", {
      items: rows(),
      links: { next: "/api/invoices?page=2" },
    }));
    expect(((next?.recipe.invoices as NetworkInvoices).list.paginate)).toEqual({
      kind: "next-url",
      nextUrl: "links.next",
    });

    const page = inferRecipe(session("https://vendor.example/api/invoices?page=1&per_page=25", {
      items: rows(),
      has_more: true,
    }));
    expect(((page?.recipe.invoices as NetworkInvoices).list.paginate)).toEqual({
      kind: "page",
      hasMore: "has_more",
      pageSize: 25,
    });
    expect((page?.recipe.invoices as NetworkInvoices).list.request.url).toContain("page={page}");

    const offset = inferRecipe(session("https://vendor.example/api/invoices?offset=0&limit=50", {
      items: rows(),
      has_more: true,
    }));
    expect(((offset?.recipe.invoices as NetworkInvoices).list.paginate)).toEqual({
      kind: "offset",
      step: 50,
      pageSize: 50,
      hasMore: "has_more",
    });
    expect((offset?.recipe.invoices as NetworkInvoices).list.request.url).toContain("offset={offset}");
  });
});

function session(url: string, body: unknown): CaptureSession {
  return {
    origin: "https://vendor.example",
    entries: [{
      url,
      method: "GET",
      status: 200,
      contentType: "application/json",
      responseBody: JSON.stringify(body),
    }],
  };
}

function rows(): Array<Record<string, unknown>> {
  return [
    { id: "invoice-one", issued_at: "2026-07-01", pdf_url: "/documents/one.pdf" },
    { id: "invoice-two", issued_at: "2026-06-01", pdf_url: "/documents/two.pdf" },
  ];
}
