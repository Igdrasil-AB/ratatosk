import { describe, expect, it } from "vitest";
import { compileCandidates, type PageEvidence } from "../../collector/src/platform/discovery";

const page = "https://vendor.example/account/billing";

describe("supplier discovery shape corpus", () => {
  const corpus: Array<{
    name: string;
    evidence: Partial<PageEvidence>;
    expected: string[];
    admission?: string[][];
  }> = [
    {
      name: "JSON API list",
      evidence: {
        resources: [{
          url: "https://vendor.example/api/invoices",
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoices: [
            { id: "inv_1", created_at: "2026-07-01", pdf_url: "/documents/inv_1.pdf" },
            { id: "inv_2", created_at: "2026-06-01", pdf_url: "/documents/inv_2.pdf" },
          ] }),
        }],
      },
      expected: ["network-json"],
      admission: [["structured_network"]],
    },
    {
      name: "embedded application JSON",
      evidence: {
        html: `<script type="application/json">${JSON.stringify({ invoices: [
          { id: "inv_1", issued_at: "2026-07-01", pdf_url: "/documents/inv_1.pdf" },
          { id: "inv_2", issued_at: "2026-06-01", pdf_url: "/documents/inv_2.pdf" },
        ] })}</script>`,
      },
      expected: ["embedded-json"],
      admission: [["embedded_invoice_data"]],
    },
    {
      name: "direct receipt links",
      evidence: { html: '<a href="/account/receipt/rcpt_1">Receipt</a><a href="/documents/inv_2.pdf">PDF</a>' },
      expected: ["dom-links"],
      admission: [["direct_document_link"]],
    },
    {
      name: "download buttons without hrefs",
      evidence: {
        html: '<button aria-label="Download invoice PDF">Download</button>',
        stats: { documentLinks: 0, structuredData: 0, semanticControls: 1 },
      },
      expected: ["dom-actions"],
      admission: [["semantic_document_control"]],
    },
    {
      name: "navigation links only",
      evidence: { html: '<a href="/account/invoices/inv_1">View invoice</a><a href="/billing/subscriptions">Subscriptions</a>' },
      expected: [],
    },
    {
      name: "direct proof suppresses the slower semantic duplicate",
      evidence: {
        html: '<a href="/documents/inv_1.pdf">PDF</a><button aria-label="Download invoice PDF">Download</button>',
        stats: { documentLinks: 1, structuredData: 0, semanticControls: 1 },
      },
      expected: ["dom-links"],
      admission: [["direct_document_link"]],
    },
  ];

  for (const shape of corpus) {
    it(shape.name, () => {
      const candidates = compileCandidates(evidence(shape.evidence), page, "Example Vendor");
      expect(candidates.map((candidate) => candidate.adapterId)).toEqual(shape.expected);
      if (shape.admission) expect(candidates.map((candidate) => candidate.admission)).toEqual(shape.admission);
    });
  }
});

function evidence(overrides: Partial<PageEvidence>): PageEvidence {
  return {
    url: page,
    origin: "https://vendor.example",
    title: "Billing | Example Vendor",
    html: "<html></html>",
    resources: [],
    navigationUrls: [],
    crossOriginHosts: [],
    stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
    ...overrides,
  };
}
