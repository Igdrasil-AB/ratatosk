import { describe, expect, it } from "vitest";
import { buildAgentReport } from "../../src/core/recorder/report";
import { inferRecipe, findDocLinks } from "../../src/core/recorder/infer";
import type { CaptureSession } from "../../src/core/recorder/types";

/**
 * The "Copy for agent" payload is the hand-off from browser to coding agent, so
 * it must (a) carry a confident recipe verbatim and (b) degrade to a useful HTML
 * excerpt — bounded — when inference can't produce one.
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
    expect(report).toContain("/account/receipt/ch_AAA");
    expect(report).toContain("Draft recipe (confidence:");
  });
});

describe("agent report — no draft, falls back to bounded HTML excerpt", () => {
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
    expect(report).toContain("HTML diagnostic");
    expect(report.length).toBeLessThanOrEqual(14_100); // MAX_REPORT_CHARS + truncation marker
  });
});
