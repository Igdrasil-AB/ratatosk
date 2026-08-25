import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("release metadata workflow policy", () => {
  it("runs the release validator in pull-request CI without weakening real releases", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("npm run validate:release");
    expect(workflow).not.toContain("allow-unverified-pilot-baseline");
    expect(workflow.indexOf("npm run validate:release")).toBeLessThan(workflow.indexOf("npm run package:collector"));
    expect(workflow).not.toContain("actions/upload-artifact");
    expect(workflow).toContain("npm run test:chrome-acquisition:built");

    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["release:collector"]).toContain("npm run validate:collector-release");
    expect(pkg.scripts["validate:collector-release"]).toContain("npm run validate:release");
    expect(pkg.scripts["validate:collector-release"]).toContain("npm run test:collector-release-regressions");
    expect(pkg.scripts["validate:collector-release"]).toContain("npm run test:chrome-acquisition:built");
    expect(pkg.scripts["validate:collector-release"]).toContain("validate-semantic-dom-acceptance.ts");
    expect(pkg.scripts["release:collector"]).not.toContain("allow-unverified-pilot-baseline");
  });

  it("rechecks source provenance after generation and build, immediately before packaging", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    const steps = scripts["release:collector"].split(" && ");
    const packageIndex = steps.indexOf("npm run package:collector");
    expect(steps[0]).toBe("npm run assert:release-source");
    expect(steps[packageIndex - 1]).toBe("npm run assert:release-source");
    expect(steps.at(-1)).toBe("npm run validate:collector-release");
    expect(steps.indexOf("npm run ci")).toBeLessThan(packageIndex - 1);
    expect(packageIndex).toBeLessThan(steps.indexOf("npm run validate:collector-release"));
    expect(scripts["validate:collector-release"]).toContain("npm run verify:collector-artifact");
  });

  it("prepares one exact live package before the hostname-only Chrome handoff", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    const prepare = scripts["prepare:live-supplier-test"].split(" && ");
    expect(prepare[0]).toBe("npm run assert:release-source");
    expect(prepare).toContain("npm run ci");
    expect(prepare).toContain("npm run audit:security");
    expect(prepare).toContain("npm run build:collector");
    expect(prepare.at(-1)).toBe("tsx scripts/prepare-live-supplier-test.ts");

    execFileSync("bash", ["-n", "scripts/live-supplier-test.sh"]);
    const wizard = readFileSync("scripts/live-supplier-test.sh", "utf8");
    expect(wizard).toContain("serviceWorkerChunk");
    expect(wizard).toContain("approved-hosts.txt");
    expect(wizard).toContain("destination_readback");
    expect(wizard).toContain("cadence_accepted");
    expect(wizard).toContain("page_owned_downloads");
    expect(wizard).not.toMatch(/HAR|page source|network body/i);
  });
});
