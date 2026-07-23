import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import collectorManifest from "../../collector/manifest.config";
import { ALL_VENDORS, EXPERIMENTAL_VENDORS, VENDORS, getVendor } from "../../src/vendors";
import {
  lifecycleCoverageIssues,
  isLifecycleRunnable,
  parseVendorLifecycleManifest,
  publicVendorCapabilityIssues,
  releaseLifecycleIssues,
  vendorLifecycleLabel,
  VENDOR_LIFECYCLE_BY_ID,
  VENDOR_LIFECYCLE_MANIFEST,
} from "../../src/vendors/lifecycle";
import type { VendorRecipe } from "../../src/core/types";

describe("vendor lifecycle manifest", () => {
  it("strictly covers all recipes without publishing sensitive evidence", () => {
    expect(lifecycleCoverageIssues(ALL_VENDORS)).toEqual([]);
    expect(Object.keys(VENDOR_LIFECYCLE_BY_ID).sort()).toEqual(ALL_VENDORS.map((vendor) => vendor.id).sort());
    expect(JSON.stringify(VENDOR_LIFECYCLE_MANIFEST)).not.toMatch(/https?:\/\/|invoice|account|credential/i);
  });

  it("keeps the exported manifest, vendor array, entries, and lookup immutable and consistent", () => {
    const first = VENDOR_LIFECYCLE_MANIFEST.vendors[0];
    expect(Object.isFrozen(VENDOR_LIFECYCLE_MANIFEST)).toBe(true);
    expect(Object.isFrozen(VENDOR_LIFECYCLE_MANIFEST.vendors)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(VENDOR_LIFECYCLE_BY_ID)).toBe(true);
    expect(VENDOR_LIFECYCLE_BY_ID[first.vendorId]).toBe(first);

    expect(() => (VENDOR_LIFECYCLE_MANIFEST.vendors as typeof first[]).push(first)).toThrow();
    expect(() => { (VENDOR_LIFECYCLE_MANIFEST.vendors as typeof first[])[0] = first; }).toThrow();
    expect(() => { (first as { stage: string }).stage = "retired"; }).toThrow();
    expect(() => { (VENDOR_LIFECYCLE_BY_ID as Record<string, typeof first>)[first.vendorId] = first; }).toThrow();
    expect(VENDOR_LIFECYCLE_BY_ID[first.vendorId]).toBe(VENDOR_LIFECYCLE_MANIFEST.vendors[0]);
  });

  it("rejects duplicate recipe IDs, including public/experimental overlap", () => {
    expect(lifecycleCoverageIssues([...ALL_VENDORS, ALL_VENDORS[0]])).toContain(
      `${ALL_VENDORS[0].id}: duplicate recipe id`,
    );
    const overlappingExperimental = { ...EXPERIMENTAL_VENDORS[0], id: VENDORS[0].id } as VendorRecipe;
    expect(lifecycleCoverageIssues([...VENDORS, overlappingExperimental])).toContain(
      `${VENDORS[0].id}: duplicate recipe id`,
    );
  });

  it("rejects unknown fields, duplicates, invalid stages, and future attestations", () => {
    const base = structuredClone(VENDOR_LIFECYCLE_MANIFEST) as any;
    base.vendors[0].unexpected = true;
    expect(() => parseVendorLifecycleManifest(base)).toThrow();

    const duplicate = structuredClone(VENDOR_LIFECYCLE_MANIFEST) as any;
    duplicate.vendors.push(structuredClone(duplicate.vendors[0]));
    expect(() => parseVendorLifecycleManifest(duplicate)).toThrow(/duplicate/i);

    const invalidStage = structuredClone(VENDOR_LIFECYCLE_MANIFEST) as any;
    invalidStage.vendors[0].stage = "production";
    expect(() => parseVendorLifecycleManifest(invalidStage)).toThrow();

    const future = structuredClone(VENDOR_LIFECYCLE_MANIFEST) as any;
    Object.assign(future.vendors[0], {
      lastLiveVerifiedAt: "2027-01-01T00:00:00.000Z",
      collectorVersion: pkg.version,
      chromeMajor: 140,
      evidenceRef: "receipt:synthetic-verification",
      nextReviewAt: "2027-02-01T00:00:00.000Z",
      healthReason: "healthy",
    });
    expect(() => parseVendorLifecycleManifest(future, new Date("2026-07-16T00:00:00.000Z"))).toThrow(/future/i);
  });

  it("allows bundled pilot recipes to ship without live attestation metadata", () => {
    expect(releaseLifecycleIssues(VENDORS.map((vendor) => vendor.id), {
      now: new Date("2026-07-16T00:00:00.000Z"),
      collectorVersion: pkg.version,
    })).toEqual([]);
  });

  it("rejects unreviewed registry DOM recipes and declares runtime supplier consent", () => {
    const synthetic = {
      ...VENDORS[0],
      id: "synthetic-dom",
      invoices: { strategy: "dom", list: { open: "https://example.test", steps: [], hrefsFrom: "links" }, document: {} },
    } as unknown as VendorRecipe;
    expect(publicVendorCapabilityIssues([synthetic])).toEqual([
      "synthetic-dom: public recipe requires unsupported DOM runtime strategy",
    ]);
    expect((collectorManifest as any).optional_host_permissions).toEqual(["https://*/*"]);
    expect((collectorManifest as any).optional_permissions).toEqual(["tabs"]);
    expect((collectorManifest as any).permissions).toContain("activeTab");
    expect((collectorManifest as any).permissions).toContain("webRequest");
    expect((collectorManifest as any).permissions).toContain("sidePanel");
    expect((collectorManifest as any).side_panel).toEqual({
      default_path: "collector/src/ui/popup/popup.html",
    });
    expect((collectorManifest as any).action.default_popup).toBeUndefined();
    expect((collectorManifest as any).permissions).not.toContain("webRequestBlocking");
  });

  it("requests the exact current Stripe upload redirect origin for PDF recipes", () => {
    const stripePdfVendors = VENDORS.filter((vendor) => vendor.hosts.includes("https://pay.stripe.com/*"));
    expect(stripePdfVendors.length).toBeGreaterThan(0);
    for (const vendor of stripePdfVendors) {
      expect(vendor.hosts).toContain("https://stripe-upload-api.s3.us-west-1.amazonaws.com/*");
    }
  });

  it("labels pilot, stale, degraded, and retired states conservatively", () => {
    const pilot = VENDOR_LIFECYCLE_BY_ID.anthropic;
    expect(vendorLifecycleLabel(pilot)).toBe("Pilot · bundled recipe");
    expect(vendorLifecycleLabel({ ...pilot, lastLiveVerifiedAt: "2026-01-01T00:00:00.000Z", nextReviewAt: "2026-02-01T00:00:00.000Z" }, new Date("2026-07-16T00:00:00.000Z"))).toBe("Pilot · bundled recipe");
    expect(vendorLifecycleLabel({ ...pilot, stage: "degraded", healthReason: "vendor_change" })).toBe("Degraded · vendor change");
    expect(vendorLifecycleLabel({ ...pilot, stage: "retired", healthReason: "retired" })).toBe("Retired");
  });

  it("uses the release verification window even when next review is later", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const oldButFutureReview = {
      ...VENDOR_LIFECYCLE_BY_ID.anthropic,
      healthReason: "healthy" as const,
      lastLiveVerifiedAt: "2026-04-16T23:59:59.000Z",
      collectorVersion: pkg.version,
      chromeMajor: 140,
      evidenceRef: "receipt:old-verification",
      nextReviewAt: "2026-12-01T00:00:00.000Z",
    };

    expect(vendorLifecycleLabel(oldButFutureReview, now)).toBe("Pilot · bundled recipe");
    expect(isLifecycleRunnable(oldButFutureReview, now)).toBe(true);
    expect(releaseLifecycleIssues(["anthropic"], { now, collectorVersion: pkg.version }, { anthropic: oldButFutureReview })).toEqual([]);
    const supported = { ...oldButFutureReview, stage: "supported" as const };
    expect(isLifecycleRunnable(supported, now)).toBe(false);
    expect(releaseLifecycleIssues(["anthropic"], { now, collectorVersion: pkg.version }, { anthropic: supported }))
      .toContain("anthropic: live verification is older than 90 days");
  });

  it("never runs a vendor held for security review regardless of its stage", () => {
    const pilot = VENDOR_LIFECYCLE_BY_ID.anthropic;
    const heldPilot = { ...pilot, stage: "pilot" as const, healthReason: "security_hold" as const };
    expect(isLifecycleRunnable(heldPilot)).toBe(false);
    expect(isLifecycleRunnable({ ...pilot, stage: "supported", healthReason: "security_hold" })).toBe(false);
    expect(releaseLifecycleIssues(["anthropic"], { collectorVersion: pkg.version }, { anthropic: heldPilot }))
      .toContain("anthropic: health reason security_hold is not release-ready");
  });

  it("runs bundled pilots without requiring live evidence", () => {
    const pilot = VENDOR_LIFECYCLE_BY_ID.anthropic;
    expect(getVendor("anthropic")).toBe(VENDORS.find((recipe) => recipe.id === "anthropic"));
    expect(isLifecycleRunnable(pilot)).toBe(true);

    const verified = {
      ...pilot,
      healthReason: "healthy" as const,
      lastLiveVerifiedAt: "2026-07-20T00:00:00.000Z",
      collectorVersion: "0.8.30",
      chromeMajor: 140,
      evidenceRef: "receipt:anthropic-pilot",
      nextReviewAt: "2026-08-20T00:00:00.000Z",
    };
    expect(isLifecycleRunnable(verified, new Date("2026-07-21T00:00:00.000Z"))).toBe(true);
    expect(getVendor("anthropic", { anthropic: verified })).toBe(VENDORS.find((recipe) => recipe.id === "anthropic"));
    expect(isLifecycleRunnable({ ...verified, nextReviewAt: "2026-07-20T00:00:00.000Z" }, new Date("2026-07-21T00:00:00.000Z"))).toBe(true);
  });

  it("keeps every illustrative recipe out of the executable Collector registry", () => {
    const publicIds = VENDORS.map((vendor) => vendor.id);
    expect(EXPERIMENTAL_VENDORS.map((vendor) => vendor.id).sort()).toEqual(["github", "slack", "vercel"]);
    for (const vendor of EXPERIMENTAL_VENDORS) {
      expect(VENDOR_LIFECYCLE_BY_ID[vendor.id]).toMatchObject({
        stage: "experimental",
        healthReason: "experimental_unverified",
        lastLiveVerifiedAt: null,
      });
      expect(publicIds).not.toContain(vendor.id);
      expect(getVendor(vendor.id)).toBeUndefined();
    }
  });

  it("rejects contradictory retired lifecycle states and never runs a retired reason", () => {
    const contradictory = structuredClone(VENDOR_LIFECYCLE_MANIFEST) as any;
    contradictory.vendors[0].healthReason = "retired";
    expect(() => parseVendorLifecycleManifest(contradictory)).toThrow(/retired.*stage/i);

    const pilot = VENDOR_LIFECYCLE_BY_ID.anthropic;
    expect(isLifecycleRunnable({ ...pilot, stage: "pilot", healthReason: "retired" })).toBe(false);
    expect(isLifecycleRunnable({ ...pilot, stage: "supported", healthReason: "retired" })).toBe(false);
  });
});
