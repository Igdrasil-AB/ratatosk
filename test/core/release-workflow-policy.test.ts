import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release metadata workflow policy", () => {
  it("runs the release validator in pull-request CI without weakening real releases", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("npm run validate:release");
    expect(workflow).not.toContain("allow-unverified-pilot-baseline");
    expect(workflow.indexOf("npm run validate:release")).toBeLessThan(workflow.indexOf("npm run package:collector"));
    expect(workflow).not.toContain("actions/upload-artifact");

    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["release:collector"]).toContain("npm run validate:collector-release");
    expect(pkg.scripts["validate:collector-release"]).toBe("npm run validate:release");
    expect(pkg.scripts["release:collector"]).not.toContain("allow-unverified-pilot-baseline");
  });

  it("rechecks source provenance after generation and build, immediately before packaging", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    const steps = scripts["release:collector"].split(" && ");
    expect(steps[0]).toBe("npm run assert:release-source");
    expect(steps.at(-2)).toBe("npm run assert:release-source");
    expect(steps.at(-1)).toBe("npm run package:collector");
    expect(steps.indexOf("npm run ci")).toBeLessThan(steps.lastIndexOf("npm run assert:release-source"));
  });
});
