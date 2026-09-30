import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCollectorDiagnostic } from "../../collector/src/platform/diagnostics";
import { parseDiscoveryDiagnostic } from "../../collector/src/platform/discovery-diagnostic";

const collection = JSON.parse(readFileSync(new URL("../fixtures/ratatosk/feedback-collection.json", import.meta.url), "utf8"));
const discovery = JSON.parse(readFileSync(new URL("../fixtures/ratatosk/feedback-discovery.json", import.meta.url), "utf8"));

describe("shared Ratatosk feedback fixtures", () => {
  it("uses an exact current discovery diagnostic", () => {
    expect(parseDiscoveryDiagnostic(discovery.diagnostic)).toEqual(discovery.diagnostic);
  });

  it("uses the Collector's allowlisted last-run diagnostic", () => {
    const expected = collection.diagnostic;
    const actual = buildCollectorDiagnostic({
      vendorId: expected.vendorId,
      collectorVersion: expected.collectorVersion,
      lifecycleRevision: expected.lifecycleRevision,
      runtime: expected.runtime,
      connection: {
        vendorId: expected.vendorId, connectedAt: 1,
        lastRunAt: Date.parse(expected.recordedAt),
        lastCode: expected.outcomeCode,
        lastCount: expected.counts.collected,
        lastDocumentActionCount: expected.counts.documentActions,
        lastFailedScopes: expected.counts.failedScopes,
        lastEmptyScopes: expected.counts.emptyScopes,
        lastRunEvidence: expected.lastRunEvidence,
      },
    });
    expect(actual).toEqual(expected);
  });
});
