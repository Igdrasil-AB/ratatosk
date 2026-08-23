import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoveryProofIsSufficient } from "../../collector/src/platform/discovery";
import { EXPLORATION_BUDGETS, explorationProbeOptions } from "../../collector/src/platform/discovery-explorer";
import { DEFAULT_SAFE_CONCURRENCY } from "../../src/core/concurrency";

const worker = readFileSync("collector/src/platform/service-worker.ts", "utf8");

const candidate = (id: "network-json" | "embedded-json" | "dom-links" | "dom-actions") =>
  ({ profile: { adapter: { id } } });

describe("interactive discovery envelope", () => {
  it("bounds a person's Find Invoices wait to ten seconds", () => {
    expect(EXPLORATION_BUDGETS.fast.durationMs).toBeLessThanOrEqual(10_000);
    // The whole page budget has to fit in a handful of concurrent waves, or the
    // ceiling would be reached by exploring a fraction of the frontier.
    const waves = Math.ceil(EXPLORATION_BUDGETS.fast.pages / DEFAULT_SAFE_CONCURRENCY.routeProbes);
    expect(waves).toBeLessThanOrEqual(4);
  });

  it("keeps a user-initiated scan in the interactive envelope until the person explicitly continues", () => {
    expect(worker).toContain('pending.checkpoint?.mode ?? "fast"');
    expect(worker).toContain('case "continueDiscovery"');
    expect(worker).toContain("continueSupplierDiscovery()");
    expect(worker).not.toContain('scan("deep", undefined)');
    expect(worker).not.toContain("fast discovery found no candidate; escalating");
    expect(worker).not.toContain('pending.checkpoint?.mode ?? "deep"');
    expect(worker).toContain("!failed.canSearchDeeper");
    expect(worker).toContain('error.diagnostic.result === "not_found"');
  });

  it("stops the moment a previewed structured plan exists", () => {
    const progress = { entryExplored: false, exploredWaves: 0 };
    expect(discoveryProofIsSufficient([candidate("network-json")], progress)).toBe(true);
    expect(discoveryProofIsSufficient([candidate("embedded-json")], progress)).toBe(true);
  });

  it("settles for rendered document links once the entry page and its replay are read", () => {
    expect(discoveryProofIsSufficient([candidate("dom-links")], { entryExplored: false, exploredWaves: 0 })).toBe(false);
    expect(discoveryProofIsSufficient([candidate("dom-links")], { entryExplored: true, exploredWaves: 0 })).toBe(true);
  });

  it("keeps exploring for a structured source when only an action guess exists", () => {
    expect(discoveryProofIsSufficient([candidate("dom-actions")], { entryExplored: true, exploredWaves: 0 })).toBe(false);
    expect(discoveryProofIsSufficient([candidate("dom-actions")], { entryExplored: true, exploredWaves: 1 })).toBe(true);
    expect(discoveryProofIsSufficient([], { entryExplored: true, exploredWaves: 3 })).toBe(false);
  });

  it("funds observed routes by provenance and keeps generic guesses cheap", () => {
    const observed = { url: "https://vendor.example/surface/r7", source: "linked" as const, hintSource: "semantic_navigation" as const, depth: 1, score: 100 };
    const fallback = { url: "https://vendor.example/account/billing", source: "common_route" as const, hintSource: "common_fallback" as const, depth: 1, score: 100 };

    expect(explorationProbeOptions(observed).settleMs).toBeGreaterThan(explorationProbeOptions(fallback).settleMs);
    expect(explorationProbeOptions(observed).deadlineMs).toBeGreaterThan(explorationProbeOptions(fallback).deadlineMs);
  });

  it("makes the escalation more patient per route, not only wider", () => {
    const target = { url: "https://vendor.example/surface/r7", source: "linked" as const, hintSource: "semantic_navigation" as const, depth: 1, score: 100 };

    // A second pass that re-probes the same page with the same render window
    // would just reach the same conclusion more slowly.
    expect(explorationProbeOptions(target, "deep").settleMs)
      .toBeGreaterThan(explorationProbeOptions(target, "fast").settleMs);
    expect(EXPLORATION_BUDGETS.deep.pages).toBeGreaterThan(EXPLORATION_BUDGETS.fast.pages);
  });
});
