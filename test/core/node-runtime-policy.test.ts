import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

const WORKFLOWS = ".github/workflows";

function workflowSources(): Array<{ name: string; source: string }> {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({ name, source: readFileSync(join(WORKFLOWS, name), "utf8") }));
}

function matrixVersions(ci: string): string[] {
  const matrix = /node: \[([^\]]*)\]/.exec(ci)?.[1] ?? "";
  return matrix.split(",").map((value) => value.trim().replaceAll('"', "")).filter(Boolean);
}

describe("Node runtime policy", () => {
  it("matches Vite's supported floor and exercises it in CI", () => {
    const vite = JSON.parse(readFileSync("node_modules/vite/package.json", "utf8"));
    expect(pkg.engines.node).toBe(vite.engines.node);

    const ci = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
    expect(ci).toContain("node-version: ${{ matrix.node }}");
    // The floor of each range `engines.node` accepts, plus the release runtime.
    expect(matrixVersions(ci)).toEqual(["20.19.0", "22.12.0", "24"]);
  });

  it("builds releases on a runtime the test matrix already covers", () => {
    const release = readFileSync(join(WORKFLOWS, "release-collector.yml"), "utf8");
    const ci = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
    const pinned = readFileSync(".nvmrc", "utf8").trim();

    // A release must never build on a version no test job exercised: that is how
    // a generated file that is not reproducible reaches packaging undetected.
    expect(release).toContain("node-version-file: .nvmrc");
    expect(release).not.toMatch(/node-version:\s*\d/);
    expect(matrixVersions(ci)).toContain(pinned);
  });

  it("pins every action to a full commit SHA", () => {
    for (const { name, source } of workflowSources()) {
      for (const [, action, ref] of source.matchAll(/uses:\s*([\w./-]+)@(\S+)/g)) {
        expect(ref, `${name} must pin ${action} to a 40-character commit SHA`).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it("keeps a release from being cancelled by a newer run", () => {
    const release = readFileSync(join(WORKFLOWS, "release-collector.yml"), "utf8");
    expect(release).not.toContain("cancel-in-progress");
  });
});
