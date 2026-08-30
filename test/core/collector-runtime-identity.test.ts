import { describe, expect, it } from "vitest";
import {
  COLLECTOR_RUNTIME_IDENTITY,
  formatCollectorRuntimeIdentity,
} from "../../collector/src/platform/collector-runtime-identity";

describe("collector runtime identity", () => {
  it("makes the versioned discovery engine and its search bounds observable", () => {
    expect(COLLECTOR_RUNTIME_IDENTITY).toEqual({
      collectorVersion: "0.8.78",
      discoveryEngine: 63,
      documentAcquisition: 16,
      pages: 40,
      depth: 4,
      durationMs: 60_000,
    });
    expect(formatCollectorRuntimeIdentity()).toBe("v0.8.78 discovery-engine=63 document-acquisition=16 pages=40 depth=4 budget=60000ms");
  });
});
