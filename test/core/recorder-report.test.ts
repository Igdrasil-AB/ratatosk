import { describe, expect, it } from "vitest";
import { buildAgentReport } from "../../src/core/recorder/report";
import { inferRecipe, findDocLinks } from "../../src/core/recorder/infer";
import type { CaptureSession } from "../../src/core/recorder/types";

/**
 * The "Copy for agent" payload is the hand-off from browser to coding agent, so
 * it must carry a useful bounded diagnosis without exporting captured page HTML.
 */
describe("agent report — confident draft", () => {
  const session: CaptureSession = {
    origin: "https://github.com",
    entries: [
      {
        url: "https://github.com/account/billing/history",
        method: "GET",
        status: 200,
        contentType: "text/html",
        responseBody: `<a href="/account/receipt/ch_AAA">r</a><a href="/account/receipt/ch_BBB">r</a>`,
      },
      { url: "https://github.com/account/receipt/ch_AAA", method: "GET", status: 200, contentType: "application/pdf" },
    ],
  };
  const report = buildAgentReport({
    version: "0.4.2",
    session,
    draft: inferRecipe(session),
    docLinks: findDocLinks(session.entries),
  });

  it("includes the recipe JSON, the origin, and the found links", () => {
    expect(report).toContain("origin: https://github.com");
    expect(report).toContain('"strategy": "html"');
    expect(report).toContain("/account/receipt/REDACTED_ID");
    expect(report).not.toContain("ch_AAA");
    expect(report).toContain("Draft recipe (confidence:");
  });
});

describe("agent report — request payloads preserve shape but not captured values", () => {
  const session: CaptureSession = {
    origin: "https://vendor.example",
    entries: [
      {
        url: "https://vendor.example/api/invoices",
        method: "POST",
        status: 200,
        contentType: "application/json",
        requestBody: JSON.stringify({
          operationName: "BillingInvoices",
          query: "query BillingInvoices($workspaceId: ID!) { invoices(workspaceId: $workspaceId) { id } }",
          variables: { workspaceId: "workspace-private-123", limit: 100 },
        }),
        responseBody: JSON.stringify({ invoices: [{ id: "inv_private", amount: 1200, date: "2026-07-01" }] }),
      },
    ],
  };
  const report = buildAgentReport({
    version: "0.7.0",
    session,
    draft: inferRecipe(session),
    docLinks: [],
  });

  it("retains the GraphQL operation while replacing variable values", () => {
    expect(report).toContain("BillingInvoices");
    expect(report).toContain('\\\"workspaceId\\\":\\\"REDACTED\\\"');
    expect(report).toContain('\\\"limit\\\":0');
    expect(report).not.toContain("workspace-private-123");
  });
});

describe("agent report — no draft stays bounded and omits HTML", () => {
  const big = "x".repeat(50_000);
  const session: CaptureSession = {
    origin: "https://weird.example",
    entries: [
      {
        url: "https://weird.example/billing",
        method: "DOM",
        status: 200,
        contentType: "text/html",
        responseBody: `<html><body>${big}<span>no invoices here</span></body></html>`,
      },
    ],
  };
  const report = buildAgentReport({
    version: "0.4.2",
    session,
    draft: inferRecipe(session), // null — nothing invoice-like
    docLinks: findDocLinks(session.entries),
  });

  it("states no recipe and stays under the paste cap", () => {
    expect(report).toContain("No recipe could be inferred");
    expect(report).not.toContain("no invoices here");
    expect(report).not.toContain(big.slice(0, 100));
    expect(report.length).toBeLessThanOrEqual(14_100); // MAX_REPORT_CHARS + truncation marker
  });
});
