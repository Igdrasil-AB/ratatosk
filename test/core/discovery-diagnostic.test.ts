import { describe, expect, it } from "vitest";
import {
  DISCOVERY_DIAGNOSTIC_SCHEMA,
  parseDiscoveryDiagnostic,
  toDiagnosticRoute,
  withCandidateVerification,
} from "../../collector/src/platform/discovery-diagnostic";

describe("redacted supplier-discovery diagnostics", () => {
  it("redacts tenant identifiers and query values while preserving useful route intent", () => {
    expect(toDiagnosticRoute("https://app.clickup.com/9012345678/settings/billing?token=secret#invoices"))
      .toBe("/:id/settings/billing");
    expect(toDiagnosticRoute("https://vendor.example/acme-customer/settings/billing"))
      .toBe("/:segment/settings/billing");
  });

  it("contains privacy-safe route templates and per-route structural evidence", () => {
    const diagnostic = parseDiscoveryDiagnostic({
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "dash.cloudflare.com",
      runtime: { collectorVersion: "0.8.0", discoveryEngine: 4 },
      limits: { pages: 10, depth: 3, durationMs: 15_000 },
      timing: { elapsedMs: 2_400 },
      pages: { attempted: 3, linked: 1, commonRoutes: 1 },
      evidence: {
        jsonResources: 2,
        observedRequests: 1,
        replayedRequests: 1,
        documentLinks: 0,
        structuredDataPages: 1,
        crossOriginHosts: ["api.cloudflare.com", "api.cloudflare.com"],
      },
      candidates: { compiled: 1, previewed: 1, retained: 0 },
      attempts: [
        {
          page: 1,
          source: "entry",
          route: "/:id/settings/billing",
          result: "no_candidate",
          durationMs: 300,
          evidence: { jsonResources: 0, observedRequests: 0, replayedRequests: 0, documentLinks: 1, structuredData: 0, semanticControls: 0 },
        },
        {
          page: 2,
          source: "linked",
          route: "/:id/settings/billing",
          resolvedRoute: "/login",
          adapter: "network-json",
          result: "list_failed",
          durationMs: 900,
          evidence: { jsonResources: 1, observedRequests: 1, replayedRequests: 0, documentLinks: 0, structuredData: 0, semanticControls: 0 },
        },
      ],
      termination: "queue_exhausted",
      result: "not_found",
    });

    expect(diagnostic.evidence.crossOriginHosts).toEqual(["api.cloudflare.com"]);
    expect(diagnostic.evidence).toMatchObject({ observedRequests: 1, replayedRequests: 1 });
    expect(diagnostic.attempts[1].evidence).toMatchObject({ observedRequests: 1, replayedRequests: 0 });
    const serialized = JSON.stringify(diagnostic);
    expect(diagnostic.attempts[0]).toMatchObject({ route: "/:id/settings/billing" });
    expect(serialized).not.toMatch(/https?:|[?&](?:token|code|session)=|authorization|responseBody|a473171df3249291b4be6fca57bb8444/i);
  });

  it("records broad exploration coverage without adding page or tenant data", () => {
    const diagnostic = parseDiscoveryDiagnostic({
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "app.vendor.example",
      runtime: { collectorVersion: "0.8.33", discoveryEngine: 22 },
      limits: { pages: 60, depth: 5, durationMs: 180_000 },
      timing: { elapsedMs: 42_000 },
      pages: { attempted: 20, linked: 10, commonRoutes: 8 },
      evidence: { jsonResources: 30, observedRequests: 20, replayedRequests: 0, documentLinks: 0, structuredDataPages: 4, crossOriginHosts: [] },
      candidates: { compiled: 0, previewed: 0, retained: 0 },
      coverage: {
        mode: "deep",
        attemptedFamilies: ["exact_entry", "observed_navigation", "tenant_contextual_route", "common_billing_route", "observed_network", "embedded_data", "document_provider", "semantic_download"],
        exhaustedFamilies: ["exact_entry", "observed_navigation", "tenant_contextual_route", "common_billing_route", "observed_network", "embedded_data", "document_provider", "semantic_download"],
        unavailableFamilies: [],
        slicesCompleted: 0,
      },
      attempts: [],
      termination: "queue_exhausted",
      result: "not_found",
    });

    expect(diagnostic.coverage).toEqual({
      mode: "deep",
      attemptedFamilies: ["exact_entry", "observed_navigation", "tenant_contextual_route", "common_billing_route", "observed_network", "embedded_data", "document_provider", "semantic_download"],
      exhaustedFamilies: ["exact_entry", "observed_navigation", "tenant_contextual_route", "common_billing_route", "observed_network", "embedded_data", "document_provider", "semantic_download"],
      unavailableFamilies: [],
      slicesCompleted: 0,
    });
  });

  it("distinguishes unavailable families and an exact-entry replay attempt from exhaustion", () => {
    const diagnostic = parseDiscoveryDiagnostic({
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.35", discoveryEngine: 24 },
      limits: { pages: 60, depth: 5, durationMs: 180_000 },
      timing: { elapsedMs: 5_000 },
      pages: { attempted: 2, linked: 0, commonRoutes: 0 },
      evidence: { jsonResources: 1, observedRequests: 1, replayedRequests: 0, documentLinks: 0, structuredDataPages: 1, crossOriginHosts: [] },
      candidates: { compiled: 0, previewed: 0, retained: 0 },
      coverage: {
        mode: "deep",
        attemptedFamilies: ["exact_entry", "observed_network", "embedded_data", "document_provider", "semantic_download"],
        exhaustedFamilies: ["exact_entry", "observed_network", "embedded_data", "document_provider", "semantic_download"],
        unavailableFamilies: ["observed_navigation", "tenant_contextual_route", "common_billing_route"],
        slicesCompleted: 0,
      },
      attempts: [{
        page: 2,
        source: "entry_replay",
        route: "/dashboard/org/:segment/billing",
        result: "no_candidate",
        durationMs: 1_000,
        evidence: { jsonResources: 1, observedRequests: 1, replayedRequests: 0, documentLinks: 0, structuredData: 1, semanticControls: 0 },
      }],
      termination: "queue_exhausted",
      result: "not_found",
    });

    expect(diagnostic.attempts[0].source).toBe("entry_replay");
    expect(diagnostic.coverage?.unavailableFamilies).toEqual([
      "observed_navigation",
      "tenant_contextual_route",
      "common_billing_route",
    ]);
  });

  it("migrates the previous diagnostic schema with zero traffic-source counts", () => {
    const diagnostic = parseDiscoveryDiagnostic({
      schema: "ratatosk.discovery-diagnostic.v4",
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.12", discoveryEngine: 12 },
      limits: { pages: 15, depth: 3, durationMs: 30_000 },
      timing: { elapsedMs: 100 },
      pages: { attempted: 1, linked: 0, commonRoutes: 0 },
      evidence: { jsonResources: 0, documentLinks: 0, structuredDataPages: 0, crossOriginHosts: [] },
      candidates: { compiled: 0, previewed: 0, retained: 0 },
      attempts: [{
        page: 1,
        source: "entry",
        route: "/billing",
        result: "no_candidate",
        durationMs: 10,
        evidence: { jsonResources: 0, documentLinks: 0, structuredData: 0, semanticControls: 0 },
      }],
      termination: "queue_exhausted",
      result: "not_found",
    });

    expect(diagnostic.schema).toBe(DISCOVERY_DIAGNOSTIC_SCHEMA);
    expect(diagnostic.evidence).toMatchObject({ observedRequests: 0, replayedRequests: 0 });
    expect(diagnostic.attempts[0].evidence).toMatchObject({ observedRequests: 0, replayedRequests: 0 });
  });

  it("rejects attempts carrying unrecognized free-form results", () => {
    expect(() => parseDiscoveryDiagnostic({
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.0", discoveryEngine: 4 },
      limits: { pages: 10, depth: 3, durationMs: 15_000 },
      timing: { elapsedMs: 100 },
      pages: { attempted: 1, linked: 0, commonRoutes: 0 },
      evidence: { jsonResources: 0, documentLinks: 0, structuredDataPages: 0, crossOriginHosts: [] },
      candidates: { compiled: 0, previewed: 0, retained: 0 },
      attempts: [{ page: 1, source: "entry", result: "GET https://vendor.example/billing?token=secret", durationMs: 100 }],
      termination: "queue_exhausted",
      result: "not_found",
    })).toThrow();
  });

  it("accepts the bounded aggregate of per-page document-link counts", () => {
    expect(parseDiscoveryDiagnostic({
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.13", discoveryEngine: 13 },
      limits: { pages: 15, depth: 3, durationMs: 30_000 },
      timing: { elapsedMs: 1_000 },
      pages: { attempted: 15, linked: 8, commonRoutes: 6 },
      evidence: {
        jsonResources: 0,
        observedRequests: 0,
        replayedRequests: 0,
        documentLinks: 15_000,
        structuredDataPages: 0,
        crossOriginHosts: [],
      },
      candidates: { compiled: 0, previewed: 0, retained: 0 },
      attempts: [],
      termination: "page_cap",
      result: "limit_reached",
    }).evidence.documentLinks).toBe(15_000);
  });

  it("rejects internally contradictory page and candidate counters", () => {
    const valid = {
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.13", discoveryEngine: 13 },
      limits: { pages: 15, depth: 3, durationMs: 30_000 },
      timing: { elapsedMs: 100 },
      pages: { attempted: 1, linked: 0, commonRoutes: 0 },
      evidence: { jsonResources: 0, observedRequests: 0, replayedRequests: 0, documentLinks: 0, structuredDataPages: 0, crossOriginHosts: [] },
      candidates: { compiled: 0, previewed: 0, retained: 0 },
      attempts: [{ page: 1, source: "entry", route: "/billing", result: "no_candidate", durationMs: 10 }],
      termination: "queue_exhausted",
      result: "not_found",
    };

    const attemptBeyondAggregate = structuredClone(valid);
    attemptBeyondAggregate.pages.attempted = 0;
    expect(() => parseDiscoveryDiagnostic(attemptBeyondAggregate)).toThrow(/attempt exceeds attempted pages/);

    const impossibleSources = structuredClone(valid);
    impossibleSources.pages = { attempted: 1, linked: 1, commonRoutes: 1 };
    expect(() => parseDiscoveryDiagnostic(impossibleSources)).toThrow(/inconsistent.*page counts/);

    const impossibleCandidates = structuredClone(valid);
    impossibleCandidates.candidates = { compiled: 1, previewed: 2, retained: 0 };
    expect(() => parseDiscoveryDiagnostic(impossibleCandidates)).toThrow(/inconsistent.*candidate counts/);
  });

  it("adds only closed candidate-canary outcomes to a successful scan trace", () => {
    const scan = parseDiscoveryDiagnostic({
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.1", discoveryEngine: 4 },
      limits: { pages: 10, depth: 3, durationMs: 15_000 },
      timing: { elapsedMs: 700 },
      pages: { attempted: 2, linked: 1, commonRoutes: 0 },
      evidence: { jsonResources: 0, documentLinks: 3, structuredDataPages: 0, crossOriginHosts: [] },
      candidates: { compiled: 2, previewed: 2, retained: 2 },
      attempts: [{
        page: 1,
        source: "entry",
        route: "/",
        adapter: "dom-actions",
        result: "candidate_compiled",
        durationMs: 20,
        evidence: { jsonResources: 0, documentLinks: 0, structuredData: 0, semanticControls: 2 },
      }],
      termination: "candidate_set_complete",
      result: "candidates_found",
    });
    const diagnostic = withCandidateVerification(scan, [
      { candidate: 1, adapter: "dom-links", result: "document_invalid" },
      {
        candidate: 2,
        adapter: "dom-actions",
        result: "no_documents",
        retrieval: {
          termination: "explicit_end",
          pagesVisited: 1,
          observedItems: 0,
          resolvedItems: 0,
          unresolvedItems: 0,
        },
      },
    ]);

    expect(diagnostic.verification).toEqual({
      attempted: 2,
      outcomes: [
        { candidate: 1, adapter: "dom-links", result: "document_invalid" },
        {
          candidate: 2,
          adapter: "dom-actions",
          result: "no_documents",
          retrieval: {
            termination: "explicit_end",
            pagesVisited: 1,
            observedItems: 0,
            resolvedItems: 0,
            unresolvedItems: 0,
          },
        },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/https?:|\/billing|token|responseBody/i);
  });
});
