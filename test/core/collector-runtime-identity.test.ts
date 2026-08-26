import { describe, expect, it } from "vitest";
import {
  COLLECTOR_RUNTIME_IDENTITY,
  formatCollectorRuntimeIdentity,
} from "../../collector/src/platform/collector-runtime-identity";

describe("collector runtime identity", () => {
  it("makes the versioned discovery engine and its search bounds observable", () => {
    expect(COLLECTOR_RUNTIME_IDENTITY).toEqual({
      collectorVersion: "0.8.57",
      discoveryEngine: 47,
      documentAcquisition: 5,
      pages: 15,
      depth: 3,
      durationMs: 10_000,
    });
    expect(formatCollectorRuntimeIdentity()).toBe("v0.8.57 discovery-engine=47 document-acquisition=5 pages=15 depth=3 budget=10000ms");
  });
});
