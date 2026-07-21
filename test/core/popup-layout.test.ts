import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popupSource = readFileSync("collector/src/ui/popup/popup.ts", "utf8");
const popupStyles = readFileSync("collector/src/ui/popup/popup.html", "utf8");
const collectorManifest = readFileSync("collector/manifest.config.ts", "utf8");
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

  it("uses an accessible icon-only Settings control and keeps auto-sync controls inside Settings", () => {
    expect(popupSource).toContain('class="settings-btn"');
    expect(popupSource).toContain('aria-label="Settings" title="Settings">${gearIcon()}</button>');
    expect(popupSource).not.toContain("${gearIcon()}<span>Settings</span>");
    expect(popupSource).not.toContain("Auto-Sync Off");
    expect(popupSource).not.toContain("let auto-sync handle the next run");
    expect(popupSource).not.toContain("next in <span");
    expect(popupStyles).toMatch(/\.settings-btn \{[^}]*min-height:\s*40px/s);
    expect(popupStyles).toMatch(/\.settings-btn \{[^}]*margin:\s*0 -4px 0 auto/s);
    expect(popupStyles).toMatch(/\.settings-btn \{[^}]*place-items:\s*center/s);
    expect(popupStyles).toMatch(/\.settings-btn svg \{[^}]*opacity:\s*0\.58/s);
    expect(popupSource).toContain('stroke-linecap="round" stroke-linejoin="round"');
  });

  it("groups invoice history by supplier with expandable rows and a date filter", () => {
    expect(popupSource).toContain('class="supplier-group"');
    expect(popupSource).toContain('class="date-filter"');
    expect(popupSource).toContain('name="ledger-range"');
    expect(popupSource).toContain("groupLedgerBySupplier");
    expect(popupStyles).toMatch(/\.supplier-group summary \{[^}]*min-height:\s*56px/s);
    expect(popupStyles).toMatch(/\.invoice-history \{[^}]*padding:\s*0 14px/s);
    expect(popupStyles).not.toContain("scrollbar-gutter: stable");
    expect(popupStyles).toContain('.supplier-group summary::marker { content: ""; }');
    expect(popupStyles).toMatch(/\.supplier-updated \{[^}]*text-align:\s*right/s);
    expect(popupSource).toContain('${esc(amount(entry.total, entry.currency))}');
  });

  it("uses a persistent side panel and preserves the actual sync error", () => {
    expect(collectorManifest).toContain('"sidePanel"');
    expect(collectorManifest).toContain("side_panel:");
    expect(collectorManifest).not.toContain("default_popup");
    expect(serviceWorkerSource).toContain("configureSidePanelAction");
    expect(popupStyles).toMatch(/body \{[^}]*min-height:\s*100vh/s);
    expect(popupSource).toContain("PANEL_UI_STATE_KEY");
    expect(popupSource).toContain("watchActiveSupplierTab");
    expect(popupSource).not.toContain("window.close()");
    expect(popupSource).toContain("connection.lastError");
  });

  it("offers one-time optional tab awareness instead of misreporting an HTTPS tab", () => {
    expect(popupSource).toContain("Find Invoices");
    expect(popupSource).not.toContain("Enable Tab Switching");
    expect(popupSource).toContain('data-action="enable-tab-awareness"');
    expect(popupSource).toContain("requestTabAwarenessPermission");
    expect(popupSource).toContain("hasTabAwarenessPermission");
    expect(popupSource).toContain("Chrome calls this permission");
    expect(popupSource).toContain('data-action="disable-tab-awareness"');
  });

  it("offers connected vendors a permission-drift reconnect action", () => {
    expect(popupSource).toContain("source.missingHosts.length");
    expect(popupSource).toContain("Review Access");
  });

  it("preserves delivered history on disconnect and exposes a separate destructive reset", () => {
    const disconnectCase = serviceWorkerSource.match(/case "disconnect":[\s\S]*?case "forgetVendorHistory":/)?.[0] ?? "";
    expect(disconnectCase).toContain("collectionRuns.runInteractive");
    expect(disconnectCase).not.toContain("clearSeenForSource");
    expect(disconnectCase).not.toContain("clearLedgerForVendor");
    expect(serviceWorkerSource).toContain('case "forgetVendorHistory":');
    expect(popupSource).toContain('data-action="forget-history"');
    expect(popupStyles).toContain("Existing files are not deleted");
  });

  it("reports all-supplier sync coverage instead of the newest vendor attempt", () => {
    expect(popupSource).toContain("lastCompleteSyncAt");
    expect(popupSource).toContain("Math.min(...completeSyncs)");
    expect(popupSource).toContain("all synced");
    expect(popupSource).toContain("Need Attention");
  });

  it("revokes permission origins belonging only to losing discovery candidates", () => {
    expect(serviceWorkerSource).toMatch(
      /if \(result\.kind === "success"\)[\s\S]{0,900}await revokeUnusedPermissions\(requiredOrigins\)/,
    );
  });

  it("identifies the exact collector and discovery engine on load and every search", () => {
    expect(serviceWorkerSource).toContain("[collector] ready ${formatCollectorRuntimeIdentity()}");
    expect(serviceWorkerSource).toContain("[collector] discovery start ${formatCollectorRuntimeIdentity()}");
  });

  it("offers local discovery with a reviewed-recipe fallback", () => {
    expect(popupSource).toContain("Supplier not listed?");
    expect(popupSource).toContain("Find Invoices");
    expect(popupSource).toContain("Copy Diagnostic");
    expect(popupSource).toContain("Connect &amp; Collect");
    expect(popupSource).toContain("Build a reviewed recipe instead");
    expect(popupSource).toContain("https://github.com/Igdrasil-AB/ratatosk#download-studio-to-add-a-new-supplier");
    expect(popupSource).toContain('data-action="open-add-supplier"');
    expect(popupSource).toContain("Found a possible invoice source");
    expect(popupSource).not.toContain("possible invoice${");
    expect(popupStyles).toMatch(/\.supplier-request-link \{[^}]*min-height:\s*40px/s);
    expect(popupStyles).toContain("prefers-reduced-motion: reduce");
  });
});
