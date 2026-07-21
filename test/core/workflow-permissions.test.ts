import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub workflow token policy", () => {
  it("runs pull-request CI with read-only contents and no persisted checkout token", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const permissions = workflow.indexOf("permissions:\n  contents: read");
    const jobs = workflow.indexOf("jobs:");

    expect(permissions).toBeGreaterThan(0);
    expect(permissions).toBeLessThan(jobs);
    expect(workflow).toMatch(/actions\/checkout@[^\n]+\n\s+with:\n\s+persist-credentials: false/);
  });

  it("does not persist the CodeQL checkout token or request package access", () => {
    const workflow = readFileSync(".github/workflows/codeql.yml", "utf8");

    expect(workflow).toContain("security-events: write");
    expect(workflow).not.toContain("packages: read");
    expect(workflow).toMatch(/actions\/checkout@[^\n]+\n\s+with:\n\s+persist-credentials: false/);
  });
});
