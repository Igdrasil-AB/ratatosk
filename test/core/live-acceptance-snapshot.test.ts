import { describe, expect, it } from "vitest";
import { parseLiveAcceptanceSnapshot } from "../../src/core/live-acceptance";

describe("privacy-safe live acceptance snapshot", () => {
  it("accepts only closed preview and connected fields", () => {
    expect(parseLiveAcceptanceSnapshot(preview())).toMatchObject({
      stage: "preview",
      planCount: 2,
      planKinds: ["network", "semantic_dom"],
    });
    expect(parseLiveAcceptanceSnapshot({
      ...envelope(),
      stage: "connected",
      selectedPlanKind: "semantic_dom",
      destinationKind: "igdrasil",
      destinationToken: "a".repeat(24),
      run: {
        recordedAt: "2026-08-26T10:01:00.000Z",
        status: "ok",
        acceptedCount: 1,
        actionCount: 1,
        ledgerCount: 1,
        pageOwnedDownloadDelta: 0,
      },
    })).toMatchObject({ stage: "connected", destinationKind: "igdrasil" });
  });

  it("rejects private fields and preserves an observed page-owned download count", () => {
    expect(() => parseLiveAcceptanceSnapshot({ ...preview(), route: "/private/billing" })).toThrow();
    expect(() => parseLiveAcceptanceSnapshot({ ...preview(), invoiceId: "INV-1" })).toThrow();
    expect(parseLiveAcceptanceSnapshot({
      ...envelope(),
      stage: "connected",
      selectedPlanKind: "semantic_dom",
      destinationKind: "filesystem",
      destinationToken: "a".repeat(24),
      run: {
        recordedAt: "2026-08-26T10:01:00.000Z",
        status: "ok",
        acceptedCount: 1,
        actionCount: 1,
        ledgerCount: 1,
        pageOwnedDownloadDelta: 1,
      },
    })).toMatchObject({ run: { pageOwnedDownloadDelta: 1 } });
  });
});

function envelope() {
  return {
    schema: "ratatosk.live-acceptance-snapshot.v1",
    runtime: { collectorVersion: "0.8.59", discoveryRevision: 49, acquisitionRevision: 5 },
    hostname: "app.example.com",
    capturedAt: "2026-08-26T10:00:00.000Z",
    sessionNonce: "1".repeat(32),
    vendorId: "discovered-example",
  };
}

function preview() {
  return {
    ...envelope(),
    stage: "preview",
    planCount: 2,
    planKinds: ["network", "semantic_dom"],
    invoiceClueCount: 4,
    baselineLedgerCount: 0,
  };
}
