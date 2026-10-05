import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

describe("Node runtime policy", () => {
  it("matches Vite's supported floor and exercises it in Jenkins", () => {
    const vite = JSON.parse(readFileSync("node_modules/vite/package.json", "utf8"));
    expect(pkg.engines.node).toBe(vite.engines.node);
    const pipeline = readFileSync("Jenkinsfile", "utf8");
    for (const version of ["20.19.0", "22.12.0", "24.18.0"]) expect(pipeline).toContain(`node:${version}-bookworm@sha256:`);
    expect(readFileSync(".nvmrc", "utf8").trim()).toBe("24");
  });
});
