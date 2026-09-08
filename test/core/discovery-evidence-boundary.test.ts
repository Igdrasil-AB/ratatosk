import { describe, expect, it, vi } from "vitest";
import {
  collectFrameNetworkEvidenceInPage,
  mainFrameInjectionResult,
  mergeFrameNetworkEvidence,
  parsePageEvidence,
} from "../../collector/src/platform/discovery";

describe("supplier page evidence boundary", () => {
  const options = { settleMs: 0, maxResources: 2, deadlineMs: 3_000 };

  it("selects frame zero instead of trusting all-frame result order", () => {
    const main = { origin: "https://vendor.example", marker: "main" };
    expect(mainFrameInjectionResult([
      { frameId: 9, result: undefined },
      { frameId: 0, result: main },
      { frameId: 4, result: { origin: "https://vendor.example", marker: "frame" } },
    ])).toBe(main);
  });

  it("keeps subframe collection passive and network-only", async () => {
    const top = {};
    const frameWindow: Record<string, unknown> = {
      top,
      __ratatoskDiscoveryObserverV1: {
        snapshot: async () => [{
          url: "https://vendor.example/api/invoices",
          method: "GET",
          status: 200,
          contentType: "application/json",
          responseBody: JSON.stringify({ invoices: [] }),
        }],
      },
    };
    vi.stubGlobal("window", frameWindow);
    vi.stubGlobal("location", {
      origin: "https://vendor.example",
      pathname: "/embedded",
    });
    try {
      await expect(collectFrameNetworkEvidenceInPage({ maxResources: 2, deadlineMs: 1_000 }))
        .resolves.toMatchObject({
          html: "",
          resources: [{ url: "https://vendor.example/api/invoices", source: "observed" }],
          navigationUrls: [],
          stats: { documentLinks: 0, semanticControls: 0 },
        });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("merges same-origin frame requests without admitting frame DOM controls or routes", () => {
    const main = parsePageEvidence({
      url: "https://vendor.example/home",
      origin: "https://vendor.example",
      html: "<html><body>Home</body></html>",
      resources: [],
      navigationUrls: [],
      crossOriginHosts: [],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
    }, "https://vendor.example", { ...options, maxResources: 12 });
    const frame = parsePageEvidence({
      url: "https://vendor.example/embed/billing",
      origin: "https://vendor.example",
      html: '<a href="/private/frame-document.pdf">Frame document</a>',
      resources: [{
        url: "https://vendor.example/api/invoices",
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ invoices: [] }),
        source: "observed",
      }],
      navigationUrls: [{ url: "https://vendor.example/frame-route", label: "Billing" }],
      crossOriginHosts: [],
      stats: { documentLinks: 1, structuredData: 0, semanticControls: 1 },
    }, "https://vendor.example", { ...options, maxResources: 12 });

    const merged = mergeFrameNetworkEvidence(main, [frame], 12);

    expect(merged.resources).toHaveLength(1);
    expect(merged.html).toBe(main.html);
    expect(merged.navigationUrls).toEqual([]);
    expect(merged.stats).toEqual(main.stats);
  });

  it("accepts bounded exact-origin structural evidence", () => {
    expect(parsePageEvidence({
      url: "https://vendor.example/billing",
      origin: "https://vendor.example",
      title: "Billing",
      html: "<html></html>",
      resources: [],
      navigationUrls: ["https://vendor.example/invoices"],
      crossOriginHosts: [],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 1 },
    }, "https://vendor.example", options)).toMatchObject({ origin: "https://vendor.example" });
  });

  it("preserves bounded semantic labels for opaque exact-origin routes", () => {
    expect(parsePageEvidence({
      url: "https://vendor.example/home",
      origin: "https://vendor.example",
      html: "<html></html>",
      resources: [],
      navigationUrls: [{ url: "https://vendor.example/app/section/42", label: "Invoices" }],
      crossOriginHosts: [],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
    }, "https://vendor.example", options).navigationUrls).toEqual([
      { url: "https://vendor.example/app/section/42", label: "Invoices" },
    ]);
  });

  it("preserves bounded nearby context for icon-only navigation routes", () => {
    expect(parsePageEvidence({
      url: "https://vendor.example/home",
      origin: "https://vendor.example",
      html: "<html></html>",
      resources: [],
      navigationUrls: [{ url: "https://vendor.example/app/section/42", context: "Billing and invoices" }],
      crossOriginHosts: [],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
    }, "https://vendor.example", options).navigationUrls).toEqual([
      { url: "https://vendor.example/app/section/42", context: "Billing and invoices" },
    ]);
  });

  it("preserves a bounded sanitized GraphQL observation", () => {
    const requestBody = JSON.stringify({
      query: "query BillingInvoices($workspaceId: ID!) { workspace(id: $workspaceId) { invoices { id issuedAt pdfUrl } } }",
      variables: { workspaceId: "{workspaceId}" },
    });
    expect(parsePageEvidence({
      url: "https://vendor.example/billing",
      origin: "https://vendor.example",
      html: "<html></html>",
      resources: [{
        url: "https://api.vendor.example/graphql",
        method: "POST",
        status: 200,
        contentType: "application/json",
        requestBody,
        requestHeaders: { "content-type": "application/json" },
        body: JSON.stringify({ data: { invoices: [] } }),
      }],
      navigationUrls: [],
      crossOriginHosts: ["api.vendor.example"],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
    }, "https://vendor.example", options).resources[0]).toMatchObject({
      method: "POST",
      url: "https://api.vendor.example/graphql",
      requestBody,
      requestHeaders: { "content-type": "application/json" },
    });
  });

  it("rejects observed cross-origin traffic unless its exact public host is declared", () => {
    const evidence = parsePageEvidence({
      url: "https://vendor.example/billing",
      origin: "https://vendor.example",
      html: "<html></html>",
      resources: [{
        url: "https://undeclared-api.example/graphql",
        method: "POST",
        status: 200,
        contentType: "application/json",
        requestBody: JSON.stringify({ query: "query BillingInvoices { invoices { id } }" }),
        requestHeaders: { "content-type": "application/json" },
        body: JSON.stringify({ data: { invoices: [] } }),
      }],
      navigationUrls: [],
      crossOriginHosts: [],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
    }, "https://vendor.example", options);

    expect(evidence.resources).toEqual([]);
    expect(evidence.stats.evidenceDropped).toBe(1);
  });

  it("drops invalid request items without erasing valid page evidence", () => {
    const base = {
      url: "https://vendor.example/billing",
      origin: "https://vendor.example",
      html: "<html></html>",
      navigationUrls: [],
      crossOriginHosts: [],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
    };
    const resource = {
      url: "https://vendor.example/graphql",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {} }),
    };
    const evidence = parsePageEvidence({
      ...base,
      resources: [
        resource,
        { ...resource, method: "DELETE" },
        { ...resource, method: "POST", requestHeaders: { authorization: "Bearer secret" } },
        { ...resource, method: "POST", requestBody: "x".repeat(65_537) },
      ],
    }, "https://vendor.example", { ...options, maxResources: 4 });

    expect(evidence.resources).toHaveLength(1);
    expect(evidence.resources[0]).toMatchObject({ url: resource.url, status: 200 });
    expect(evidence.stats.evidenceDropped).toBe(3);
  });

  it("drops invalid route items and oversized HTML without erasing other lanes", () => {
    const base = {
      url: "https://vendor.example/billing",
      origin: "https://vendor.example",
      html: "<html></html>",
      resources: [],
      navigationUrls: [],
      crossOriginHosts: [],
      stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
    };
    const evidence = parsePageEvidence({
      ...base,
      html: "x".repeat(750_001),
      navigationUrls: [
        { url: "https://vendor.example/app/section/42", label: "Invoices" },
        "https://attacker.example/invoices",
        { url: "https://vendor.example/app/section/43", label: "x".repeat(161) },
        { url: "https://vendor.example/app/section/44", context: "x".repeat(241) },
      ],
    }, "https://vendor.example", options);

    expect(evidence.html).toBe("");
    expect(evidence.navigationUrls).toEqual([
      { url: "https://vendor.example/app/section/42", label: "Invoices" },
    ]);
    expect(evidence.stats.evidenceDropped).toBe(4);
  });
});
