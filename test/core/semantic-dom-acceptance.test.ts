import { describe, expect, it, vi } from "vitest";
import {
  SEMANTIC_DOM_ACCEPTANCE_SCHEMA,
  parseSemanticDomAcceptanceReceipt,
} from "../../scripts/validate-semantic-dom-acceptance";

describe("live acquisition release acceptance", () => {
  const artifactSha256 = "a".repeat(64);

  it("accepts only the exact runtime, artifact, three-family, destination-readback matrix", () => {
    vi.setSystemTime(new Date("2026-08-26T10:00:00.000Z"));
    expect(parseSemanticDomAcceptanceReceipt(receipt(), "0.8.53", 43, 3, artifactSha256)).toMatchObject({
      collectorVersion: "0.8.53",
      discoveryRevision: 43,
      acquisitionRevision: 3,
      artifactSha256,
      runtimeIdentityMatched: true,
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
    expect(() => parseSemanticDomAcceptanceReceipt(receipt(), "0.8.54", 43, 3, artifactSha256)).toThrow(/0\.8\.54/);
    expect(() => parseSemanticDomAcceptanceReceipt(receipt(), "0.8.53", 44, 3, artifactSha256)).toThrow(/discovery revision 44/);

    const anotherBuild = receipt();
    anotherBuild.artifactSha256 = "b".repeat(64);
    expect(() => parseSemanticDomAcceptanceReceipt(anotherBuild, "0.8.53", 43, 3, artifactSha256)).toThrow(/artifact SHA-256/);

    const missingFamily = receipt();
    missingFamily.cases[1] = { ...missingFamily.cases[0] };
    expect(() => parseSemanticDomAcceptanceReceipt(missingFamily, "0.8.53", 43, 3, artifactSha256)).toThrow(/server_rendered_documents/);

    const noIgdrasil = receipt();
    noIgdrasil.cases.forEach((entry) => { entry.destinationKind = "filesystem"; });
    expect(() => parseSemanticDomAcceptanceReceipt(noIgdrasil, "0.8.53", 43, 3, artifactSha256)).toThrow(/Igdrasil/);

    const repeated = receipt();
    repeated.cases[0].cadenceRunActionCount = 1 as never;
    expect(() => parseSemanticDomAcceptanceReceipt(repeated, "0.8.53", 43, 3, artifactSha256)).toThrow(/idempotent/);

    const wrongReadback = receipt();
    wrongReadback.cases[0].destinationReadbackCount = 0;
    expect(() => parseSemanticDomAcceptanceReceipt(wrongReadback, "0.8.53", 43, 3, artifactSha256)).toThrow(/idempotent/);

    const sensitive = receipt() as ReturnType<typeof receipt> & { cases: Array<Record<string, unknown>> };
    sensitive.cases[0].hostname = "supplier.example";
    expect(() => parseSemanticDomAcceptanceReceipt(sensitive, "0.8.53", 43, 3, artifactSha256)).toThrow(/unapproved/);
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
    collectorVersion: "0.8.53",
    discoveryRevision: 43,
    acquisitionRevision: 3,
    artifactSha256: "a".repeat(64),
    runtimeIdentityMatched: true as const,
    unrelatedUserDownloadSameUrlUntouched: true as const,
    completedAt: "2026-08-26T09:00:00.000Z",
    cases: [
      { ...common, family: "opaque_semantic_spa" as const, destinationKind: "filesystem" as "filesystem" | "igdrasil", firstRunActionCount: 1 },
      { ...common, family: "server_rendered_documents" as const, destinationKind: "filesystem" as "filesystem" | "igdrasil" },
      { ...common, family: "structured_api" as const, destinationKind: "igdrasil" as "filesystem" | "igdrasil" },
    ],
  };
}
