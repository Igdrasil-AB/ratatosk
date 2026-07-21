import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("roadmap contract dependencies", () => {
  it("declares Plan 005 wherever Plan 010 consumes its operational outcome contract", () => {
    const producer = readFileSync("plans/005-operationalize-collector-failures.md", "utf8");
    const consumer = readFileSync("plans/010-orchestrate-vendor-health-with-temporal.md", "utf8");
    const roadmap = readFileSync("plans/README.md", "utf8");

    expect(producer).toContain("`collector.operational-outcome.v1`");
    expect(consumer).toMatch(/\*\*Depends on\*\*: Plans 004, 005, and 008/);
    expect(consumer).toContain("Plan 005's `collector.operational-outcome.v1`");
    expect(roadmap).toMatch(/\[010\].*\| 004, 005, 008 \|/);
    expect(roadmap).toMatch(/005 failures [─]+┤/);
  });
});
