import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release metadata workflow policy", () => {
  it("runs the release validator in pull-request CI without weakening real releases", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("npm run validate:release -- --allow-unverified-pilot-baseline");
    expect(workflow.indexOf("npm run validate:release")).toBeLessThan(workflow.indexOf("npm run package:collector"));
    expect(workflow).not.toContain("actions/upload-artifact");

    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["release:collector"]).toContain("npm run validate:collector-release");
    expect(pkg.scripts["validate:collector-release"]).toBe("npm run validate:release");
    expect(pkg.scripts["release:collector"]).not.toContain("allow-unverified-pilot-baseline");
    expect(pkg.scripts["release:studio"]).toContain("npm run validate:studio-release");
    expect(pkg.scripts["validate:studio-release"]).toContain("npm run validate");
    expect(pkg.scripts["validate:studio-release"]).toContain("scripts/validate-studio-release.ts");
  });

  it("rechecks source provenance after generation and build, immediately before packaging", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    for (const target of ["collector", "studio"]) {
      const steps = scripts[`release:${target}`].split(" && ");
      expect(steps[0]).toBe("npm run assert:release-source");
      expect(steps.at(-2)).toBe("npm run assert:release-source");
      expect(steps.at(-1)).toBe(`npm run package:${target}`);
      expect(steps.indexOf("npm run ci")).toBeLessThan(steps.lastIndexOf("npm run assert:release-source"));
    }
  });
});
