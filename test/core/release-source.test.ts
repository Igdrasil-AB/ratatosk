import { describe, expect, it } from "vitest";
import { assertCleanReleaseSource } from "../../scripts/assert-release-source";

describe("release source provenance gate", () => {
  it("rejects a dirty source tree before a release can be packaged", () => {
    expect(() => assertCleanReleaseSource(() => " M src/core/engine.ts\n" as never)).toThrow(/release source is dirty/);
  });

  it("accepts a clean source tree", () => {
    expect(() => assertCleanReleaseSource(() => "" as never)).not.toThrow();
  });
});
