import { describe, expect, it } from "vitest";
import { compileCandidates, type PageEvidence } from "../../collector/src/platform/discovery";
import { createDiscoveredSupplierProfile } from "../../src/core/discovery";

const base: Omit<PageEvidence, "html" | "resources"> = {
  url: "https://vendor.example/account/billing",
  origin: "https://vendor.example",
  title: "Billing | Example Vendor",
  navigationUrls: [],
  crossOriginHosts: [],
  stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
};

describe("packaged supplier discovery adapters", () => {
  it("compiles a reusable same-origin JSON invoice list without inferred totals", () => {
    const candidates = compileCandidates({
      ...base,
      html: "<html></html>",
      resources: [{
        url: "https://vendor.example/api/invoices?limit=50",
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ invoices: [
          { id: "inv_1", created_at: "2026-07-01", amount_cents: 2500, currency: "sek", pdf_url: "/documents/inv_1.pdf" },
          { id: "inv_2", created_at: "2026-06-01", amount_cents: 4900, currency: "sek", pdf_url: "/documents/inv_2.pdf" },
        ] }),
      }],
    }, base.url, "Example Vendor");

    expect(candidates[0]?.adapterId).toBe("network-json");
    const recipe = candidates[0]?.recipe;
    expect(recipe?.invoices.strategy).toBe("network");
    if (recipe?.invoices.strategy === "network") {
      expect(recipe.invoices.list.map.total).toBeUndefined();
      expect(recipe.invoices.list.map.documentUrl).toBe("pdf_url");
    }
  });

  it("compiles an observed read-only GraphQL invoice query", () => {
    const requestBody = JSON.stringify({
      query: "query BillingInvoices { invoices { id issued_at pdf_url } }",
      variables: {},
      operationName: "BillingInvoices",
    });
    const candidates = compileCandidates({
      ...base,
      html: "<html></html>",
      resources: [{
        url: "https://api.vendor.example/graphql",
        method: "POST",
        status: 200,
        contentType: "application/json",
        requestBody,
        requestHeaders: { "content-type": "application/json" },
        body: JSON.stringify({ data: { invoices: [
          { id: "inv_1", issued_at: "2026-07-01", pdf_url: "/documents/inv_1.pdf" },
          { id: "inv_2", issued_at: "2026-06-01", pdf_url: "/documents/inv_2.pdf" },
        ] } }),
      }],
      crossOriginHosts: ["api.vendor.example"],
    }, base.url, "Example Vendor");

    expect(candidates[0]?.adapterId).toBe("network-json");
    const recipe = candidates[0]?.recipe;
    expect(recipe?.invoices.strategy).toBe("network");
    if (recipe?.invoices.strategy === "network") {
      expect(recipe.invoices.list.request).toMatchObject({
        url: "https://api.vendor.example/graphql",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
      expect(recipe.hosts).toContain("https://api.vendor.example/*");
      expect(() => createDiscoveredSupplierProfile({
        primaryOrigin: base.origin,
        entryUrl: base.url,
        displayName: "Example Vendor",
        nameSource: "page",
        nameConfidence: "medium",
        adapterId: "network-json",
        candidateCount: 2,
        recipe,
      })).not.toThrow();
    }
  });

  it("rejects automatic JSON candidates whose inferred identity falls back to a date", () => {
    const candidates = compileCandidates({
      ...base,
      html: "<html></html>",
      resources: [{
        url: "https://vendor.example/api/invoices",
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ invoices: [
          { created_at: "2026-07-01", amount: 25, pdf_url: "/documents/first.pdf" },
          { created_at: "2026-07-01", amount: 40, pdf_url: "/documents/second.pdf" },
        ] }),
      }],
    }, base.url, "Example Vendor");

    expect(candidates).toEqual([]);
  });

  it("persists a reusable next-page API contract without persisting cursor values", () => {
    const candidates = compileCandidates({
      ...base,
      html: "<html></html>",
      resources: [{
        url: "https://vendor.example/api/invoices",
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          invoices: [
            { id: "inv_1", created_at: "2026-07-01", pdf_url: "/documents/inv_1.pdf" },
            { id: "inv_2", created_at: "2026-06-01", pdf_url: "/documents/inv_2.pdf" },
          ],
          links: { next: "/api/invoices?page=2" },
        }),
      }],
    }, base.url, "Example Vendor");

    const recipe = candidates[0]?.recipe;
    expect(recipe?.invoices.strategy).toBe("network");
    if (recipe?.invoices.strategy === "network") {
      expect(recipe.invoices.list.paginate).toEqual({ kind: "next-url", nextUrl: "links.next" });
    }
    expect(JSON.stringify(recipe)).not.toContain("page=2");
  });

  it("compiles structural HTTP Link pagination without storing a next URL", () => {
    const candidates = compileCandidates({
      ...base,
      html: "<html></html>",
      resources: [{
        url: "https://vendor.example/api/invoices",
        status: 200,
        contentType: "application/json",
        hasLinkNext: true,
        body: JSON.stringify({ invoices: [
          { id: "inv_1", created_at: "2026-07-01", pdf_url: "/documents/inv_1.pdf" },
          { id: "inv_2", created_at: "2026-06-01", pdf_url: "/documents/inv_2.pdf" },
        ] }),
      }],
    }, base.url, "Example Vendor");
    const recipe = candidates[0]?.recipe;
    expect(recipe?.invoices.strategy).toBe("network");
    if (recipe?.invoices.strategy === "network") {
      expect(recipe.invoices.list.paginate).toEqual({ kind: "link-header" });
    }
  });

  it("compiles embedded JSON before the rendered-link fallback", () => {
    const html = `<html><head><script type="application/json">${JSON.stringify({ invoices: [
      { id: "inv_a", issued_at: "2026-07-01", pdf_url: "/documents/inv_a.pdf" },
      { id: "inv_b", issued_at: "2026-06-01", pdf_url: "/documents/inv_b.pdf" },
    ] })}</script></head><body><a href="/documents/inv_a.pdf">Invoice</a></body></html>`;
    const candidates = compileCandidates({ ...base, html, resources: [] }, base.url, "Example Vendor");
    expect(candidates.map((candidate) => candidate.adapterId)).toEqual(["embedded-json", "dom-links"]);
  });

  it("uses a closed rendered-link recipe when no structured list is present", () => {
    const candidates = compileCandidates({
      ...base,
      html: '<html><body><a href="/receipts/receipt-one.pdf">Download invoice</a></body></html>',
      resources: [],
    }, base.url, "Example Vendor");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].adapterId).toBe("dom-links");
    expect(candidates[0].previewCount).toBe(1);
    expect(candidates[0].recipe.invoices.strategy).toBe("dom");
    if (candidates[0].recipe.invoices.strategy === "dom") {
      expect(candidates[0].recipe.invoices.list.continuation).toMatchObject({ mode: "auto", maxActions: 8 });
    }
  });

  it("persists a safe billing SPA route for later generic DOM syncs", () => {
    const entryUrl = "https://vendor.example/#settings/Billing";
    const candidates = compileCandidates({
      ...base,
      url: entryUrl,
      html: '<html><body><a href="https://invoice.stripe.com/i/acct_example/live_example">View invoice</a></body></html>',
      resources: [],
    }, entryUrl, "Example Vendor");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].recipe.invoices.strategy).toBe("dom");
    if (candidates[0].recipe.invoices.strategy === "dom") {
      expect(candidates[0].recipe.invoices.list.open).toBe(entryUrl);
      expect(candidates[0].recipe.auth.check.request.url).toBe("https://vendor.example/");
    }
  });

  it("does not treat an unrelated download on a non-billing page as an invoice source", () => {
    const page = "https://vendor.example/tasks/123";
    const candidates = compileCandidates({
      ...base,
      url: page,
      title: "Project task",
      html: '<html><body><a href="/exports/task-report.pdf" download>Download</a></body></html>',
      resources: [],
      stats: { documentLinks: 1, structuredData: 0, semanticControls: 0 },
    }, page, "Example Vendor");

    expect(candidates).toEqual([]);
  });

  it("compiles a closed semantic-action fallback for download controls without hrefs", () => {
    const candidates = compileCandidates({
      ...base,
      html: '<html><body><button aria-label="Download receipt PDF">PDF</button></body></html>',
      resources: [],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 1 },
    }, base.url, "Example Vendor");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].adapterId).toBe("dom-actions");
    if (candidates[0].recipe.invoices.strategy === "dom") {
      expect(candidates[0].recipe.invoices.list.steps).toEqual([
        { action: "extractSemanticDownloads", as: "documents", maxActions: 12 },
      ]);
    }
  });

  it("bounds semantic downloads to exact API origins observed on the evidence page", () => {
    const candidates = compileCandidates({
      ...base,
      html: '<html><body><a data-test="billing-invoices__download-button"><span icon="billing-download"></span></a></body></html>',
      resources: [],
      crossOriginHosts: ["api.vendor.example", "cdn.vendor.example"],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 1 },
    }, base.url, "Example Vendor");

    expect(candidates[0].recipe.hosts).toEqual([
      "https://api.vendor.example/*",
      "https://cdn.vendor.example/*",
      "https://vendor.example/*",
    ]);
  });

  it("does not mistake invoice navigation routes for downloadable documents", () => {
    const candidates = compileCandidates({
      ...base,
      html: '<html><body><a href="/account/invoices/inv_123">View invoice</a><a href="/billing/subscriptions">Subscriptions</a></body></html>',
      resources: [],
    }, base.url, "Example Vendor");
    expect(candidates).toEqual([]);
  });

  it("keeps an explicit PDF document as direct evidence without relying on a supplier route", () => {
    const candidates = compileCandidates({
      ...base,
      html: '<html><body><a href="/account/receipt/rcpt_123">Receipt</a><a href="/account/invoices/inv_123.pdf">PDF</a></body></html>',
      resources: [],
    }, base.url, "Example Vendor");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].adapterId).toBe("dom-links");
  });

  it("accepts a download-labelled invoice URL without assuming every invoice URL is a document", () => {
    const candidates = compileCandidates({
      ...base,
      html: '<html><body><a href="/account/invoices/inv_123" aria-label="Download invoice PDF">Invoice</a></body></html>',
      resources: [],
    }, base.url, "Example Vendor");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].adapterId).toBe("dom-links");
  });

  it("normalizes Stripe hosted invoice pages to the packaged PDF endpoint", () => {
    const candidates = compileCandidates({
      ...base,
      html: "<html></html>",
      resources: [{
        url: "https://vendor.example/api/invoices",
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ invoices: [
          { id: "inv_1", issued_at: "2026-07-01", amount: "25.00", hosted_invoice_url: "https://invoice.stripe.com/i/acct_test/token-one?s=ap" },
        ] }),
      }],
    }, base.url, "Example Vendor");
    const recipe = candidates[0].recipe;
    expect(recipe.hosts).toContain("https://pay.stripe.com/*");
    expect(recipe.hosts).toContain("https://files.stripe.com/*");
    expect(recipe.hosts).toContain("https://stripe-upload-api.s3.us-west-1.amazonaws.com/*");
    expect(recipe.hosts).toContain("https://invoice.stripe.com/*");
    if (recipe.invoices.strategy === "network") {
      expect(recipe.invoices.list.map.documentUrl).toMatchObject({
        path: "hosted_invoice_url",
        transforms: [expect.objectContaining({ kind: "replace", with: "https://pay.stripe.com/invoice/$1/$2/pdf$3" })],
      });
    }
  });
});
