import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import collectorManifest from "../../collector/manifest.config";
import { ALL_VENDORS, VENDORS } from "../../src/vendors";
import {
  lifecycleCoverageIssues,
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

  it("keeps ordinary CI honest while the release gate rejects unverified public claims", () => {
    expect(releaseLifecycleIssues(VENDORS.map((vendor) => vendor.id), {
      now: new Date("2026-07-16T00:00:00.000Z"),
      collectorVersion: pkg.version,
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/anthropic.*needs_verification/),
      expect.stringMatching(/chatgpt.*evidence/i),
      expect.stringMatching(/railway.*evidence/i),
    ]));
  });

  it("rejects unsupported public DOM recipes and derives exact host permissions", () => {
    const synthetic = {
      ...VENDORS[0],
      id: "synthetic-dom",
      invoices: { strategy: "dom", list: { open: "https://example.test", steps: [], hrefsFrom: "links" }, document: {} },
    } as unknown as VendorRecipe;
    expect(publicVendorCapabilityIssues([synthetic])).toEqual([
      "synthetic-dom: public recipe requires unsupported DOM runtime strategy",
    ]);
    expect((collectorManifest as any).optional_host_permissions).toEqual(
      [...new Set(VENDORS.flatMap((vendor) => vendor.hosts))].sort(),
    );
  });

  it("labels pilot, stale, degraded, and retired states conservatively", () => {
    const pilot = VENDOR_LIFECYCLE_BY_ID.anthropic;
    expect(vendorLifecycleLabel(pilot)).toBe("Pilot · verification needed");
    expect(vendorLifecycleLabel({ ...pilot, lastLiveVerifiedAt: "2026-01-01T00:00:00.000Z", nextReviewAt: "2026-02-01T00:00:00.000Z" }, new Date("2026-07-16T00:00:00.000Z"))).toBe("Pilot · verification stale");
    expect(vendorLifecycleLabel({ ...pilot, stage: "degraded", healthReason: "vendor_change" })).toBe("Degraded · vendor change");
    expect(vendorLifecycleLabel({ ...pilot, stage: "retired", healthReason: "retired" })).toBe("Retired");
  });
});
