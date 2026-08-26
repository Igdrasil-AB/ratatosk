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

  it("retires a failed search when the person switches vendors", () => {
    expect(state).toContain('...(state.origin ? { origin: state.origin } : {})');
    expect(popup).toContain('data-action="dismiss-discovery"');
    expect(popup).toContain("state.discovery.origin !== page.origin");
    expect(popup).toContain('send({ type: "dismissDiscovery" })');
    expect(popup).toContain('data-action="dismiss-discovery">Dismiss');
    expect(popup).not.toContain("Check This Vendor Instead");
  });

  it("never presents a partial collection as no new invoices", () => {
    expect(popup).toContain("Collection incomplete — some invoices may still be missing");
    expect(popup).toContain('connection.lastStatus === "partial" ? "Retry" : "Collect"');
  });

  it("makes repeated discovery clicks idempotent", () => {
    expect(popup).toContain('if (state.discovery.stage === "scanning" || state.discovery.stage === "connecting") return;');
  });
});
