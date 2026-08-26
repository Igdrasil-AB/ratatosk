import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildCollectionIssueReport,
  buildDiscoveryIssueReport,
  generalIssueUrl,
  ISSUE_REPOSITORY,
} from "../../collector/src/platform/issue-report";
import { parseDiscoveryDiagnostic } from "../../collector/src/platform/discovery-diagnostic";
import { buildCollectorDiagnostic } from "../../collector/src/platform/diagnostics";
import type { DiscoveryDiagnosticV1 } from "../../collector/src/platform/discovery-diagnostic";

/**
 * A report has to arrive complete or not at all. The two ways that fails are a
 * URL long enough for something in the chain to truncate it, and a payload that
 * carries more than the diagnostic was ever allowed to.
 */

function diagnostic(overrides: Partial<DiscoveryDiagnosticV1> = {}): DiscoveryDiagnosticV1 {
  return parseDiscoveryDiagnostic({
    schema: "ratatosk.discovery-diagnostic.v10",
    site: "dashboard.vendor.example",
    runtime: { collectorVersion: "0.8.49", discoveryEngine: 36 },
    limits: { pages: 15, depth: 3, durationMs: 10_000 },
    timing: { elapsedMs: 7_860 },
    pages: { attempted: 10, linked: 2, commonRoutes: 6 },
    evidence: {
      jsonResources: 4, observedRequests: 3, replayedRequests: 1,
      documentLinks: 0, structuredDataPages: 1, crossOriginHosts: [],
    },
    candidates: { compiled: 0, previewed: 0, retained: 0 },
    coverage: {
      mode: "fast",
      attemptedFamilies: ["exact_entry", "common_billing_route"],
      exhaustedFamilies: [],
      unavailableFamilies: [],
      slicesCompleted: 1,
    },
    attempts: [
      { page: 1, source: "entry", route: "/home", result: "no_candidate", durationMs: 1_200 },
      { page: 2, source: "common_route", route: "/settings/billing", result: "no_candidate", durationMs: 4_180 },
      { page: 3, source: "linked", route: "/organization/:id/billing", result: "probe_failed", probeCause: "outer_deadline", durationMs: 2_200 },
    ],
    termination: "time_cap",
    result: "limit_reached",
    ...overrides,
  });
}

function bodyOf(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get("body") ?? "");
}

describe("prefilled issue reports", () => {
  it("opens against this repository's issue tracker", () => {
    expect(generalIssueUrl().startsWith(`${ISSUE_REPOSITORY}/issues/new`)).toBe(true);
    expect(new URL(buildDiscoveryIssueReport(diagnostic()).url).origin).toBe("https://github.com");
  });

  it("labels a report so it can be told apart from a hand-written one", () => {
    const labels = new URL(buildDiscoveryIssueReport(diagnostic()).url).searchParams.get("labels");
    expect(labels).toContain("from-extension");
    expect(labels).toContain("discovery");
    expect(new URL(generalIssueUrl()).searchParams.get("labels")).toBe("from-extension");
  });

  it("answers the questions a maintainer would otherwise have to ask", () => {
    const body = bodyOf(buildDiscoveryIssueReport(diagnostic()).url);

    expect(body).toContain("0.8.49");
    expect(body).toContain("limit_reached");
    expect(body).toContain("time_cap");
    expect(body).toContain("7860ms of 10000ms");
    expect(body).toContain("10 of 15");
    // Slowest first, so the page that spent the budget is the one read first.
    expect(body.indexOf("/settings/billing")).toBeLessThan(body.indexOf("/organization/:id/billing"));
    expect(body).toContain("probe_failed/outer_deadline");
  });

  it("puts the full record on the clipboard, never in the URL", () => {
    const report = buildDiscoveryIssueReport(diagnostic());

    expect(JSON.parse(report.clipboard)).toMatchObject({ result: "limit_reached", termination: "time_cap" });
    // The body asks for one paste rather than carrying the record itself.
    expect(bodyOf(report.url)).toContain("copied to your clipboard");
    expect(report.url).not.toContain("jsonResources");
  });

  it("stays inside a URL length nothing will truncate", () => {
    const attempts = Array.from({ length: 15 }, (_value, index) => ({
      page: index + 1,
      source: "common_route" as const,
      route: `/a-fairly-long-billing-route-name/${index}/settings/billing/history`,
      result: "no_candidate" as const,
      durationMs: 4_000 + index,
    }));
    const report = buildDiscoveryIssueReport(diagnostic({ attempts, pages: { attempted: 15, linked: 2, commonRoutes: 13 } }));

    const body = bodyOf(report.url);

    expect(report.url.length).toBeLessThanOrEqual(6_000);
    // Trimming may drop table rows; it may never drop the paste instruction,
    // because the record cannot be reconstructed without it.
    expect(body).toContain("copied to your clipboard");
    expect(JSON.parse(report.clipboard).attempts).toHaveLength(15);
    // The table must survive as a table, and keep the pages worth reading.
    expect(body).toContain("| # | Route | Source | Adapter | Result | Time |");
    expect(body).toContain("| --- | --- | --- | --- | --- | --- |");
    expect(body).toContain("/a-fairly-long-billing-route-name/14/");
    expect(body).toContain("- **Site**");
  });

  it("fits without dropping anything, even at the widest a diagnostic can be", () => {
    // A route template is capped at 160 characters and the table at 8 rows, so
    // the worst case is bounded. Trimming exists as a backstop; if this test
    // ever needs it, the summary grew and that is worth noticing.
    const attempts = Array.from({ length: 8 }, (_value, index) => ({
      page: index + 1,
      source: "common_route" as const,
      route: `/route-${index}/`.padEnd(159, "x"),
      result: "no_candidate" as const,
      durationMs: 1_000 * (index + 1),
    }));
    const body = bodyOf(buildDiscoveryIssueReport(diagnostic({
      attempts,
      pages: { attempted: 8, linked: 0, commonRoutes: 8 },
    })).url);
    const rows = body.split("\n").filter((line) =>
      line.startsWith("| ") && !line.startsWith("| # ") && !line.startsWith("| --- "));

    expect(rows).toHaveLength(8);
    // Slowest first, so the page that spent the budget is read first.
    expect(rows[0]).toContain("8000ms");
    expect(rows.at(-1)).toContain("1000ms");
  });

  it("names the site, because a timing complaint without one is not actionable", () => {
    const report = buildDiscoveryIssueReport(diagnostic());

    expect(new URL(report.url).searchParams.get("title")).toContain("dashboard.vendor.example");
    expect(bodyOf(report.url)).toContain("dashboard.vendor.example");
  });

  it("says what it includes, hostname and all, rather than implying anonymity", () => {
    // A report names which supplier someone uses, and it is filed publicly.
    // Claiming otherwise in the footer would be the actual privacy failure.
    const body = bodyOf(buildDiscoveryIssueReport(diagnostic()).url);

    expect(body).toContain("Includes `dashboard.vendor.example`");
    expect(body).toContain("No page content, account or invoice identifier, header, response body, or credential.");
  });

  it("carries nothing the diagnostic was not already allowed to hold", () => {
    const report = buildDiscoveryIssueReport(diagnostic());

    // The hostname travels alone: never a scheme, path, query, or fragment.
    expect(report.clipboard).not.toMatch(/https?:\/\//);
    expect(JSON.parse(report.clipboard).attempts.every((attempt: { route: string }) =>
      attempt.route.startsWith("/"))).toBe(true);
  });

  it("reports a failing supplier with its outcome and counts", () => {
    const report = buildCollectionIssueReport(buildCollectorDiagnostic({
      vendorId: "railway",
      collectorVersion: "0.8.49",
      lifecycleRevision: "7",
      connection: { connectedAt: 1, lastCode: "auth_expired", lastCount: 0, lastFailedScopes: 2 } as never,
    }));
    const body = bodyOf(report.url);

    expect(body).toContain("railway");
    expect(body).toContain("auth_expired");
    expect(body).toContain("2 failed scopes");
    expect(report.url.length).toBeLessThanOrEqual(6_000);
  });

  it("is offered where a run failed, and never on one that worked", () => {
    const popup = readFileSync("collector/src/ui/popup/popup.ts", "utf8");
    const card = popup.slice(popup.indexOf('discovery.stage === "failed"'), popup.indexOf("tab-awareness-title"));

    expect(card).toContain('data-action="report-discovery"');
    // The success card stays a confirmation and nothing else.
    const success = popup.slice(popup.indexOf('discovery.stage === "complete"'), popup.indexOf('discovery.stage === "failed"'));
    expect(success).not.toContain("report-discovery");
    expect(success).not.toContain("data-action");
    // A supplier only offers one once its last run did not end ok.
    expect(popup).toContain('connection.lastStatus && connection.lastStatus !== "ok"');
  });

  it("keeps a general route for anything a diagnostic does not describe", () => {
    const popup = readFileSync("collector/src/ui/popup/popup.ts", "utf8");

    expect(popup).toContain('data-action="open-issues"');
    expect(popup).toContain("generalIssueUrl()");
  });

  it("discloses that a report is public and names the supplier", () => {
    const privacy = readFileSync("PRIVACY.md", "utf8");

    expect(privacy).toContain("Report\nIssue");
    expect(privacy).toMatch(/nothing becomes public until the user reviews it and presses\s+submit/);
    expect(privacy).toMatch(/names the supplier's hostname/);
    // The standing "no automatic reporting" promise must survive this feature.
    expect(privacy).toMatch(/no automatic or background report of any kind/);
  });

  it("copies before opening, so the form is never shown half-ready", () => {
    const popup = readFileSync("collector/src/ui/popup/popup.ts", "utf8");
    const open = popup.slice(popup.indexOf("async function openIssueReport"), popup.indexOf("async function reportVendorIssue"));

    expect(open.indexOf("clipboard.writeText")).toBeLessThan(open.indexOf("chrome.tabs.create"));
    expect(open).toContain("return;");
  });
});
