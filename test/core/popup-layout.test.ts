import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popupSource = readFileSync("collector/src/ui/popup/popup.ts", "utf8");
const popupStyles = readFileSync("collector/src/ui/popup/popup.html", "utf8");
const collectorManifest = readFileSync("collector/manifest.config.ts", "utf8");
const serviceWorkerSource = readFileSync("collector/src/platform/service-worker.ts", "utf8");

describe("Collector popup layout regressions", () => {
  it("keeps a stable two-slot vendor action grid in every connection state", () => {
    expect(popupStyles).toMatch(/\.vrow \.actions \{[^}]*grid-template-columns:\s*96px 34px/s);
    expect(popupSource).toContain('class="action-spacer"');
  });

  it("uses the rustic editorial home treatment without a large document glyph", () => {
    expect(popupSource).toContain('class="home-editorial"');
    expect(popupSource).toContain('class="setup-ledger"');
    expect(popupSource).not.toContain('<span class="m">${docIcon()}</span>');
    // The screen states its promise once. A kicker, a headline and a paragraph
    // all introducing the same two-step setup is three ways of saying it.
    expect(popupSource).not.toContain('class="home-kicker"');
    expect(popupSource).not.toContain('class="home-copy"');
  });

  it("gives every screen exactly one full-width primary action", () => {
    // Setup, the connected empty state, and the ledger each end in one `btn lg`;
    // everything else on those screens is tonal, ghost, or a quiet link.
    expect(popupSource.match(/class="btn lg"/g)).toHaveLength(3);
    expect(popupStyles).toMatch(/\.btn\.lg \{[^}]*width:\s*100%/s);
    expect(popupStyles).toMatch(/\.btn\.lg \{[^}]*min-height:\s*48px/s);
    // The recurring collect action is a button in its own bar, not a caption.
    expect(popupSource).toContain('class="action-bar"');
    expect(popupSource).not.toContain('class="quiet-link compact" data-action="sync-all"');
    // Every compact control still clears a 40px target through its extender.
    expect(popupStyles).toMatch(/\.quiet-link\.compact::after \{[^}]*inset:\s*-4px 0/s);
    expect(popupStyles).toMatch(/\.date-filter-option \{[^}]*min-height:\s*40px/s);
    expect(popupStyles).toMatch(/\.vendor-menu-items button \{[^}]*min-height:\s*40px/s);
  });

  it("reads the two home facts as the shortcuts to the screens that change them", () => {
    expect(popupSource).toContain('class="fact" data-action="open-vendors"');
    expect(popupSource).toContain('class="fact" data-action="open-settings"');
  });

  it("offers the flagship search from the first screen while a matching tab is open", () => {
    expect(popupSource).toContain("function discoverableTab()");
    expect(popupSource).toContain('data-action="discover-here"');
    expect(popupSource).toContain("Find invoices on ${esc(page.hostname)}");
    // The search reports on the vendors screen, so the click moves there first.
    expect(popupSource).toMatch(/action === "discover-here"[\s\S]{0,320}screen = "vendors"[\s\S]{0,200}discoverFromUserGesture\(\)/);
  });

  it("keeps surfaces flat and layering on one declared scale", () => {
    expect(popupStyles).not.toContain("linear-gradient");
    expect(popupStyles).not.toMatch(/z-index:\s*\d/);
    expect(popupStyles).toMatch(/--z-menu:\s*20/);
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
    expect(popupSource).toContain('class="date-filter-options"');
    expect(popupSource).toContain('data-action="set-ledger-range"');
    expect(popupSource).not.toContain('name="ledger-range"');
    expect(popupSource).toContain("groupLedgerBySupplier");
    expect(popupStyles).toMatch(/\.supplier-group summary \{[^}]*min-height:\s*56px/s);
    expect(popupStyles).toMatch(/\.invoice-history \{[^}]*padding:\s*0 14px/s);
    expect(popupStyles).not.toContain("scrollbar-gutter: stable");
    expect(popupStyles).toContain('.supplier-group summary::marker { content: ""; }');
    expect(popupStyles).toMatch(/\.supplier-updated \{[^}]*text-align:\s*right/s);
    expect(popupSource).toContain("amount(entry.total, entry.currency)");
    expect(popupStyles).toMatch(/\.date-filter-options \{[^}]*right:\s*0/s);
  });

  it("keeps vendor utility actions readable in the narrow side panel", () => {
    expect(popupStyles).toContain(".vendor-menu-items");
    expect(popupSource).toContain('class="vendor-menu"');
    expect(popupStyles).toMatch(/\.vrow \.vs \{[^}]*white-space:\s*normal/s);
    expect(popupSource).toContain("skipped");
  });

  it("keeps bundled pilot governance metadata out of the customer-facing rows", () => {
    expect(popupSource).toContain('source.lifecycle?.stage === "pilot"');
    expect(popupStyles).toMatch(/\.vrow \.vn \+ \.vs \{[^}]*margin-top:\s*3px/s);
  });

  it("does not show implementation-detail tab switching copy below the vendor list", () => {
    expect(popupSource).not.toContain("Chrome may briefly hide this window");
    expect(popupSource).not.toContain("Setup continues safely in the background");
  });

  it("uses a persistent side panel and preserves the actual sync error", () => {
    expect(collectorManifest).toContain('"sidePanel"');
    expect(collectorManifest).toContain("side_panel:");
    expect(collectorManifest).not.toContain("default_popup");
    expect(serviceWorkerSource).toContain("configureSidePanelAction");
    expect(popupStyles).toMatch(/body \{[^}]*min-height:\s*100dvh/s);
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
    expect(popupSource).toContain('data-action="open-attention"');
    expect(popupSource).toContain("sourceNeedsAttention");
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
    expect(popupSource).toContain("Copy details");
    expect(popupSource).toContain("Connect &amp; Collect");
    expect(popupSource).not.toContain("Studio on GitHub");
    expect(popupSource).not.toContain("Build a reviewed recipe instead");
    expect(popupSource).not.toContain('data-action="open-add-supplier"');
    expect(popupSource).toContain("Invoice source found");
    expect(popupSource).toContain("No invoices found");
    expect(popupSource).not.toContain("possible invoice${");
    expect(popupStyles).toMatch(/\.supplier-request-link \{[^}]*min-height:\s*40px/s);
    expect(popupStyles).toMatch(/\.tab-awareness \.discovery-actions \{[^}]*grid-column:\s*2/s);
    expect(popupStyles).toMatch(/\.tab-awareness \.discovery-actions \{[^}]*flex-direction:\s*row/s);
    expect(popupStyles).toContain("prefers-reduced-motion: reduce");
    expect(popupSource).toContain('data-action="retry-discovery"');
    expect(popupSource).toContain("may not include billing access");
  });

  it("keeps invoice metadata truthful and collection controls available with history", () => {
    expect(popupSource).toContain("entry.invoiceNumber");
    expect(popupSource).toContain("entry.filename");
    expect(popupSource).toContain('aria-label="Invoice date unavailable"');
    expect(popupSource).toContain('aria-label="Invoice amount unavailable"');
    expect(popupSource).toContain('data-action="sync-all">Collect All');
  });

  it("asks for an optional starting month before manual collection", () => {
    expect(popupStyles).toContain('id="sync-dialog"');
    expect(popupStyles).toContain('id="sync-from-month" type="month" min="1970-01"');
    expect(popupStyles).toContain("Leave empty to check all available history");
    expect(popupSource).toContain('openSyncDialog({ kind: "connected", vendorId: vendorId! })');
    expect(popupSource).toContain('openSyncDialog({ kind: "connected" })');
    expect(popupSource).toContain('openSyncDialog({ kind: "discovery", vendorId })');
    expect(popupSource).toContain("...(fromMonth ? { fromMonth } : {})");
    expect(serviceWorkerSource).toContain("isSyncMonth(message.fromMonth)");
    expect(serviceWorkerSource).toContain("beginSupplierDiscoveryConnect(message.vendorId, message.fromMonth)");
    expect(serviceWorkerSource).toContain("}, pending.fromMonth)");
    expect(serviceWorkerSource).toContain("DISCOVERY_FAILURE_MESSAGES.monthRangeEmpty");
    expect(popupSource).toContain('connection.lastCode === "month_range_fallback_all"');
    expect(popupSource).toContain("used all history");
    expect(popupStyles).toContain("Ratatosk will collect all history and tell you when it finishes");
    // The fallback stays disclosed on the completion card, in one short clause
    // rather than a sentence that doubles the card's height.
    expect(popupSource).toContain("discovery.monthFallbackAll");
    expect(popupSource).toContain("All history checked, no invoice dates.");
  });

  it("closes the date menu with Escape or an outside click and clears stale toast text", () => {
    expect(popupSource).toContain("closeDateFilter(true)");
    expect(popupSource).toContain('document.addEventListener("pointerdown"');
    expect(popupSource).toContain('toastEl.textContent = ""');
  });

  it("shows the next scheduled run and uses the listed supplier's real action", () => {
    expect(popupSource).toContain("Next check ${relTime(state.schedule.nextRunAt)}");
    expect(popupSource).toContain('${connected ? "Sync Now" : "Connect"}');
  });
});
