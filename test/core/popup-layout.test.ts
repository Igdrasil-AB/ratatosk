import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popupSource = readFileSync("collector/src/ui/popup/popup.ts", "utf8");
const popupStyles = readFileSync("collector/src/ui/popup/popup.html", "utf8");
const serviceWorkerSource = readFileSync("collector/src/platform/service-worker.ts", "utf8");

describe("Collector popup layout regressions", () => {
  it("keeps a stable two-slot vendor action grid in every connection state", () => {
    expect(popupStyles).toMatch(/\.vrow \.actions \{[^}]*grid-template-columns:\s*86px 32px/s);
    expect(popupSource).toContain('class="action-spacer"');
  });

  it("uses the rustic editorial home treatment without a large document glyph", () => {
    expect(popupSource).toContain('class="home-kicker"');
    expect(popupSource).not.toContain('<span class="m">${docIcon()}</span>');
  });

  it("opens the connected empty state directly on collection actions", () => {
    expect(popupSource).not.toContain("Collector · Ready");
    expect(popupSource).not.toContain("Ready when you are.");
    expect(popupSource).not.toContain("Check for new invoices whenever you’re ready.");
    expect(popupSource).toContain('aria-label="Invoice collection"');
    expect(popupStyles).toMatch(/\.home-editorial > \.home-actions:first-child \{[^}]*margin-top:\s*0/s);
  });

  it("labels the home Settings control and keeps auto-sync controls inside Settings", () => {
    expect(popupSource).toContain('class="settings-btn"');
    expect(popupSource).toContain("${gearIcon()}<span>Settings</span>");
    expect(popupSource).not.toContain("Auto-Sync Off");
    expect(popupSource).not.toContain("let auto-sync handle the next run");
    expect(popupSource).not.toContain("next in <span");
    expect(popupStyles).toMatch(/\.settings-btn \{[^}]*min-height:\s*40px/s);
  });

  it("restores the popup after permission handoff and preserves the actual sync error", () => {
    expect(serviceWorkerSource).toContain("revealPopupAfterConnect");
    expect(popupSource).toContain("connection.lastError");
    expect(popupSource).toContain("clearConnectBadge");
  });
});
