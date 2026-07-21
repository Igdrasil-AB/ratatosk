import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workflow action supply chain", () => {
  it("pins every third-party action to an immutable commit", () => {
    for (const file of readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name))) {
      const source = readFileSync(`.github/workflows/${file}`, "utf8");
      for (const line of source.split("\n").filter((candidate) => candidate.includes("uses:"))) {
        expect(line).toMatch(/uses:\s+(?:[\w.-]+\/)+[\w.-]+@[a-f0-9]{40}(?:\s|#|$)/i);
      }
    }
  });
});
