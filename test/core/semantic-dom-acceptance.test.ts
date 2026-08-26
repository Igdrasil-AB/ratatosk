import { describe, expect, it, vi } from "vitest";
import {
  SEMANTIC_DOM_ACCEPTANCE_SCHEMA,
  parseSemanticDomAcceptanceReceipt,
} from "../../scripts/validate-semantic-dom-acceptance";

describe("live acquisition release acceptance", () => {
  const artifactSha256 = "a".repeat(64);

  it("accepts only the exact runtime, artifact, three-family, destination-readback matrix", () => {
    vi.setSystemTime(new Date("2026-08-26T10:00:00.000Z"));
    expect(parseSemanticDomAcceptanceReceipt(receipt(), "0.8.55", 45, 4, artifactSha256)).toMatchObject({
      collectorVersion: "0.8.55",
      discoveryRevision: 45,
      acquisitionRevision: 4,
      artifactSha256,
      runtimeIdentityMatched: true,
      clickupAccepted: true,
      cases: expect.arrayContaining([
        expect.objectContaining({ family: "opaque_semantic_spa" }),
        expect.objectContaining({ family: "server_rendered_documents" }),
        expect.objectContaining({ family: "structured_api", destinationKind: "igdrasil" }),
      ]),
    });
    vi.useRealTimers();
  });

  it("rejects stale identities, incomplete breadth, duplicate effects, and private fields", () => {
    vi.setSystemTime(new Date("2026-08-26T10:00:00.000Z"));
    expect(() => parseSemanticDomAcceptanceReceipt(receipt(), "0.8.56", 45, 4, artifactSha256)).toThrow(/0\.8\.56/);
    expect(() => parseSemanticDomAcceptanceReceipt(receipt(), "0.8.55", 46, 4, artifactSha256)).toThrow(/discovery revision 46/);

    const anotherBuild = receipt();
    anotherBuild.artifactSha256 = "b".repeat(64);
    expect(() => parseSemanticDomAcceptanceReceipt(anotherBuild, "0.8.55", 45, 4, artifactSha256)).toThrow(/artifact SHA-256/);

    const missingFamily = receipt();
    missingFamily.cases[1].family = "opaque_semantic_spa" as never;
    expect(() => parseSemanticDomAcceptanceReceipt(missingFamily, "0.8.55", 45, 4, artifactSha256)).toThrow(/server_rendered_documents/);

    const noIgdrasil = receipt();
    noIgdrasil.cases.forEach((entry) => { entry.destinationKind = "filesystem"; });
    expect(() => parseSemanticDomAcceptanceReceipt(noIgdrasil, "0.8.55", 45, 4, artifactSha256)).toThrow(/Igdrasil/);

    const noClickUp = receipt();
    noClickUp.clickupAccepted = false as never;
    expect(() => parseSemanticDomAcceptanceReceipt(noClickUp, "0.8.55", 45, 4, artifactSha256)).toThrow(/ClickUp/);

    const repeated = receipt();
    repeated.cases[0].cadenceRunActionCount = 1 as never;
    expect(() => parseSemanticDomAcceptanceReceipt(repeated, "0.8.55", 45, 4, artifactSha256)).toThrow(/idempotent/);

    const pageDownload = receipt();
    pageDownload.cases[0].pageOwnedDownloadDelta = 1 as never;
    expect(() => parseSemanticDomAcceptanceReceipt(pageDownload, "0.8.55", 45, 4, artifactSha256)).toThrow(/idempotent/);

    const wrongReadback = receipt();
    wrongReadback.cases[0].destinationReadbackCount = 0;
    expect(() => parseSemanticDomAcceptanceReceipt(wrongReadback, "0.8.55", 45, 4, artifactSha256)).toThrow(/idempotent/);

    const sensitive = receipt() as ReturnType<typeof receipt> & { cases: Array<Record<string, unknown>> };
    sensitive.cases[0].hostname = "supplier.example";
    expect(() => parseSemanticDomAcceptanceReceipt(sensitive, "0.8.55", 45, 4, artifactSha256)).toThrow(/unapproved/);
    vi.useRealTimers();
  });
});

function receipt() {
  const common = {
    firstRunAcceptedCount: 1,
    firstRunActionCount: 0,
    firstRunLedgerDelta: 1,
    destinationReadbackCount: 1,
    immediateRunAcceptedCount: 0 as const,
    immediateRunActionCount: 0 as const,
    immediateRunLedgerDelta: 0 as const,
    cadenceRunAcceptedCount: 0 as const,
    cadenceRunActionCount: 0 as const,
    cadenceRunLedgerDelta: 0 as const,
    pageOwnedDownloadDelta: 0 as const,
    closedOutcome: "collected" as const,
    pass: true as const,
  };
  return {
    schema: SEMANTIC_DOM_ACCEPTANCE_SCHEMA,
    collectorVersion: "0.8.55",
    discoveryRevision: 45,
    acquisitionRevision: 4,
    artifactSha256: "a".repeat(64),
    runtimeIdentityMatched: true as const,
    clickupAccepted: true as const,
    completedAt: "2026-08-26T09:00:00.000Z",
    cases: [
      { ...common, supplierToken: "a".repeat(24), family: "opaque_semantic_spa" as const, planCount: 1, planKinds: ["semantic_dom" as const], selectedPlanKind: "semantic_dom" as const, destinationKind: "filesystem" as "filesystem" | "igdrasil", destinationToken: "1".repeat(24), firstRunActionCount: 1 },
      { ...common, supplierToken: "b".repeat(24), family: "server_rendered_documents" as const, planCount: 1, planKinds: ["exact_dom" as const], selectedPlanKind: "exact_dom" as const, destinationKind: "filesystem" as "filesystem" | "igdrasil", destinationToken: "1".repeat(24) },
      { ...common, supplierToken: "c".repeat(24), family: "structured_api" as const, planCount: 1, planKinds: ["network" as const], selectedPlanKind: "network" as const, destinationKind: "igdrasil" as "filesystem" | "igdrasil", destinationToken: "2".repeat(24) },
    ],
  };
}
