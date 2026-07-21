import { describe, expect, it } from "vitest";
import collectorManifest from "../../collector/manifest.config";
import { validateCollectorManifest, type CollectorManifestBoundary } from "../../scripts/manifest-validation";

function reviewedManifest(): CollectorManifestBoundary {
  return structuredClone(collectorManifest) as CollectorManifestBoundary;
}

describe("Collector package manifest validation", () => {
  it("accepts the reviewed permission boundary regardless of array order", () => {
    const manifest = reviewedManifest();
    manifest.permissions?.reverse();
    validateCollectorManifest(manifest);
  });

  it.each([
    ["a wildcard required host", (manifest: CollectorManifestBoundary) => { manifest.host_permissions = ["https://*/*"]; }],
    ["a missing Igdrasil required host", (manifest: CollectorManifestBoundary) => { manifest.host_permissions = []; }],
    ["an extra optional cookies permission", (manifest: CollectorManifestBoundary) => { manifest.optional_permissions = ["tabs", "cookies"]; }],
    ["missing optional tabs support", (manifest: CollectorManifestBoundary) => { manifest.optional_permissions = []; }],
  ])("rejects %s", (_label, mutate) => {
    const manifest = reviewedManifest();
    mutate(manifest);
    expect(() => validateCollectorManifest(manifest)).toThrow();
  });
});
