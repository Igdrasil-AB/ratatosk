import { describe, expect, it, vi } from "vitest";
import {
  SEMANTIC_DOM_ACCEPTANCE_SCHEMA,
  parseSemanticDomAcceptanceReceipt,
} from "../../scripts/validate-semantic-dom-acceptance";

describe("semantic DOM release acceptance", () => {
  it("accepts only the exact-version, browser-file-free two-run and cadence matrix", () => {
    vi.setSystemTime(new Date("2026-07-27T10:00:00.000Z"));
    expect(parseSemanticDomAcceptanceReceipt(receipt(), "0.8.48", 1)).toMatchObject({
      collectorVersion: "0.8.48",
      acquisitionRevision: 1,
      cases: expect.arrayContaining([
        expect.objectContaining({ siteClass: "supabase", closedOutcome: "collected" }),
      ]),
    });
    vi.useRealTimers();
  });

  it("rejects stale versions, page-owned files, repeat actions, and private fields", () => {
    vi.setSystemTime(new Date("2026-07-27T10:00:00.000Z"));
    expect(() => parseSemanticDomAcceptanceReceipt(receipt(), "0.8.49", 1)).toThrow(/0\.8\.49/);

    const browserFile = receipt();
    browserFile.cases[0].pageOwnedDownloadDelta = 1;
    expect(() => parseSemanticDomAcceptanceReceipt(browserFile, "0.8.48", 1)).toThrow(/browser-file-free/);

    const repeated = receipt();
    repeated.cases[0].secondRunActionCount = 1;
    expect(() => parseSemanticDomAcceptanceReceipt(repeated, "0.8.48", 1)).toThrow(/idempotent/);

    const sensitive = receipt() as ReturnType<typeof receipt> & { cases: Array<Record<string, unknown>> };
    sensitive.cases[0].url = "https://supplier.example/private";
    expect(() => parseSemanticDomAcceptanceReceipt(sensitive, "0.8.48", 1)).toThrow(/unapproved field/);
    vi.useRealTimers();
  });
});

function receipt() {
  const common = {
    secondRunActionCount: 0,
    secondRunAcceptedCount: 0,
    cadenceRunActionCount: 0,
    cadenceRunAcceptedCount: 0,
    pageOwnedDownloadDelta: 0,
    pass: true as const,
  };
  return {
    schema: SEMANTIC_DOM_ACCEPTANCE_SCHEMA,
    collectorVersion: "0.8.48",
    acquisitionRevision: 1,
    completedAt: "2026-07-27T09:00:00.000Z",
    cases: [
      { ...common, siteClass: "supabase", destinationKind: "filesystem", firstRunAcceptedCount: 1, closedOutcome: "collected" },
      { ...common, siteClass: "additional-semantic-supplier", destinationKind: "filesystem", firstRunAcceptedCount: 1, closedOutcome: "collected" },
      { ...common, siteClass: "additional-semantic-supplier", destinationKind: "igdrasil", firstRunAcceptedCount: 1, closedOutcome: "collected" },
      { ...common, siteClass: "synthetic-local-native-download", destinationKind: "filesystem", firstRunAcceptedCount: 0, closedOutcome: "browser_download_unsupported" },
      { ...common, siteClass: "synthetic-local-native-download", destinationKind: "igdrasil", firstRunAcceptedCount: 0, closedOutcome: "browser_download_unsupported" },
    ],
  };
}
