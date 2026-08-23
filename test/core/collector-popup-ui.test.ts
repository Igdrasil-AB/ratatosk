import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popup = readFileSync("collector/src/ui/popup/popup.ts", "utf8");
const state = readFileSync("collector/src/platform/discovery-state.ts", "utf8");
const messaging = readFileSync("collector/src/platform/messaging.ts", "utf8");

describe("discovery search-limit UI", () => {
  it("offers one explicit deeper-search action with its remaining time", () => {
    expect(popup).toContain('data-action="continue-discovery"');
    expect(popup).toContain("Search Deeper");
    expect(popup).toContain("Up to ${Math.ceil((discovery.deepRemainingMs ?? 0) / 1_000)} more seconds");
    expect(popup).toContain("canSearchDeeper");
  });

  it("keeps the continuation scoped to a validated capped fast run", () => {
    expect(state).toContain("continueExplorationCheckpoint(state.checkpoint)");
    expect(state).toContain('state.diagnostic?.result !== "limit_reached"');
    expect(messaging).toContain('{ type: "continueDiscovery" }');
  });

  it("gives an exhausted evidence frontier one clear guided fallback", () => {
    expect(popup).toContain("Open the supplier's billing or invoice page, then search again.");
    expect(popup).toContain("Open Billing Page &amp; Search Again");
  });
});
