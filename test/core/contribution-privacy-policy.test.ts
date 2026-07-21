import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import studioManifest from "../../studio/manifest.config";
import { SVALA_FINGERPRINT_ENDPOINT } from "../../studio/src/platform/fingerprint-transport";

describe("public supplier contribution privacy policy", () => {
  it("prohibits identifying origins and provides a private fallback", () => {
    const guide = readFileSync("docs/contributing-supplier-fingerprints.md", "utf8");

    expect(guide).toContain("canonical, vendor-wide public origin");
    expect(guide).toContain("tenant-,\n   workspace-, account-, customer-, or employee-specific host");
    expect(guide).toContain("omit the origin instead");
    expect(guide).toContain("private GitHub security advisory");
    expect(guide).toContain("do not attach the origin or capture data yet");
  });

  it("keeps the Studio delivery threat model aligned with the fixed transport", () => {
    const security = readFileSync("SECURITY.md", "utf8");
    const endpointOrigin = new URL(SVALA_FINGERPRINT_ENDPOINT).origin;

    expect((studioManifest as { host_permissions?: string[] }).host_permissions).toEqual([`${endpointOrigin}/*`]);
    expect(security).toContain(SVALA_FINGERPRINT_ENDPOINT);
    expect(security).toContain("delivery is explicit-only");
    expect(security).toContain("extension-local scoped token");
    expect(security).toContain("redirect refusal");
    expect(security).toContain("startup never delivers pending or retryable records");
    expect(security).not.toMatch(/no (?:configured )?delivery endpoint|no .*host permission/i);
  });
});
