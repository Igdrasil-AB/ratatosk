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
      schema: "ratatosk.collector-diagnostic.v2",
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

  it("rejects malformed nested evidence rather than copying stored text", () => {
    const diagnostic = buildCollectorDiagnostic({
      vendorId: "supplier", collectorVersion: "0.8.79", lifecycleRevision: "local-discovery-v1",
      connection: {
        vendorId: "supplier", connectedAt: 1, lastCode: "unknown",
        lastRunEvidence: { trigger: "manual", status: "error", elapsedMs: 100,
          counts: { accepted: 0, verified: 0, documentActions: 0, pageOwnedDownloads: 0, failedScopes: 0, emptyScopes: 0 },
          replay: { planKind: "semantic_dom", phases: [{ phase: "document_enumeration", result: "private invoice", durationMs: 1 }] },
        } as never,
      },
    });
    expect(diagnostic.lastRunEvidence).toBeUndefined();
    expect(JSON.stringify(diagnostic)).not.toContain("private invoice");
  });
});
