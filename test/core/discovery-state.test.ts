import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscoveredSupplierCandidateSet, createDiscoveredSupplierProfile } from "../../src/core/discovery";
import type { VendorRecipe } from "../../src/core/types";
import {
  DISCOVERY_FAILURE_MESSAGES,
  beginSupplierDiscovery,
  beginSupplierDiscoveryConnect,
  cancelSupplierDiscovery,
  checkpointSupplierDiscovery,
  clearSupplierDiscovery,
  completeSupplierDiscovery,
  continueSupplierDiscovery,
  failSupplierDiscovery,
  getPendingSupplierDiscoveryConnect,
  getSupplierDiscoveryDiagnostic,
  getSupplierDiscoveryStatus,
  markSupplierDiscoveryScanning,
  restoreSupplierDiscoveryPreview,
  requireSupplierDiscoveryDocumentOrigins,
  setSupplierDiscoveryPreview,
} from "../../collector/src/platform/discovery-state";
import { DISCOVERY_DIAGNOSTIC_SCHEMA } from "../../collector/src/platform/discovery-diagnostic";
import { createExplorationCheckpoint } from "../../collector/src/platform/discovery-explorer";

describe("durable supplier discovery handoff", () => {
  it("discloses a token exchange to the person approving access", async () => {
    const withToken = createDiscoveredSupplierProfile({
      primaryOrigin: "https://vendor.example",
      entryUrl: "https://vendor.example/account/billing",
      displayName: "Example Vendor",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "network-json",
      candidateCount: 2,
      recipe: tokenRecipe(),
    });
    const runId = await beginSupplierDiscovery(42, "https://vendor.example");
    await markSupplierDiscoveryScanning();
    await setSupplierDiscoveryPreview(runId, createDiscoveredSupplierCandidateSet([withToken]), candidateDiagnostic());

    await expect(getSupplierDiscoveryStatus()).resolves.toMatchObject({
      stage: "preview",
      usesSessionToken: true,
    });
  });

  it("claims no token exchange when no retained plan needs one", async () => {
    const plain = createDiscoveredSupplierProfile({
      primaryOrigin: "https://vendor.example",
      entryUrl: "https://vendor.example/account/billing",
      displayName: "Example Vendor",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 2,
      recipe: recipe(),
    });
    const runId = await beginSupplierDiscovery(42, "https://vendor.example");
    await markSupplierDiscoveryScanning();
    await setSupplierDiscoveryPreview(runId, createDiscoveredSupplierCandidateSet([plain]), candidateDiagnostic());

    await expect(getSupplierDiscoveryStatus()).resolves.toMatchObject({
      stage: "preview",
      usesSessionToken: false,
    });
  });

  const values: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
          remove: vi.fn(async (key: string) => { delete values[key]; }),
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("survives the popup permission handoff without storing a full page URL", async () => {
    const runId = await beginSupplierDiscovery(42, "https://vendor.example");
    expect(await getSupplierDiscoveryStatus()).toEqual({ stage: "scanning", origin: "https://vendor.example" });
    expect(JSON.stringify(values)).not.toContain("account/billing");
    await expect(markSupplierDiscoveryScanning()).resolves.toEqual({ runId, tabId: 42, origin: "https://vendor.example" });
    await expect(cancelSupplierDiscovery()).resolves.toEqual(["https://vendor.example/*"]);
    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({ stage: "idle" });
  });

  it("retains only structural frontier progress across a worker restart", async () => {
    const runId = await beginSupplierDiscovery(42, "https://vendor.example");
    await markSupplierDiscoveryScanning();
    const checkpoint = createExplorationCheckpoint({
      mode: "deep",
      pagesAttempted: 4,
      linkedPagesAttempted: 2,
      commonRoutePagesAttempted: 1,
      elapsedMs: 2_000,
      frontier: [{ key: "common_billing_route|/account/billing/history", family: "common_billing_route", score: 90, depth: 1 }],
      completedTargetKeys: ["common_billing_route|/account/billing/history"],
      attemptedFamilies: ["exact_entry", "observed_navigation", "common_billing_route"],
      slicesCompleted: 0,
    });

    await expect(checkpointSupplierDiscovery(runId, checkpoint)).resolves.toBe(true);
    await expect(markSupplierDiscoveryScanning()).resolves.toEqual({
      runId,
      tabId: 42,
      origin: "https://vendor.example",
      checkpoint,
    });
    expect(JSON.stringify((values["supplierDiscovery.v1"] as { checkpoint?: unknown }).checkpoint))
      .not.toMatch(/https?:|token|responseBody|9012345678/i);
  });

  it("continues a capped fast search explicitly from its safe unfinished frontier", async () => {
    const runId = await beginSupplierDiscovery(42, "https://vendor.example");
    await markSupplierDiscoveryScanning();
    const checkpoint = createExplorationCheckpoint({
      mode: "fast",
      pagesAttempted: 4,
      linkedPagesAttempted: 2,
      commonRoutePagesAttempted: 1,
      elapsedMs: 10_000,
      frontier: [{
        key: "common_billing_route|/account/billing",
        family: "common_billing_route",
        score: 90,
        depth: 1,
        route: "/account/billing",
        source: "common_route",
        hintSource: "common_fallback",
      }],
      completedTargetKeys: ["exact_entry|/home"],
      attemptedFamilies: ["exact_entry", "observed_navigation"],
      slicesCompleted: 0,
    });
    await checkpointSupplierDiscovery(runId, checkpoint);
    await failSupplierDiscovery(runId, DISCOVERY_FAILURE_MESSAGES.timeCap, ["https://vendor.example/*"], {
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.50", discoveryEngine: 37 },
      limits: { pages: 15, depth: 3, durationMs: 10_000 },
      timing: { elapsedMs: 10_000 },
      pages: { attempted: 4, linked: 2, commonRoutes: 1 },
      evidence: { jsonResources: 0, observedRequests: 0, replayedRequests: 0, documentLinks: 0, structuredDataPages: 0, crossOriginHosts: [] },
      candidates: { compiled: 0, previewed: 0, retained: 0 },
      attempts: [],
      termination: "time_cap",
      result: "limit_reached",
    });

    await expect(getSupplierDiscoveryStatus()).resolves.toMatchObject({
      stage: "failed",
      reason: "limit_reached",
      canSearchDeeper: true,
      deepRemainingMs: 35_000,
      origin: "https://vendor.example",
    });
    await expect(continueSupplierDiscovery()).resolves.toMatchObject({
      runId,
      tabId: 42,
      origin: "https://vendor.example",
      checkpoint: expect.objectContaining({ mode: "deep", elapsedMs: 10_000, frontier: [expect.objectContaining({ route: "/account/billing" })] }),
    });
    expect(JSON.stringify((values["supplierDiscovery.v1"] as { checkpoint?: unknown }).checkpoint))
      .not.toMatch(/https?:|token|9012345678/i);
  });

  it("does not advertise another continuation after the deep envelope is capped", async () => {
    const runId = await beginSupplierDiscovery(42, "https://vendor.example");
    await markSupplierDiscoveryScanning();
    const checkpoint = createExplorationCheckpoint({
      mode: "deep",
      pagesAttempted: 20,
      linkedPagesAttempted: 10,
      commonRoutePagesAttempted: 5,
      elapsedMs: 45_000,
      frontier: [{
        key: "common_billing_route|/account/billing",
        family: "common_billing_route",
        score: 90,
        depth: 1,
        route: "/account/billing",
        source: "common_route",
        hintSource: "common_fallback",
      }],
      completedTargetKeys: ["exact_entry|/home"],
      attemptedFamilies: ["exact_entry", "observed_navigation"],
      slicesCompleted: 0,
    });
    await checkpointSupplierDiscovery(runId, checkpoint);
    await failSupplierDiscovery(runId, DISCOVERY_FAILURE_MESSAGES.timeCap, ["https://vendor.example/*"], {
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.50", discoveryEngine: 38 },
      limits: { pages: 40, depth: 4, durationMs: 45_000 },
      timing: { elapsedMs: 45_000 },
      pages: { attempted: 20, linked: 10, commonRoutes: 5 },
      evidence: { jsonResources: 0, observedRequests: 0, replayedRequests: 0, documentLinks: 0, structuredDataPages: 0, crossOriginHosts: [] },
      candidates: { compiled: 0, previewed: 0, retained: 0 },
      attempts: [],
      termination: "time_cap",
      result: "limit_reached",
    });

    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({
      stage: "failed",
      message: DISCOVERY_FAILURE_MESSAGES.timeCap,
      reason: "limit_reached",
      diagnosticAvailable: true,
    });
    await expect(continueSupplierDiscovery()).resolves.toBeUndefined();
  });

  it("keeps the strict profile only in session until confirmation succeeds", async () => {
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: "https://vendor.example",
      entryUrl: "https://vendor.example/account/billing",
      displayName: "Example Vendor",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 2,
      recipe: recipe(),
    });
    const candidates = createDiscoveredSupplierCandidateSet([profile]);
    const runId = await beginSupplierDiscovery(42, "https://vendor.example");
    await markSupplierDiscoveryScanning();
    await setSupplierDiscoveryPreview(runId, candidates, candidateDiagnostic());
    await expect(getSupplierDiscoveryStatus()).resolves.toMatchObject({
      stage: "preview",
      vendorId: profile.id,
      requiredOrigins: ["https://vendor.example/*"],
    });
    await expect(beginSupplierDiscoveryConnect(profile.id, "2026-03")).resolves.toEqual({
      runId,
      candidates,
      fromMonth: "2026-03",
    });
    await expect(getPendingSupplierDiscoveryConnect()).resolves.toEqual({
      runId,
      candidates,
      fromMonth: "2026-03",
    });
    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({ stage: "connecting", name: "Example Vendor" });
    await restoreSupplierDiscoveryPreview(runId);
    await expect(getSupplierDiscoveryStatus()).resolves.toMatchObject({ stage: "preview", vendorId: profile.id });
    await beginSupplierDiscoveryConnect(profile.id);
    await completeSupplierDiscovery(runId, profile.id, profile.displayName, 2, true);
    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({
      stage: "complete", vendorId: profile.id, name: "Example Vendor", count: 2, monthFallbackAll: true,
    });
    await clearSupplierDiscovery();
    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({ stage: "idle" });
  });

  it("retains only a validated redacted diagnostic for a failed search", async () => {
    const diagnostic = {
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.0", discoveryEngine: 4 },
      limits: { pages: 10, depth: 3, durationMs: 15_000 },
      timing: { elapsedMs: 1_200 },
      pages: { attempted: 2, linked: 1, commonRoutes: 0 },
      evidence: { jsonResources: 0, observedRequests: 0, replayedRequests: 0, documentLinks: 1, structuredDataPages: 0, crossOriginHosts: ["api.vendor.example"] },
      candidates: { compiled: 1, previewed: 1, retained: 0 },
      attempts: [{ page: 1, source: "entry" as const, route: "/:id/settings/billing", result: "no_candidate" as const, durationMs: 500 }],
      termination: "queue_exhausted" as const,
      result: "not_found" as const,
    };
    await failSupplierDiscovery(undefined,
      "No reusable invoice path was found after checking this app's likely billing pages.",
      ["https://vendor.example/*"],
      diagnostic,
    );
    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({
      stage: "failed",
      message: "No reusable invoice path was found after checking this app's likely billing pages.",
      reason: "not_found",
      diagnosticAvailable: true,
    });
    await expect(getSupplierDiscoveryDiagnostic()).resolves.toEqual(diagnostic);
    expect(JSON.stringify(values)).not.toMatch(/[?#]|responseBody|9012345678/i);
  });

  it("rejects preview and failure writes from superseded or cancelled discovery runs", async () => {
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: "https://vendor.example",
      entryUrl: "https://vendor.example/account/billing",
      displayName: "Example Vendor",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: recipe(),
    });
    const candidates = createDiscoveredSupplierCandidateSet([profile]);
    const runA = await beginSupplierDiscovery(42, "https://vendor.example");
    await markSupplierDiscoveryScanning();
    const runB = await beginSupplierDiscovery(43, "https://other.example");
    await markSupplierDiscoveryScanning();

    await expect(setSupplierDiscoveryPreview(runA, candidates, candidateDiagnostic())).resolves.toBe(false);
    await expect(failSupplierDiscovery(runA, DISCOVERY_FAILURE_MESSAGES.pageChanged, ["https://vendor.example/*"])).resolves.toBe(false);
    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({ stage: "scanning", origin: "https://other.example" });

    await expect(cancelSupplierDiscovery()).resolves.toEqual(["https://other.example/*"]);
    await expect(setSupplierDiscoveryPreview(runB, candidates, candidateDiagnostic())).resolves.toBe(false);
    await expect(failSupplierDiscovery(runB, DISCOVERY_FAILURE_MESSAGES.pageChanged, ["https://other.example/*"])).resolves.toBe(false);
    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({ stage: "idle" });
  });

  it("serializes a stale scan result and a replacement begin without a read/write interleave", async () => {
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: "https://vendor.example",
      entryUrl: "https://vendor.example/account/billing",
      displayName: "Example Vendor",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: recipe(),
    });
    const runA = await beginSupplierDiscovery(42, "https://vendor.example");
    await markSupplierDiscoveryScanning();

    const [previewApplied, runB] = await Promise.all([
      setSupplierDiscoveryPreview(runA, createDiscoveredSupplierCandidateSet([profile]), candidateDiagnostic()),
      beginSupplierDiscovery(43, "https://other.example"),
    ]);

    expect(previewApplied).toBe(true);
    expect(await markSupplierDiscoveryScanning()).toMatchObject({ runId: runB, tabId: 43, origin: "https://other.example" });
    await expect(setSupplierDiscoveryPreview(runA, createDiscoveredSupplierCandidateSet([profile]), candidateDiagnostic())).resolves.toBe(false);
    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({ stage: "scanning", origin: "https://other.example" });
  });

  it("preserves a typed collection failure without exposing supplier data", async () => {
    await failSupplierDiscovery(undefined, "Supplier returned an invalid document", ["https://vendor.example/*"]);
    await expect(getSupplierDiscoveryStatus()).resolves.toEqual({
      stage: "failed",
      message: "Supplier returned an invalid document",
      reason: "failed",
      diagnosticAvailable: false,
    });
  });

  it("returns a Stripe-backed preview with only the newly required exact origin", async () => {
    const stripeRecipe = recipe();
    stripeRecipe.hosts.push("https://pay.stripe.com/*");
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: "https://vendor.example",
      entryUrl: "https://vendor.example/account/billing",
      displayName: "Example Vendor",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: stripeRecipe,
    });
    const runId = await beginSupplierDiscovery(42, "https://vendor.example");
    await markSupplierDiscoveryScanning();
    await setSupplierDiscoveryPreview(runId, createDiscoveredSupplierCandidateSet([profile]), candidateDiagnostic());
    await beginSupplierDiscoveryConnect(profile.id);

    await expect(requireSupplierDiscoveryDocumentOrigins(runId, [
      "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*",
    ])).resolves.toBe(true);
    await expect(getSupplierDiscoveryStatus()).resolves.toMatchObject({
      stage: "preview",
      requiredOrigins: expect.arrayContaining([
        "https://pay.stripe.com/*",
        "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*",
      ]),
    });
    expect(JSON.stringify(values)).not.toContain("signature=");
  });

  it.each([
    "Ratatosk found a possible invoice source, but this supplier session has expired. Sign in and try again.",
    "Ratatosk found a possible invoice source, but this account does not have billing access.",
    "Ratatosk found a possible invoice source, but the supplier blocked its session check. Keep the billing page open and try again.",
    "The supplier could not be reached reliably during verification. Keep the app open and try again.",
    "Ratatosk reached its safe search-time limit before it could verify an invoice source.",
    "Ratatosk checked its safe page limit without verifying an invoice source.",
  ])("preserves the detailed closed discovery failure: %s", async (message) => {
    await failSupplierDiscovery(undefined, message, ["https://vendor.example/*"]);
    await expect(getSupplierDiscoveryStatus()).resolves.toMatchObject({ stage: "failed", message });
  });

  it("exposes a search-limit outcome separately from a technical failure", async () => {
    await failSupplierDiscovery(undefined, DISCOVERY_FAILURE_MESSAGES.pageCap, ["https://vendor.example/*"], {
      schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
      site: "vendor.example",
      runtime: { collectorVersion: "0.8.32", discoveryEngine: 22 },
      limits: { pages: 15, depth: 3, durationMs: 30_000 },
      timing: { elapsedMs: 30_000 },
      pages: { attempted: 15, linked: 8, commonRoutes: 6 },
      evidence: { jsonResources: 52, observedRequests: 52, replayedRequests: 0, documentLinks: 2, structuredDataPages: 0, crossOriginHosts: ["api.vendor.example"] },
      candidates: { compiled: 0, previewed: 0, retained: 0 },
      attempts: [],
      termination: "page_cap",
      result: "limit_reached",
    });

    await expect(getSupplierDiscoveryStatus()).resolves.toMatchObject({
      stage: "failed",
      reason: "limit_reached",
    });
  });
});

function candidateDiagnostic() {
  return {
    schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
    site: "vendor.example",
    runtime: { collectorVersion: "0.8.1", discoveryEngine: 4 },
    limits: { pages: 10, depth: 3, durationMs: 15_000 },
    timing: { elapsedMs: 800 },
    pages: { attempted: 2, linked: 1, commonRoutes: 0 },
    evidence: { jsonResources: 0, observedRequests: 0, replayedRequests: 0, documentLinks: 2, structuredDataPages: 0, crossOriginHosts: [] },
    candidates: { compiled: 1, previewed: 1, retained: 1 },
    attempts: [],
    termination: "candidate_set_complete" as const,
    result: "candidates_found" as const,
  };
}

function tokenRecipe(): VendorRecipe {
  const base = recipe();
  return {
    ...base,
    auth: {
      ...base.auth,
      token: { request: { url: "https://vendor.example/api/session" }, value: "accessToken" },
    },
    invoices: {
      strategy: "network",
      list: {
        request: {
          url: "https://vendor.example/api/invoices?limit=50",
          headers: { authorization: "Bearer {token}" },
        },
        items: "invoices",
        map: { id: "id", issuedAt: "issued_at", documentUrl: "pdf_url" },
      },
      document: { contentType: "application/pdf" },
    },
  };
}

function recipe(): VendorRecipe {
  const page = "https://vendor.example/account/billing";
  return {
    id: "candidate",
    name: "Example Vendor",
    homepage: "https://vendor.example",
    hosts: ["https://vendor.example/*"],
    fetchContext: "page",
    auth: { check: { request: { url: page }, expect: { statusIn: [200] } }, loginUrl: "https://vendor.example" },
    invoices: {
      strategy: "dom",
      list: {
        open: page,
        steps: [
          { action: "waitFor", selector: 'a[href$=".pdf"]', timeoutMs: 5_000 },
          { action: "extractAll", selector: 'a[href$=".pdf"]', attr: "href", as: "documents" },
        ],
        hrefsFrom: "documents",
      },
      document: { contentType: "application/pdf" },
    },
  };
}
