import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

describe("Node runtime policy", () => {
  it("matches Vite's supported floor and exercises it in CI", () => {
    const vite = JSON.parse(readFileSync("node_modules/vite/package.json", "utf8"));
    expect(pkg.engines.node).toBe(vite.engines.node);

    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain('node: ["20.19.0", "24"]');
    expect(ci).toContain("node-version: ${{ matrix.node }}");

    const release = readFileSync(".github/workflows/release-collector.yml", "utf8");
    expect(release).toContain("node-version: 22.12.0");
  });
});
