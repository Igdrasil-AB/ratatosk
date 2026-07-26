import { describe, expect, it } from "vitest";
import { buildCollectorDiagnostic } from "../../collector/src/platform/diagnostics";

describe("redacted Collector diagnostics", () => {
  it("exports only stable operational metadata", () => {
    const diagnostic = buildCollectorDiagnostic({
      vendorId: "anthropic",
      collectorVersion: "0.7.0",
      lifecycleRevision: "r1",
      connection: {
        vendorId: "anthropic",
        connectedAt: 1,
        lastRunAt: Date.parse("2026-07-16T10:00:00.000Z"),
        lastStatus: "error",
        lastCode: "destination_unavailable",
        lastError: "https://secret.example?token=synthetic invoice-123 company-456 Bearer credential",
        lastCount: 2,
        lastDocumentActionCount: 4,
        lastFailedScopes: 1,
        lastEmptyScopes: 3,
      },
    });
    expect(diagnostic).toEqual({
      schema: "ratatosk.collector-diagnostic.v1",
      vendorId: "anthropic",
      collectorVersion: "0.7.0",
      lifecycleRevision: "r1",
      outcomeCode: "destination_unavailable",
      recordedAt: "2026-07-16T10:00:00.000Z",
      counts: { collected: 2, documentActions: 4, failedScopes: 1, emptyScopes: 3 },
      nextEligibleAt: null,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|token|invoice-123|company-456|bearer|https?:/i);
  });
});
