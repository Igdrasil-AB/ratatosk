import { describe, expect, it } from "vitest";
import { mapItem, networkStrategy } from "../../src/core/strategies/network";
import type { HttpResponse, NetworkListSpec, RunContext, VendorRecipe } from "../../src/core/types";

describe("bounded network pagination", () => {
  it("keeps missing or null configured issue dates empty", () => {
    const map = { id: "id", issuedAt: "issued_at" } as const;
    expect(mapItem("vendor", map, { id: "one" }).issuedAt).toBeUndefined();
    expect(mapItem("vendor", map, { id: "two", issued_at: null }).issuedAt).toBeUndefined();
    expect(mapItem("vendor", map, { id: "three", issued_at: "2026-07-01" }).issuedAt).toBe("2026-07-01");
  });

  it("follows a cursor while hasMore remains true and stops without replaying a cursor", async () => {
    const requests: string[] = [];
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices?after={cursor}" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { cursor: "pageInfo.endCursor", hasMore: "pageInfo.hasNextPage", maxPages: 10 },
    });
    const pages = [
      { items: [{ id: "one", pdf: "/one.pdf" }], pageInfo: { endCursor: "cursor-2", hasNextPage: true } },
      { items: [{ id: "two", pdf: "/two.pdf" }], pageInfo: { endCursor: "cursor-2", hasNextPage: true } },
    ];
    const result = await networkStrategy.list(recipe, {}, context(async (url) => {
      requests.push(url);
      return json(pages.shift() ?? { items: [], pageInfo: { hasNextPage: false } });
    }));

    expect(result.refs.map((ref) => ref.vendorInvoiceId)).toEqual(["one", "two"]);
    expect(result.retrieval).toMatchObject({ completeness: "partial", termination: "repeated_state" });
    expect(requests).toEqual([
      "https://vendor.example/api/invoices?after=",
      "https://vendor.example/api/invoices?after=cursor-2",
    ]);
  });

  it("follows a same-recipe next URL returned by the API", async () => {
    const requests: string[] = [];
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { kind: "next-url", nextUrl: "links.next", maxPages: 5 },
    });
    const result = await networkStrategy.list(recipe, {}, context(async (url) => {
      requests.push(url);
      return url.endsWith("/invoices")
        ? json({ items: [{ id: "one", pdf: "/one.pdf" }], links: { next: "/api/invoices?page=2" } })
        : json({ items: [{ id: "two", pdf: "/two.pdf" }], links: { next: null } });
    }));

    expect(result.refs.map((ref) => ref.vendorInvoiceId)).toEqual(["one", "two"]);
    expect(result.retrieval).toMatchObject({ completeness: "complete", termination: "explicit_end" });
    expect(requests.at(-1)).toBe("https://vendor.example/api/invoices?page=2");
  });

  it("supports numbered and offset pagination with explicit finite bounds", async () => {
    const pageRequests: string[] = [];
    const pageRecipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices?page={page}" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { kind: "page", hasMore: "has_more", maxPages: 5 },
    });
    const pageResult = await networkStrategy.list(pageRecipe, {}, context(async (url) => {
      pageRequests.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return json({ items: [{ id: `page-${page}`, pdf: `/${page}.pdf` }], has_more: page < 2 });
    }));

    const offsetRequests: string[] = [];
    const offsetRecipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices?offset={offset}&limit=25" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { kind: "offset", step: 25, hasMore: "has_more", maxPages: 5 },
    });
    const offsetResult = await networkStrategy.list(offsetRecipe, {}, context(async (url) => {
      offsetRequests.push(url);
      const offset = Number(new URL(url).searchParams.get("offset"));
      return json({ items: [{ id: `offset-${offset}`, pdf: `/${offset}.pdf` }], has_more: offset < 25 });
    }));

    expect(pageResult.refs.map((ref) => ref.vendorInvoiceId)).toEqual(["page-1", "page-2"]);
    expect(pageRequests).toHaveLength(2);
    expect(offsetResult.refs.map((ref) => ref.vendorInvoiceId)).toEqual(["offset-0", "offset-25"]);
    expect(offsetRequests).toHaveLength(2);
  });

  it("follows an RFC Link rel=next header without persisting its cursor URL", async () => {
    const requests: string[] = [];
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { kind: "link-header", maxPages: 5 },
    });
    const result = await networkStrategy.list(recipe, {}, context(async (url) => {
      requests.push(url);
      return json(
        { items: [{ id: requests.length === 1 ? "one" : "two", pdf: `/${requests.length}.pdf` }] },
        requests.length === 1 ? '</api/invoices?after=cursor-two>; rel="next"' : null,
      );
    }));

    expect(result.refs.map((ref) => ref.vendorInvoiceId)).toEqual(["one", "two"]);
    expect(requests.at(-1)).toBe("https://vendor.example/api/invoices?after=cursor-two");
  });

  it("marks a non-empty result partial when the page cap interrupts traversal", async () => {
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices?page={page}" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { kind: "page", hasMore: "has_more", maxPages: 2 },
    });
    const result = await networkStrategy.list(recipe, {}, context(async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return json({ items: [{ id: `page-${page}`, pdf: `/${page}.pdf` }], has_more: true });
    }));

    expect(result.refs).toHaveLength(2);
    expect(result.retrieval).toMatchObject({
      completeness: "partial",
      termination: "page_cap",
      pagesVisited: 2,
    });
  });

  it("marks traversal partial when hasMore requires a cursor that is missing", async () => {
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices?after={cursor}" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { cursor: "pageInfo.endCursor", hasMore: "pageInfo.hasNextPage", maxPages: 5 },
    });

    const result = await networkStrategy.list(recipe, {}, context(async () => json({
      items: [{ id: "one", pdf: "/one.pdf" }],
      pageInfo: { hasNextPage: true },
    })));

    expect(result.refs).toHaveLength(1);
    expect(result.retrieval).toMatchObject({
      completeness: "partial",
      termination: "continuation_failed",
      pagesVisited: 1,
    });
  });

  it("marks traversal partial when a required cursor has a non-scalar shape", async () => {
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices?after={cursor}" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { cursor: "pageInfo.endCursor", hasMore: "pageInfo.hasNextPage", maxPages: 5 },
    });

    const result = await networkStrategy.list(recipe, {}, context(async () => json({
      items: [{ id: "one", pdf: "/one.pdf" }],
      pageInfo: { hasNextPage: true, endCursor: { unexpected: "shape" } },
    })));

    expect(result.retrieval).toMatchObject({
      completeness: "partial",
      termination: "continuation_failed",
    });
  });

  it("does not follow a required next URL with a non-HTTPS scheme", async () => {
    const requests: string[] = [];
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { kind: "next-url", nextUrl: "links.next", hasMore: "has_more", maxPages: 5 },
    });

    const result = await networkStrategy.list(recipe, {}, context(async (url) => {
      requests.push(url);
      return json({
        items: [{ id: "one", pdf: "/one.pdf" }],
        has_more: true,
        links: { next: "javascript:alert(1)" },
      });
    }));

    expect(result.retrieval).toMatchObject({
      completeness: "partial",
      termination: "continuation_failed",
    });
    expect(requests).toHaveLength(1);
  });

  it("marks a present unusable next locator partial even without a separate hasMore field", async () => {
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { kind: "next-url", nextUrl: "links.next", maxPages: 5 },
    });

    for (const next of ["http://vendor.example/page/2", "https://evil.example/page/2", "x".repeat(2_100)]) {
      const result = await networkStrategy.list(recipe, {}, context(async () => json({
        items: [{ id: "one", pdf: "/one.pdf" }],
        links: { next },
      })));
      expect(result.retrieval).toMatchObject({ completeness: "partial", termination: "continuation_failed" });
    }
  });

  it("marks an invalid rel=next Link header partial without hasMore", async () => {
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { kind: "link-header", maxPages: 5 },
    });
    const result = await networkStrategy.list(recipe, {}, context(async () => json(
      { items: [{ id: "one", pdf: "/one.pdf" }] },
      '<http://vendor.example/page/2>; rel="next"',
    )));
    expect(result.retrieval).toMatchObject({ completeness: "partial", termination: "continuation_failed" });
  });

  it("does not replay list authorization headers to a cross-origin next URL", async () => {
    const requests: string[] = [];
    const recipe = networkRecipe({
      request: {
        url: "https://vendor.example/api/invoices",
        headers: { Authorization: "Bearer {token}" },
      },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
      paginate: { kind: "next-url", nextUrl: "links.next", hasMore: "has_more", maxPages: 5 },
    });

    const result = await networkStrategy.list(recipe, { token: "supplier-token" }, context(async (url) => {
      requests.push(url);
      return json({
        items: [{ id: "one", pdf: "/one.pdf" }],
        has_more: true,
        links: { next: "https://evil.example/invoices?page=2" },
      });
    }));

    expect(result.retrieval).toMatchObject({
      completeness: "partial",
      termination: "continuation_failed",
    });
    expect(requests).toEqual(["https://vendor.example/api/invoices"]);
  });

  it("rejects list rows without a stable invoice ID instead of sharing undefined", async () => {
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
    });

    await expect(networkStrategy.list(recipe, {}, context(async () => json({
      items: [{ pdf: "/one.pdf" }, { pdf: "/two.pdf" }],
    })))).rejects.toThrow(/stable invoice id/i);
  });

  it("resolves relative document URLs against the final redirected list URL", async () => {
    const recipe = networkRecipe({
      request: { url: "https://vendor.example/api/invoices" },
      items: "items",
      map: { id: "id", documentUrl: "pdf" },
    });
    const redirected = await json({ items: [{ id: "one", pdf: "documents/one.pdf" }] });
    redirected.url = "https://vendor.example/billing/archive/";
    redirected.redirected = true;

    const result = await networkStrategy.list(recipe, {}, context(async () => redirected));

    expect(result.refs[0].documentUrl).toBe("https://vendor.example/billing/archive/documents/one.pdf");
  });
});

function networkRecipe(list: NetworkListSpec): VendorRecipe {
  return {
    id: "paginated",
    name: "Paginated",
    homepage: "https://vendor.example",
    hosts: ["https://vendor.example/*"],
    auth: {
      check: { request: { url: "https://vendor.example/me" }, expect: { statusIn: [200] } },
      loginUrl: "https://vendor.example/login",
    },
    invoices: { strategy: "network", list, document: { contentType: "application/pdf" } },
  };
}

function context(respond: (url: string) => Promise<HttpResponse>): RunContext {
  return {
    companyId: "company",
    vars: {},
    seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
    fetch: async (spec, vars) => {
      let url = spec.url;
      for (const [key, value] of Object.entries(vars)) url = url.replaceAll(`{${key}}`, String(value));
      return respond(url);
    },
  };
}

function json(body: unknown, link: string | null = null): Promise<HttpResponse> {
  return Promise.resolve({
    status: 200,
    ok: true,
    url: "https://vendor.example/api/invoices",
    redirected: false,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: (name) => name.toLowerCase() === "link" ? link : "application/json" },
  });
}
