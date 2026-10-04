import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { junitForChrome } from "../../scripts/ci/chrome-junit";

describe("Jenkins Ratatosk gate", () => {
  it("has no GitHub Actions workflows", () => {
    const dir = ".github/workflows";
    expect(existsSync(dir) ? readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)) : []).toEqual([]);
  });

  it("runs the existing Node matrix and built browser suites without a bound secret", () => {
    const pipeline = readFileSync("Jenkinsfile", "utf8");
    for (const version of ["20.19.0", "22.12.0", "24.18.0"]) expect(pipeline).toContain(version);
    expect(pipeline).toContain("checkout scm");
    expect(pipeline).toContain("npm run validate:release");
    expect(pipeline).toContain("npm run test:chrome-discovery:junit");
    expect(pipeline).toContain("npm run test:chrome-acquisition:junit");
    expect(pipeline).toContain("npm run verify:collector-artifact");
    expect(pipeline).toContain("allowEmptyResults: false");
    expect(pipeline).toContain("build job: 'ratatosk/codeql'");
    expect(pipeline).toContain("string(name: 'SOURCE_SHA', value: sourceSha)");
    expect(pipeline).toContain("git fetch --no-tags origin refs/pull/");
    expect(pipeline).toContain("git rev-parse HEAD^{tree}");
    expect(pipeline).toContain("git rev-parse FETCH_HEAD^{tree}");
    expect(pipeline).toContain("Tested checkout differs from the current PR merge tree");
    expect(pipeline).not.toContain("withCredentials(");
    expect(pipeline).not.toContain("github upload-results");
  });

  it("publishes one closed case per browser result and fails on an empty or failed run", () => {
    const passed = junitForChrome("discovery", "[chrome-discovery] server repeat=1 candidate_found count=1 elapsed=450ms\n", 0);
    expect(passed.cases).toBe(1);
    expect(passed.xml).toContain('<testcase name="server"/>');
    expect(passed.xml).toContain('failures="0"');
    expect(junitForChrome("acquisition", "", 0).xml).toContain('<failure message="browser harness failed or emitted no cases"/>');
    expect(junitForChrome("acquisition", "[chrome-acquisition] network first=1\n", 1).xml).toContain('failures="1"');
  });
});
