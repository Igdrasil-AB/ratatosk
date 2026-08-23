import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createInitialExplorationTargets } from "../../collector/src/platform/discovery";

const discoverySource = readFileSync("collector/src/platform/discovery.ts", "utf8");

describe("exact-entry cold replay", () => {
  it("plans an active snapshot followed by one disposable replay of the exact entry", () => {
    const entryUrl = "https://vendor.example/dashboard/org/opaqueorganization/billing";

    expect(createInitialExplorationTargets(entryUrl, true)).toEqual([
      {
        url: entryUrl,
        depth: 0,
        source: "entry",
        family: "exact_entry",
        hintSource: "active_entry",
        score: Number.MAX_SAFE_INTEGER,
      },
      {
        url: entryUrl,
        depth: 0,
        source: "entry_replay",
        family: "exact_entry",
        hintSource: "cold_replay",
        score: Number.MAX_SAFE_INTEGER - 1,
      },
    ]);
  });

  it("does not claim an observed replay when early observer registration failed", () => {
    expect(createInitialExplorationTargets("https://vendor.example/billing", false))
      .toHaveLength(1);
  });

  it("registers the observer before creating the replay plan and never navigates the active tab", () => {
    const observerStart = discoverySource.indexOf("await pageObserver.start()");
    const replayPlan = discoverySource.indexOf("createInitialExplorationTargets(firstUrl, observerReady, remembered)");

    expect(observerStart).toBeGreaterThan(0);
    expect(replayPlan).toBeGreaterThan(observerStart);
    expect(discoverySource).toContain('target.source === "entry_replay"');
    expect(discoverySource).not.toMatch(/chrome\.tabs\.update\(tabId,\s*\{/);
    expect(discoverySource).toContain('allowSemanticNavigation: target.source !== "entry"');
    expect(discoverySource).toContain('allowScroll: target.source !== "entry"');
    expect(discoverySource).toContain('if (topLevelFrame && options.allowSemanticNavigation !== false) {');
    expect(discoverySource).toContain('await withDiscoveryMutationGuard(async () => {');
    expect(discoverySource).toContain('await revealSemanticNavigation()');
    expect(discoverySource).toContain('topLevelFrame && options.allowScroll !== false && !usefulEvidencePresent()');
  });

  it("waits for observer quiescence independently of embedded hydration data", () => {
    expect(discoverySource).toContain("waitForObservedEvidenceQuiescence");
    expect(discoverySource).not.toMatch(
      /document\.querySelector\('script\[type="application\/json"\][\s\S]{0,160}?finish\(\)/,
    );
  });
});
