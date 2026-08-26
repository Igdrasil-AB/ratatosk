import { describe, expect, it } from "vitest";
import {
  COLLECTOR_RUNTIME_IDENTITY,
  formatCollectorRuntimeIdentity,
} from "../../collector/src/platform/collector-runtime-identity";

describe("collector runtime identity", () => {
  it("makes the versioned discovery engine and its search bounds observable", () => {
    expect(COLLECTOR_RUNTIME_IDENTITY).toEqual({
      collectorVersion: "0.8.64",
      discoveryEngine: 54,
      documentAcquisition: 6,
      pages: 40,
      depth: 4,
      durationMs: 60_000,
    });
    expect(formatCollectorRuntimeIdentity()).toBe("v0.8.64 discovery-engine=54 document-acquisition=6 pages=40 depth=4 budget=60000ms");
  });
});
