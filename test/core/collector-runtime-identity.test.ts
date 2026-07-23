import { describe, expect, it } from "vitest";
import {
  COLLECTOR_RUNTIME_IDENTITY,
  formatCollectorRuntimeIdentity,
} from "../../collector/src/platform/collector-runtime-identity";

describe("collector runtime identity", () => {
  it("makes the versioned discovery engine and its search bounds observable", () => {
    expect(COLLECTOR_RUNTIME_IDENTITY).toEqual({
      collectorVersion: "0.8.38",
      discoveryEngine: 27,
      pages: 15,
      depth: 3,
      durationMs: 30_000,
    });
    expect(formatCollectorRuntimeIdentity()).toBe("v0.8.38 discovery-engine=27 pages=15 depth=3 budget=30000ms");
  });
});
