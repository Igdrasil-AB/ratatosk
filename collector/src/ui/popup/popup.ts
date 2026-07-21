/**
 * Ratatosk Collector side panel. Framework-free and intentionally small: state
 * comes from the service worker and each screen renders semantic native controls.
 */
import { send, type DiscoveryStatusView, type ScheduleInfo, type SourceView } from "../../platform/messaging";
import type { LedgerEntry } from "../../platform/storage";
import { vendorLifecycleLabel } from "../../../../src/vendors/lifecycle";
import {
  hasTabAwarenessPermission,
  requestHostPermissions,
  requestTabAwarenessPermission,
  revokeTabAwarenessPermission,
} from "../../platform/permissions";
import { brandIcon } from "../../../../src/vendors/icons";
import { filterLedgerByDate, groupLedgerBySupplier, type LedgerDateFilter } from "./ledger-view";
import { PANEL_UI_STATE_KEY, parsePanelUiState, type PanelScreen } from "./panel-state";
import {
  queryActiveSupplierTab,
  watchActiveSupplierTab,
  type ActiveSupplierTab,
} from "./active-supplier-tab";
import { parseConfigResponse, parseInitialBackgroundState, PopupLoadError } from "./load-state";

type InlineError = { scope: "vendor"; vendorId: string; message: string } | { scope: "settings"; message: string };

const app = document.getElementById("app") as HTMLElement;
const toastEl = document.getElementById("toast") as HTMLElement;
const disconnectDialog = document.getElementById("disconnect-dialog") as HTMLDialogElement;
const disconnectName = document.getElementById("disconnect-name") as HTMLElement;
const confirmDisconnect = document.getElementById("confirm-disconnect") as HTMLButtonElement;
const cancelDisconnect = document.getElementById("cancel-disconnect") as HTMLButtonElement;
const historyDialog = document.getElementById("history-dialog") as HTMLDialogElement;
const historyName = document.getElementById("history-name") as HTMLElement;
const confirmHistory = document.getElementById("confirm-history") as HTMLButtonElement;
const cancelHistory = document.getElementById("cancel-history") as HTMLButtonElement;
const VENDOR_GUIDANCE_SEEN = "ui.vendorGuidanceSeen.v1";
const ADD_SUPPLIER_URL = "https://github.com/Igdrasil-AB/ratatosk#download-studio-to-add-a-new-supplier";

let screen: PanelScreen = "home";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let disconnectVendorId: string | null = null;
let historyVendorId: string | null = null;
let hasLoadedBackgroundState = false;
const expandedSupplierIds = new Set<string>();
const state = {
  sources: [] as SourceView[],
  ledger: [] as LedgerEntry[],
  config: null as Awaited<ReturnType<typeof getConfig>>,
  schedule: { periodMinutes: null, nextRunAt: null } as ScheduleInfo,
  vendorGuidanceSeen: false,
  forceGuidance: false,
  busyVendorId: null as string | null,
  inlineError: null as InlineError | null,
  discovery: { stage: "idle" } as DiscoveryStatusView,
  activeSupplierTab: null as ActiveSupplierTab | null,
  tabAwarenessEnabled: false,
  tabAwarenessRequestPending: false,
  ledgerDateFilter: "all" as LedgerDateFilter,
};

// ---- helpers --------------------------------------------------------------

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] as string);
}

function logo(icon: string | undefined, name: string): string {
  const brand = brandIcon(icon);
  if (brand) return `<span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="${brand.path}"/></svg></span>`;
  return `<span class="logo letter" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>`;
}

function relTime(timestamp?: number | null): string {
  if (!timestamp) return "never";
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function amount(total?: string, currency?: string): string {
  if (!total) return "";
  const numericTotal = Number(total);
  const code = currency?.toUpperCase();
  if (!Number.isFinite(numericTotal)) return code ? `${total} ${code}` : total;
  if (!code) return new Intl.NumberFormat().format(numericTotal);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(numericTotal);
  } catch {
    return `${new Intl.NumberFormat().format(numericTotal)} ${code}`;
  }
}

function invoiceDate(entry: LedgerEntry): string {
  if (entry.issuedAt && /^\d{4}-\d{2}-\d{2}/.test(entry.issuedAt)) {
    const date = new Date(`${entry.issuedAt.slice(0, 10)}T00:00:00`);
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }
  return relTime(entry.collectedAt);
}

function categoryLabel(category?: string): string {
  if (category === "ai") return "AI service";
  if (category === "hosting") return "Hosting";
  if (!category) return "Billing service";
  return category.charAt(0).toUpperCase() + category.slice(1);
}

const getConfig = () => send({ type: "getConfig" }).then(parseConfigResponse);

function toast(message: string): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.add("show");
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4_000);
}

function sourceError(vendorId: string, message: string): void {
  state.inlineError = { scope: "vendor", vendorId, message };
  renderVendors();
  document.getElementById(`vendor-error-${vendorId}`)?.focus();
}

function settingsError(message: string): void {
  state.inlineError = { scope: "settings", message };
  renderSettings();
  document.getElementById("settings-error")?.focus();
}

function persistPanelUiState(): void {
  void chrome.storage.session.set({
    [PANEL_UI_STATE_KEY]: {
      screen,
      ledgerDateFilter: state.ledgerDateFilter,
      expandedSupplierIds: [...expandedSupplierIds],
    },
  }).catch((error) => console.warn("[collector] side panel state was not saved", error));
}

async function restorePanelUiState(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(PANEL_UI_STATE_KEY);
    const restored = parsePanelUiState(stored[PANEL_UI_STATE_KEY]);
    screen = restored.screen;
    state.ledgerDateFilter = restored.ledgerDateFilter;
    expandedSupplierIds.clear();
    for (const vendorId of restored.expandedSupplierIds) expandedSupplierIds.add(vendorId);
  } catch (error) {
    console.warn("[collector] side panel state was not restored", error);
  }
}

// ---- load + render --------------------------------------------------------

async function load(): Promise<void> {
  try {
    const [sourceResponse, ledgerResponse, config, scheduleResponse, discoveryResponse, activeSupplierTab, tabAwarenessEnabled, ui] = await Promise.all([
      send({ type: "listSources" }),
      send({ type: "getLedger" }),
      getConfig(),
      send({ type: "getSchedule" }),
      send({ type: "getDiscoveryStatus" }),
      queryActiveSupplierTab(),
      hasTabAwarenessPermission(),
      chrome.storage.local.get(VENDOR_GUIDANCE_SEEN),
    ]);
    const background = parseInitialBackgroundState({
      sourceResponse,
      ledgerResponse,
      scheduleResponse,
      discoveryResponse,
    });
    state.sources = background.sources;
    state.ledger = background.ledger;
    state.config = config;
    state.schedule = background.schedule;
    state.discovery = background.discovery;
    state.activeSupplierTab = activeSupplierTab;
    state.tabAwarenessEnabled = tabAwarenessEnabled;
    if (state.discovery.stage !== "idle" && screen !== "vendors") {
      screen = "vendors";
      persistPanelUiState();
    }
    state.vendorGuidanceSeen = ui[VENDOR_GUIDANCE_SEEN] === true;
    render();
    hasLoadedBackgroundState = true;
  } catch (error) {
    console.error("[collector] side panel state failed to load", error);
    app.setAttribute("aria-busy", "false");
    if (hasLoadedBackgroundState) {
      toast("Couldn’t refresh Ratatosk. Your previous view is still shown.");
      return;
    }
    const detail = error instanceof PopupLoadError
      ? error.message
      : "Ratatosk couldn’t reach its background service.";
    app.innerHTML = `${header()}<section class="empty error-state"><h1>Ratatosk couldn’t load</h1><p>${esc(detail)} Try again now, or close and reopen the extension.</p><button class="btn" data-action="retry-load">Try Again</button></section>`;
  }
}

function render(): void {
  app.setAttribute("aria-busy", "false");
  if (screen === "home") renderHome();
  else if (screen === "vendors") renderVendors();
  else renderSettings();
}

function header(): string {
  return `<header class="head">
    <span class="mark"><img src="/icons/48.png" width="44" height="44" alt="" /></span>
    <span class="brand"><span class="title">Ratatosk</span><span class="subtitle">Invoice Collector</span></span>
    <button type="button" class="settings-btn" data-action="open-settings" aria-label="Settings" title="Settings">${gearIcon()}</button>
  </header>`;
}

function renderHome(): void {
  const connected = state.sources.filter((source) => source.connection);
  const needsReconnect = connected.filter((source) =>
    source.connection?.lastStatus === "auth_expired" || source.missingHosts.length > 0);
  const needsAttention = connected.filter((source) =>
    source.missingHosts.length > 0 || source.connection?.lastStatus === "auth_expired" ||
    source.connection?.lastStatus === "partial" || source.connection?.lastStatus === "error" ||
    source.connection?.lastStatus === "rate_limited");

  let status = "";
  if (!state.config) {
    status = `<div class="status"><span class="dot warn" aria-hidden="true"></span><strong>Setup Required</strong><span class="sep" aria-hidden="true">·</span><button type="button" class="status-link" data-action="open-settings">Choose Destination</button></div>`;
  } else if (needsReconnect.length) {
    status = `<button type="button" class="status status-action" data-action="open-vendors"><span class="dot warn" aria-hidden="true"></span><strong>${needsReconnect.length} Vendor${needsReconnect.length > 1 ? "s" : ""} Need Reconnecting</strong><span aria-hidden="true">→</span></button>`;
  } else if (needsAttention.length) {
    status = `<button type="button" class="status status-action" data-action="open-vendors"><span class="dot warn" aria-hidden="true"></span><strong>${needsAttention.length} Vendor${needsAttention.length > 1 ? "s" : ""} Need Attention</strong><span aria-hidden="true">→</span></button>`;
  } else if (state.schedule.periodMinutes && connected.length) {
    const completeSyncs = connected.map((source) =>
      source.connection?.lastCompleteSyncAt ??
      (source.connection?.lastStatus === "ok" ? source.connection.lastRunAt : undefined)
    );
    if (completeSyncs.every((timestamp): timestamp is number => typeof timestamp === "number" && timestamp > 0)) {
      const coverageWatermark = Math.min(...completeSyncs);
      status = `<div class="status" role="status"><span class="dot" aria-hidden="true"></span><strong>Up to Date</strong><span class="sep" aria-hidden="true">·</span><span>all synced ${relTime(coverageWatermark)}</span></div>`;
    } else {
      const pending = completeSyncs.filter((timestamp) => !timestamp).length;
      status = `<button type="button" class="status status-action" data-action="open-vendors"><span class="dot warn" aria-hidden="true"></span><strong>${pending} Vendor${pending === 1 ? "" : "s"} Awaiting First Sync</strong><span aria-hidden="true">→</span></button>`;
    }
  }

  let body: string;
  if (state.ledger.length) {
    const newest = Math.max(...state.ledger.map((entry) => entry.collectedAt));
    const visibleEntries = filterLedgerByDate(state.ledger, state.ledgerDateFilter);
    const groups = groupLedgerBySupplier(visibleEntries);
    const groupRows = groups.map((group) => {
      const isOpen = expandedSupplierIds.has(group.vendorId);
      const hasFresh = group.entries.some((entry) => entry.collectedAt >= newest - 60_000);
      const rows = group.entries.map((entry) => {
        const fresh = entry.collectedAt >= newest - 60_000 ? '<span class="new" aria-label="New"></span>' : "";
        const datetime = entry.issuedAt?.slice(0, 10) ?? new Date(entry.collectedAt).toISOString();
        const collected = entry.issuedAt ? `Collected ${relTime(entry.collectedAt)}` : "Invoice date unavailable";
        return `<li class="invoice-row"><span class="invoice-row-copy"><span class="invoice-label">Invoice ${fresh}</span><small>${esc(collected)}</small></span><time class="invoice-date" datetime="${esc(datetime)}">${invoiceDate(entry)}</time><span class="invoice-amount">${esc(amount(entry.total, entry.currency))}</span></li>`;
      }).join("");
      return `<details class="supplier-group" data-supplier-id="${esc(group.vendorId)}" ${isOpen ? "open" : ""}>
        <summary>${logo(iconFor(group.vendorId), group.vendorName)}<span class="supplier-group-copy"><strong>${esc(group.vendorName)}${hasFresh ? '<span class="new" aria-label="New"></span>' : ""}</strong><small>${group.entries.length} invoice${group.entries.length === 1 ? "" : "s"}</small></span><span class="supplier-updated">${relTime(group.latestCollectedAt)}</span><span class="supplier-chevron" aria-hidden="true">${chevronIcon()}</span></summary>
        <ul class="invoice-list" aria-label="${esc(group.vendorName)} invoices">${rows}</ul>
      </details>`;
    }).join("");
    const history = groups.length
      ? `<div class="supplier-groups">${groupRows}</div>`
      : `<div class="feed-empty"><strong>No invoices in this period</strong><span>Choose a wider date range to see older invoices.</span></div>`;
    body = `<section class="invoice-history" aria-labelledby="invoice-history-title">
      <div class="feed-toolbar"><span><strong id="invoice-history-title">Invoices</strong><small>${visibleEntries.length} of ${state.ledger.length}</small></span><label class="date-filter">${filterIcon()}<span class="sr-only">Filter invoices by date</span><select name="ledger-range" aria-label="Filter invoices by date">${ledgerDateOption("All dates", "all")}${ledgerDateOption("Last 30 days", "30d")}${ledgerDateOption("Last 90 days", "90d")}${ledgerDateOption("This year", "year")}</select></label></div>
      ${history}
    </section><div class="add"><button type="button" class="ghost" data-action="open-vendors">Manage Vendors <span aria-hidden="true">→</span></button></div>`;
  } else if (connected.length) {
    const count = connected.length;
    const vendorLabel = `${count} vendor${count === 1 ? "" : "s"} connected`;
    body = `<section class="home-editorial" aria-label="Invoice collection">
      <div class="home-actions"><button type="button" class="btn" data-action="sync-all">Check for Invoices</button><button type="button" class="quiet-link" data-action="open-vendors">Review Vendors <span aria-hidden="true">→</span></button></div>
      <dl class="home-facts"><div><dt>Vendors</dt><dd>${vendorLabel}</dd></div><div><dt>Destination</dt><dd>${esc(destinationLabel())}</dd></div></dl>
    </section>`;
  } else {
    const hasDestination = Boolean(state.config);
    body = `<section class="home-editorial" aria-labelledby="setup-title">
      <p class="home-kicker">01 · Set Up Ratatosk</p>
      <h1 id="setup-title">Every invoice, in one place.</h1>
      <p class="home-copy">${hasDestination ? "Your destination is ready. Connect the first vendor you want Ratatosk to watch." : "Choose where invoices should go, then connect the first vendor you want Ratatosk to watch."}</p>
      <ol class="setup-ledger">
        <li class="${hasDestination ? "done" : "current"}"><span class="ledger-number">01</span><span><strong>Destination</strong><small>${hasDestination ? esc(destinationLabel()) : "Choose where invoices are saved"}</small></span><span class="ledger-state">${hasDestination ? "Ready" : "Next"}</span></li>
        <li class="${hasDestination ? "current" : ""}"><span class="ledger-number">02</span><span><strong>Vendor</strong><small>Use the session already in Chrome</small></span><span class="ledger-state">${hasDestination ? "Next" : "Waiting"}</span></li>
      </ol>
      <div class="home-actions"><button type="button" class="btn" data-action="${hasDestination ? "open-vendors" : "open-settings"}">${hasDestination ? "Connect First Vendor" : "Choose Destination"}</button></div>
      <p class="trust">Passwords, cookies & session tokens are never stored.</p>
    </section>`;
  }

  app.innerHTML = header() + status + body;
}

function sheetHeader(title: string, trailing = ""): string {
  return `<header class="sheet-head"><button type="button" class="icon-btn lead" data-action="home" aria-label="Back to invoices">${backIcon()}</button><h1>${title}</h1><span class="sheet-actions">${trailing}</span></header>`;
}

function renderVendors(): void {
  const destination = state.config?.kind === "filesystem"
    ? "your local Downloads folder"
    : state.config?.kind === "igdrasil" ? "your connected Igdrasil company" : "the destination you select";
  const showGuidance = !state.vendorGuidanceSeen || state.forceGuidance;
  const guidance = showGuidance ? `<details class="guidance" open>
    <summary>${chevronIcon()} How Ratatosk Connects</summary>
    <div class="guidance-body">
      <p>Ratatosk uses your current browser session only for vendors you choose.</p>
      <ul><li>New documents go to ${esc(destination)}.</li><li>Passwords, cookies & temporary vendor tokens are not stored.</li><li>Disconnecting revokes vendor access.</li></ul>
      <div class="guidance-actions"><span class="guidance-note">Reviewed recipes and locally verified discoveries only.</span><button type="button" class="btn tonal sm" data-action="dismiss-vendor-guidance">Got It</button></div>
    </div>
  </details>` : "";

  const rows = state.sources.map((source) => {
    const connection = source.connection;
    const isBusy = state.busyVendorId === source.id;
    let sub = source.kind === "discovered" ? new URL(source.primaryOrigin).hostname : categoryLabel(source.category);
    let action = source.runnable
      ? `<button type="button" class="btn tonal sm" data-action="connect" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}" ${isBusy ? "disabled" : ""}>${isBusy ? "Connecting…" : "Connect"}</button>`
      : `<button type="button" class="btn tonal sm" disabled aria-describedby="vendor-status-${esc(source.id)}">Unavailable</button>`;
    let secondaryAction = `<span class="action-spacer" aria-hidden="true"></span>`;
    if (connection && source.missingHosts.length > 0) {
      sub = "Vendor access changed — review the newly required site";
      action = `<button type="button" class="btn warn sm" data-action="connect" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}" ${isBusy ? "disabled" : ""}>${isBusy ? "Reviewing…" : "Review Access"}</button>`;
      secondaryAction = `<button type="button" class="icon-btn danger" data-action="disconnect" data-id="${esc(source.id)}" aria-label="Disconnect ${esc(source.name)}">${xIcon()}</button>`;
    } else if (connection?.lastStatus === "auth_expired") {
      sub = "Session expired — sign in, then reconnect";
      action = `<button type="button" class="btn warn sm" data-action="connect" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}" ${isBusy ? "disabled" : ""}>${isBusy ? "Connecting…" : "Reconnect"}</button>`;
    } else if (connection) {
      const count = connection.lastCount ?? 0;
      sub = connection.lastStatus === "partial"
        ? connection.lastError
          ? `Collected ${count}; ${connection.lastError}`
          : `Collected ${count}; ${connection.lastFailedScopes ?? 0} account scope${connection.lastFailedScopes === 1 ? "" : "s"} need attention`
        : connection.lastStatus === "rate_limited"
          ? `Supplier asked Ratatosk to wait · resumes ${relTime(connection.nextEligibleRunAt)}`
          : connection.lastStatus === "error"
        ? connection.lastError ? `Couldn’t sync — ${connection.lastError}` : "Couldn’t sync — try again"
        : count > 0 ? `${count} collected · synced ${relTime(connection.lastCompleteSyncAt ?? connection.lastRunAt)}` : `Connected · synced ${relTime(connection.lastCompleteSyncAt ?? connection.lastRunAt)}`;
      action = `<button type="button" class="btn outline sm" data-action="sync" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}">Sync</button>`;
      secondaryAction = `<button type="button" class="icon-btn danger" data-action="disconnect" data-id="${esc(source.id)}" aria-label="Disconnect ${esc(source.name)}">${xIcon()}</button>`;
    }
    const error = state.inlineError?.scope === "vendor" && state.inlineError.vendorId === source.id
      ? `<div class="inline-error" id="vendor-error-${esc(source.id)}" role="alert" tabindex="-1">${esc(state.inlineError.message)}</div>` : "";
    const diagnostic = connection?.lastStatus && connection.lastStatus !== "ok"
      ? `<button type="button" class="diagnostic-link" data-action="copy-diagnostic" data-id="${esc(source.id)}">Copy diagnostic</button>` : "";
    const history = connection
      ? `<button type="button" class="diagnostic-link subtle" data-action="forget-history" data-id="${esc(source.id)}">Forget history</button>`
      : "";
    const vendorLinks = diagnostic || history ? `<div class="vendor-links">${diagnostic}${history}</div>` : "";
    const lifecycle = source.kind === "discovered"
      ? `<div class="vlifecycle"><span class="local-badge">Discovered · this browser</span></div>`
      : `<div class="vlifecycle">${esc(source.lifecycle ? vendorLifecycleLabel(source.lifecycle) : "Unavailable")}</div>`;
    return `<li class="vrow">${logo(source.icon, source.name)}<div class="mid"><div class="vn">${esc(source.name)}</div>${lifecycle}<div class="vs" id="vendor-status-${esc(source.id)}">${esc(sub)}</div>${vendorLinks}${error}</div><div class="actions">${action}${secondaryAction}</div></li>`;
  }).join("");

  const infoButton = state.vendorGuidanceSeen && !showGuidance
    ? `<button type="button" class="icon-btn" data-action="show-vendor-guidance" aria-label="How vendor connections work">${infoIcon()}</button>` : "";
  const missingSupplier = discoveryCard();
  app.innerHTML = `${sheetHeader("Vendors", infoButton)}${guidance}<ul class="vendor-list">${rows}</ul>${missingSupplier}<p class="foot">Chrome may briefly hide this window while confirming vendor access. Setup continues safely in the background.</p>`;
}

function discoveryCard(): string {
  const discovery = state.discovery;
  const page = state.activeSupplierTab;
  if (discovery.stage === "scanning") {
    return `<aside class="supplier-request discovery-progress" role="status"><span class="discovery-spinner" aria-hidden="true"></span><span class="supplier-request-copy"><strong>Searching this app…</strong><small>Checking a small set of billing-related pages on ${esc(new URL(discovery.origin).hostname)}.</small></span><button type="button" class="quiet-link compact" data-action="cancel-discovery">Cancel</button></aside>`;
  }
  if (discovery.stage === "preview") {
    const sites = discovery.requiredOrigins.length;
    const hostnames = discovery.requiredOrigins.map((pattern) => new URL(pattern.slice(0, -2)).hostname).join(", ");
    const clues = discovery.candidateCount;
    return `<aside class="supplier-request discovery-found" aria-labelledby="supplier-request-title"><span class="supplier-request-mark letter" aria-hidden="true">${esc(discovery.name.charAt(0).toUpperCase())}</span><span class="supplier-request-copy"><strong id="supplier-request-title">Found a possible invoice source</strong><small>${esc(discovery.name)} · ${clues} invoice clue${clues === 1 ? "" : "s"} seen · ${sites} exact site${sites === 1 ? "" : "s"}</small><small class="discovery-hosts">Access: ${esc(hostnames)}</small></span><span class="discovery-actions"><button type="button" class="btn tonal sm" data-action="connect-discovery" data-id="${esc(discovery.vendorId)}">Connect &amp; Collect</button><button type="button" class="quiet-link compact" data-action="cancel-discovery">Cancel</button></span></aside>`;
  }
  if (discovery.stage === "connecting") {
    return `<aside class="supplier-request discovery-progress" role="status"><span class="discovery-spinner" aria-hidden="true"></span><span class="supplier-request-copy"><strong>Verifying downloads…</strong><small>${esc(discovery.name)} will be saved only if a valid PDF is collected.</small></span></aside>`;
  }
  if (discovery.stage === "complete") {
    return `<aside class="supplier-request discovery-complete" role="status"><span class="supplier-request-mark success" aria-hidden="true">✓</span><span class="supplier-request-copy"><strong>${esc(discovery.name)} is connected</strong><small>Collected ${discovery.count} verified invoice${discovery.count === 1 ? "" : "s"}. The supplier is now in your list.</small></span><button type="button" class="quiet-link compact" data-action="dismiss-discovery">Done</button></aside>`;
  }
  if (discovery.stage === "failed") {
    const diagnostic = discovery.diagnosticAvailable
      ? `<button type="button" class="quiet-link compact" data-action="copy-discovery-diagnostic">Copy Diagnostic</button>`
      : "";
    return `<aside class="supplier-request discovery-failed" role="alert"><span class="supplier-request-mark" aria-hidden="true">!</span><span class="supplier-request-copy"><strong>Couldn’t verify this supplier</strong><small>${esc(discovery.message)}</small><button type="button" class="supplier-help-link" data-action="open-add-supplier">Add it with Studio on GitHub ${externalIcon()}</button></span><span class="discovery-actions"><button type="button" class="btn tonal sm" data-action="cancel-discovery">Try Again</button>${diagnostic}</span></aside>`;
  }
  if (state.config && !page && !state.tabAwarenessEnabled) {
    return `<aside class="supplier-request tab-awareness" aria-labelledby="tab-awareness-title"><span class="supplier-request-mark" aria-hidden="true">${branchIcon()}</span><span class="supplier-request-copy"><strong id="tab-awareness-title">Find invoices on this site</strong><small>Allow Ratatosk to recognize the supplier in your active tab. Chrome will ask once.</small></span><button type="button" class="supplier-request-link" data-action="enable-tab-awareness" ${state.tabAwarenessRequestPending ? "disabled" : ""}>${state.tabAwarenessRequestPending ? "Preparing…" : "Find Invoices"}</button></aside>`;
  }
  const listed = page ? state.sources.find((source) => source.primaryOrigin === page.origin) : undefined;
  if (listed) {
    return `<aside class="supplier-request"><span class="supplier-request-mark letter" aria-hidden="true">${esc(listed.name.charAt(0).toUpperCase())}</span><span class="supplier-request-copy"><strong>${esc(listed.name)} is already listed</strong><small>Use its Connect button above for ${esc(page!.hostname)}.</small></span><button type="button" class="supplier-request-link" disabled>Listed Above</button></aside>`;
  }
  const ready = Boolean(state.config && page);
  const detail = !state.config
    ? "Choose a destination first."
    : page ? `Search ${page.hostname} for billing and invoice pages.` : "Open an HTTPS supplier app first.";
  return `<aside class="supplier-request" aria-labelledby="supplier-request-title"><span class="supplier-request-mark" aria-hidden="true">${branchIcon()}</span><span class="supplier-request-copy"><strong id="supplier-request-title">Supplier not listed?</strong><small>${esc(detail)}</small><button type="button" class="supplier-help-link" data-action="open-add-supplier">Build a reviewed recipe instead ${externalIcon()}</button></span><button type="button" class="supplier-request-link" data-action="try-discovery" ${ready ? "" : "disabled"}>Find Invoices</button></aside>`;
}

function renderSettings(): void {
  const config = state.config;
  const kind = config?.kind ?? "unconfigured";
  const filesystemConfig = config?.kind === "filesystem" ? config : null;
  const period = state.schedule.periodMinutes ?? 0;
  const scheduleOption = (label: string, minutes: number) => `<label><input type="radio" name="schedule" value="${minutes}" ${period === minutes ? "checked" : ""} /><span>${label}</span></label>`;
  const filesystemChecked = kind === "filesystem" ? "checked" : "";

  const destinationFields = filesystemConfig
    ? `<div class="fields"><div class="field"><label for="folder">Folder</label><input id="folder" name="folder" autocomplete="off" maxlength="100" data-field="folder" value="${esc(filesystemConfig.rootFolder)}" /></div><div class="field"><label for="date-mode">Folders By</label><select id="date-mode" name="dateMode" autocomplete="off" data-field="datemode"><option value="extraction" ${filesystemConfig.dateMode === "extraction" ? "selected" : ""}>Date Collected</option><option value="invoice" ${filesystemConfig.dateMode === "invoice" ? "selected" : ""}>Invoice Date</option></select></div></div>`
    : kind === "igdrasil"
      ? `<div class="callout"><strong>Connected through Igdrasil.</strong> Manage the destination and company from the Igdrasil web app.</div>`
      : `<div class="callout"><strong>Choose a destination first.</strong> Ratatosk will not fetch or save invoices until you confirm one.</div>`;
  const error = state.inlineError?.scope === "settings"
    ? `<div class="inline-error settings-error" id="settings-error" role="alert" tabindex="-1">${esc(state.inlineError.message)}</div>` : "";
  const tabAwareness = state.tabAwarenessEnabled
    ? `<div class="context-access"><span><strong>Active-tab switching enabled</strong><small>Ratatosk reads the current tab URL to keep this side panel in context. URLs are not stored as browsing history.</small></span><button type="button" class="btn outline sm" data-action="disable-tab-awareness">Turn Off</button></div>`
    : `<div class="context-access"><span><strong>Recognize supplier tabs automatically</strong><small>Chrome calls this permission “Read your browsing history.” Ratatosk only reads the current tab URL and does not store browsing history.</small></span><button type="button" class="btn tonal sm" data-action="enable-tab-awareness" ${state.tabAwarenessRequestPending ? "disabled" : ""}>${state.tabAwarenessRequestPending ? "Preparing…" : "Enable"}</button></div>`;

  app.innerHTML = `${sheetHeader("Settings")}
    <form class="settings-form">
      <fieldset class="grp"><legend>Save Invoices To</legend><div class="opts">
        <label class="opt"><input type="radio" name="destination" value="filesystem" ${filesystemChecked} /><span class="radio" aria-hidden="true"></span><span><strong>This Computer</strong><small>Downloads folder</small></span></label>
        <button type="button" class="opt opt-link ${kind === "igdrasil" ? "selected" : ""}" data-action="${kind === "igdrasil" ? "manage-igdrasil" : "connect-igdrasil"}"><span class="radio" aria-hidden="true"></span><span><strong>Igdrasil Accounting</strong><small>${kind === "igdrasil" ? "Connected · invoices go to your inbox" : "Connect or create an Igdrasil account"}</small></span><span class="open-label">${kind === "igdrasil" ? "Manage" : "Connect"}</span></button>
      </div>${destinationFields}${error}</fieldset>
      <fieldset class="grp divider"><legend>Check for New Invoices</legend><div class="seg">${scheduleOption("Off", 0)}${scheduleOption("6h", 360)}${scheduleOption("12h", 720)}${scheduleOption("Daily", 1440)}</div></fieldset>
      <fieldset class="grp divider"><legend>Browser Context</legend>${tabAwareness}</fieldset>
    </form>
    <p class="foot">Runs while Chrome is open and uses your signed-in vendor sessions. If Chrome is closed, Ratatosk catches up next time.</p>`;
}

// ---- actions --------------------------------------------------------------

app.addEventListener("click", (event) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!element) return;
  const action = element.dataset.action!;
  const vendorId = element.dataset.id;
  if (action === "connect" && vendorId) {
    // Both calls start before the first await. The browser API therefore keeps
    // the click activation while the worker prepares a popup-independent handoff.
    void connectFromUserGesture(vendorId);
    return;
  }
  if (action === "enable-tab-awareness") {
    void enableTabAwarenessFromUserGesture();
    return;
  }
  if (action === "try-discovery") {
    void discoverFromUserGesture();
    return;
  }
  if (action === "connect-discovery" && vendorId) {
    void connectDiscoveryFromUserGesture(vendorId);
    return;
  }
  void handle(action, vendorId);
});

app.addEventListener("change", (event) => {
  const element = event.target as HTMLInputElement | HTMLSelectElement;
  if (element instanceof HTMLSelectElement && element.name === "ledger-range") {
    state.ledgerDateFilter = element.value as LedgerDateFilter;
    persistPanelUiState();
    renderHome();
    return;
  }
  if (element.dataset.field) {
    void saveField(element.dataset.field, element.value);
    return;
  }
  if (element instanceof HTMLInputElement && element.name === "schedule") {
    void updateSchedule(Number(element.value));
  } else if (element instanceof HTMLInputElement && element.name === "destination" && element.value === "filesystem") {
    void switchToFilesystem();
  }
});

app.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("supplier-group")) return;
  const vendorId = details.dataset.supplierId;
  if (!vendorId) return;
  if (details.open) expandedSupplierIds.add(vendorId);
  else expandedSupplierIds.delete(vendorId);
  persistPanelUiState();
}, true);

async function connectFromUserGesture(vendorId: string): Promise<void> {
  if (!state.config) {
    screen = "settings";
    persistPanelUiState();
    settingsError("Choose where invoices should be saved, then connect a vendor.");
    return;
  }
  const source = state.sources.find((candidate) => candidate.id === vendorId);
  if (!source) {
    sourceError(vendorId, "That vendor is no longer available. Reopen Ratatosk and try again.");
    return;
  }

  const prepared = send({ type: "beginConnect", vendorId });
  const permission = requestHostPermissions(source.missingHosts.length ? source.missingHosts : source.hosts);
  state.busyVendorId = vendorId;
  state.inlineError = null;
  renderVendors();

  try {
    const [prepareResponse, granted] = await Promise.all([prepared, permission]);
    if (!prepareResponse.ok) {
      await send({ type: "cancelConnect", vendorId });
      state.busyVendorId = null;
      sourceError(vendorId, prepareResponse.error);
      return;
    }
    if (!granted) {
      await send({ type: "cancelConnect", vendorId });
      state.busyVendorId = null;
      sourceError(vendorId, "Access wasn’t granted. Select Connect and approve the vendor sites Chrome lists.");
      return;
    }
    const response = await send({ type: "completeConnect", vendorId });
    if (!response.ok) {
      state.busyVendorId = null;
      sourceError(vendorId, response.error);
      return;
    }
    toast("Vendor Connected");
    state.busyVendorId = null;
    await load();
  } catch (error) {
    console.error("[collector] host permission request failed", error);
    void send({ type: "cancelConnect", vendorId });
    state.busyVendorId = null;
    sourceError(vendorId, "Chrome couldn’t finish the request. Select Connect to try again.");
  }
}

async function discoverFromUserGesture(): Promise<void> {
  const page = state.activeSupplierTab;
  if (!state.config) {
    screen = "settings";
    persistPanelUiState();
    settingsError("Choose where invoices should be saved, then try the supplier again.");
    return;
  }
  if (!page) {
    toast("Open an HTTPS supplier app first.");
    return;
  }
  const prepared = send({ type: "beginDiscovery", tabId: page.tabId, origin: page.origin });
  const permission = requestHostPermissions([`${page.origin}/*`]);
  state.discovery = { stage: "scanning", origin: page.origin };
  renderVendors();
  try {
    const [prepareResponse, granted] = await Promise.all([prepared, permission]);
    if (!prepareResponse.ok) {
      await send({ type: "cancelDiscovery" });
      toast(prepareResponse.error);
      await load();
      return;
    }
    if (!granted) {
      await send({ type: "cancelDiscovery" });
      toast("Access wasn’t granted. Ratatosk did not inspect the site.");
      await load();
      return;
    }
    const completed = await send({ type: "completeDiscovery" });
    if (!completed.ok) {
      await send({ type: "cancelDiscovery" });
      toast("Ratatosk couldn’t search this app. Try again.");
    }
    await load();
  } catch (error) {
    console.error("[collector] supplier discovery permission failed", error);
    await send({ type: "cancelDiscovery" });
    toast("Chrome couldn’t finish the request. Try the supplier again.");
    await load();
  }
}

async function connectDiscoveryFromUserGesture(vendorId: string): Promise<void> {
  const discovery = state.discovery;
  if (discovery.stage !== "preview" || discovery.vendorId !== vendorId) return;
  const prepared = send({ type: "beginDiscoveryConnect", vendorId });
  const permission = requestHostPermissions(discovery.requiredOrigins);
  state.discovery = { stage: "connecting", name: discovery.name };
  renderVendors();
  try {
    const [prepareResponse, granted] = await Promise.all([prepared, permission]);
    if (!prepareResponse.ok) {
      await send({ type: "cancelDiscoveryConnect" });
      toast(prepareResponse.error);
      await load();
      return;
    }
    if (!granted) {
      await send({ type: "cancelDiscoveryConnect" });
      toast("Access wasn’t granted. No supplier was saved.");
      await load();
      return;
    }
    const response = await send({ type: "completeDiscoveryConnect", vendorId });
    if (!response.ok) toast(response.error);
    await load();
  } catch (error) {
    console.error("[collector] discovered supplier connection failed", error);
    await send({ type: "cancelDiscoveryConnect" });
    toast("Chrome couldn’t verify the supplier. Try again.");
    await load();
  }
}

async function handle(action: string, vendorId?: string): Promise<void> {
  switch (action) {
    case "open-settings": screen = "settings"; state.inlineError = null; persistPanelUiState(); render(); return;
    case "open-vendors": screen = "vendors"; state.inlineError = null; persistPanelUiState(); render(); return;
    case "home": screen = "home"; state.inlineError = null; persistPanelUiState(); await load(); return;
    case "retry-load": await load(); return;
    case "sync": await run({ type: "runNow", vendorId: vendorId! }, vendorId); return;
    case "sync-all": await run({ type: "runNow" }); return;
    case "disconnect": openDisconnectDialog(vendorId!); return;
    case "forget-history": openHistoryDialog(vendorId!); return;
    case "disable-tab-awareness": await disableTabAwareness(); return;
    case "copy-diagnostic": await copyVendorDiagnostic(vendorId!); return;
    case "copy-discovery-diagnostic": await copyDiscoveryDiagnostic(); return;
    case "connect-igdrasil": await openIgdrasilConnect(); return;
    case "manage-igdrasil": await chrome.tabs.create({ url: "https://accounting.igdrasil.se/integrations/invoice-collector" }); return;
    case "open-add-supplier":
      await chrome.tabs.create({ url: ADD_SUPPLIER_URL });
      return;
    case "cancel-discovery":
    case "dismiss-discovery":
      await send({ type: action === "cancel-discovery" ? "cancelDiscovery" : "dismissDiscovery" });
      await load();
      return;
    case "dismiss-vendor-guidance":
      await chrome.storage.local.set({ [VENDOR_GUIDANCE_SEEN]: true });
      state.vendorGuidanceSeen = true;
      state.forceGuidance = false;
      renderVendors();
      return;
    case "show-vendor-guidance": state.forceGuidance = true; renderVendors(); return;
  }
}

async function openIgdrasilConnect(): Promise<void> {
  const response = await send({ type: "beginIgdrasilConnect" });
  if (!response.ok || !("connectUrl" in response)) {
    settingsError(response.ok ? "Ratatosk could not start the connection." : response.error);
    return;
  }
  await chrome.tabs.create({ url: response.connectUrl });
}

async function run(message: Parameters<typeof send>[0], vendorId?: string): Promise<void> {
  toast("Syncing…");
  try {
    const response = await send(message);
    if (!response.ok) {
      if (vendorId) sourceError(vendorId, `${response.error} Check that you’re signed in, then try again.`);
      else toast(response.error);
      return;
    }
    if ("summaries" in response) {
      const collected = response.summaries.reduce((count, summary) => count + (summary.status === "ok" || summary.status === "partial" ? summary.count : 0), 0);
      const waiting = response.summaries.find((summary) => summary.status === "rate_limited" || summary.status === "skipped");
      const expired = response.summaries.find((summary) => summary.status === "auth_expired");
      const failed = response.summaries.find((summary) => summary.status === "error");
      if (waiting) toast(`Supplier asked Ratatosk to wait until ${relTime(waiting.nextEligibleRunAt)}`);
      else if (expired) toast("Session expired — sign in to the supplier and reconnect");
      else if (failed?.error) toast(failed.error);
      else toast(collected ? `Collected ${collected} Invoice${collected === 1 ? "" : "s"}` : "No New Invoices");
    }
    await load();
  } catch (error) {
    console.error("[collector] side panel action failed", error);
    if (vendorId) sourceError(vendorId, "Ratatosk couldn’t reach the background process. Reopen the extension and try again.");
    else toast("Couldn’t finish. Reopen Ratatosk and try again.");
  }
}

async function copyVendorDiagnostic(vendorId: string): Promise<void> {
  const response = await send({ type: "getVendorDiagnostic", vendorId });
  if (!response.ok || !("diagnostic" in response)) {
    sourceError(vendorId, response.ok ? "Diagnostic unavailable." : response.error);
    return;
  }
  try {
    await navigator.clipboard.writeText(`${JSON.stringify(response.diagnostic, null, 2)}\n`);
    toast("Redacted Diagnostic Copied");
  } catch {
    sourceError(vendorId, "Clipboard access failed. Reopen Ratatosk and try again.");
  }
}

async function copyDiscoveryDiagnostic(): Promise<void> {
  const response = await send({ type: "getDiscoveryDiagnostic" });
  if (!response.ok || !("discoveryDiagnostic" in response)) {
    toast(response.ok ? "Diagnostic unavailable." : response.error);
    return;
  }
  try {
    await navigator.clipboard.writeText(`${JSON.stringify(response.discoveryDiagnostic, null, 2)}\n`);
    toast("Redacted Diagnostic Copied");
  } catch {
    toast("Clipboard access failed. Reopen Ratatosk and try again.");
  }
}

async function switchToFilesystem(): Promise<void> {
  const config = state.config;
  const response = await send({
    type: "setConfig",
    config: {
      kind: "filesystem",
      rootFolder: config?.kind === "filesystem" ? config.rootFolder : "Ratatosk",
      dateMode: config?.kind === "filesystem" ? config.dateMode : "extraction",
    },
  });
  if (!response.ok) {
    settingsError(response.error);
    return;
  }
  state.inlineError = null;
  await load();
}

async function updateSchedule(periodMinutes: number): Promise<void> {
  const response = await send({ type: "setSchedule", periodMinutes });
  if (!response.ok) {
    settingsError(response.error);
    return;
  }
  toast(periodMinutes ? "Auto-Sync Updated" : "Auto-Sync Turned Off");
  await load();
}

async function enableTabAwarenessFromUserGesture(): Promise<void> {
  // Start synchronously inside the click handler so Chrome retains the user
  // gesture required for an optional permission prompt.
  const permission = requestTabAwarenessPermission();
  state.tabAwarenessRequestPending = true;
  render();
  try {
    const granted = await permission;
    state.tabAwarenessRequestPending = false;
    if (!granted) {
      toast("Chrome Access Was Not Granted");
      render();
      return;
    }
    await refreshTabAwareness();
    toast("Ready — Select Find Invoices");
  } catch (error) {
    console.error("[collector] tab awareness permission failed", error instanceof Error ? error.name : "unknown");
    state.tabAwarenessRequestPending = false;
    toast("Chrome Couldn’t Prepare This Tab");
    render();
  }
}

async function disableTabAwareness(): Promise<void> {
  await revokeTabAwarenessPermission();
  await refreshTabAwareness();
  toast("Tab Switching Turned Off");
}

async function refreshTabAwareness(): Promise<void> {
  const [enabled, page] = await Promise.all([
    hasTabAwarenessPermission(),
    queryActiveSupplierTab(),
  ]);
  state.tabAwarenessEnabled = enabled;
  state.activeSupplierTab = page;
  render();
}

async function saveField(field: string, value: string): Promise<void> {
  const config = state.config;
  if (config?.kind !== "filesystem") return;
  const next = field === "folder"
    ? { ...config, rootFolder: value || "Ratatosk" }
    : field === "datemode" ? { ...config, dateMode: value as "extraction" | "invoice" } : config;
  const response = await send({ type: "setConfig", config: next });
  if (!response.ok) settingsError(response.error);
  else state.config = await getConfig();
}

function openDisconnectDialog(vendorId: string): void {
  const source = state.sources.find((candidate) => candidate.id === vendorId);
  if (!source) return;
  disconnectVendorId = vendorId;
  disconnectName.textContent = source.name;
  disconnectDialog.showModal();
}

confirmDisconnect.addEventListener("click", () => {
  const vendorId = disconnectVendorId;
  disconnectDialog.close();
  disconnectVendorId = null;
  if (vendorId) void disconnectVendor(vendorId);
});

cancelDisconnect.addEventListener("click", () => disconnectDialog.close());
disconnectDialog.addEventListener("close", () => { disconnectVendorId = null; });

function openHistoryDialog(vendorId: string): void {
  const source = state.sources.find((candidate) => candidate.id === vendorId);
  if (!source) return;
  historyVendorId = vendorId;
  historyName.textContent = source.name;
  historyDialog.showModal();
}

confirmHistory.addEventListener("click", () => {
  const vendorId = historyVendorId;
  historyDialog.close();
  historyVendorId = null;
  if (vendorId) void forgetVendorHistory(vendorId);
});

cancelHistory.addEventListener("click", () => historyDialog.close());
historyDialog.addEventListener("close", () => { historyVendorId = null; });

async function forgetVendorHistory(vendorId: string): Promise<void> {
  const response = await send({ type: "forgetVendorHistory", vendorId });
  if (!response.ok) {
    sourceError(vendorId, `${response.error} Try again.`);
    return;
  }
  toast("Download History Forgotten");
  await load();
}

async function disconnectVendor(vendorId: string): Promise<void> {
  toast("Disconnecting…");
  try {
    const response = await send({ type: "disconnect", vendorId });
    if (!response.ok) {
      sourceError(vendorId, `${response.error} Try again.`);
      return;
    }
    toast("Vendor Disconnected");
    await load();
  } catch (error) {
    console.error("[collector] disconnect failed", error);
    sourceError(vendorId, "Ratatosk couldn’t disconnect this vendor. Reopen the extension and try again.");
  }
}

function iconFor(vendorId: string): string | undefined {
  return state.sources.find((source) => source.id === vendorId)?.icon;
}

function destinationLabel(): string {
  const config = state.config;
  if (config?.kind === "filesystem") return `Downloads / ${config.rootFolder}`;
  if (config?.kind === "igdrasil") return "Igdrasil Accounting";
  if (config?.kind === "http") return "Connected Accounting App";
  return "Not Selected";
}

function ledgerDateOption(label: string, value: LedgerDateFilter): string {
  return `<option value="${value}" ${state.ledgerDateFilter === value ? "selected" : ""}>${label}</option>`;
}

// ---- inline icons ---------------------------------------------------------

function gearIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/></svg>`; }
function backIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>`; }
function xIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>`; }
function chevronIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>`; }
function infoIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>`; }
function branchIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="6" r="2.2"/><circle cx="17" cy="8" r="2.2"/><circle cx="7" cy="18" r="2.2"/><path d="M7 8.2v7.6M9.2 8h3.3A4.5 4.5 0 0 1 17 12.5v2.3"/></svg>`; }
function externalIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3.5H3.5v9h9V10M8.5 3.5h4v4M12.2 3.8 7 9"/></svg>`; }
function filterIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M5.5 10h9M8 15h4"/></svg>`; }

async function boot(): Promise<void> {
  await restorePanelUiState();
  await load();
  const stopWatchingActiveTab = watchActiveSupplierTab(
    () => {
      const hadPage = state.activeSupplierTab !== null;
      state.activeSupplierTab = null;
      if (hadPage && screen === "vendors") renderVendors();
    },
    (page) => {
      state.activeSupplierTab = page;
      if (screen === "vendors") renderVendors();
    },
  );
  const onTabPermissionChanged = (permissions: chrome.permissions.Permissions) => {
    if (permissions.permissions?.includes("tabs")) void refreshTabAwareness();
  };
  chrome.permissions.onAdded.addListener(onTabPermissionChanged);
  chrome.permissions.onRemoved.addListener(onTabPermissionChanged);
  window.addEventListener("unload", () => {
    stopWatchingActiveTab();
  }, { once: true });
}

void boot();
