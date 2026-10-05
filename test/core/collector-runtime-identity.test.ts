import { describe, expect, it } from "vitest";
import {
  COLLECTOR_RUNTIME_IDENTITY,
  formatCollectorRuntimeIdentity,
} from "../../collector/src/platform/collector-runtime-identity";

describe("collector runtime identity", () => {
  it("makes the versioned discovery engine and its search bounds observable", () => {
    expect(COLLECTOR_RUNTIME_IDENTITY).toEqual({
      collectorVersion: "0.8.79",
      discoveryEngine: 64,
      documentAcquisition: 17,
      pages: 40,
      depth: 4,
      durationMs: 60_000,
    });
    expect(formatCollectorRuntimeIdentity()).toBe("v0.8.79 discovery-engine=64 document-acquisition=17 pages=40 depth=4 budget=60000ms");
  });
});
