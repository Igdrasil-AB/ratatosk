/**
 * Ratatosk Collector side panel. Framework-free and intentionally small: state
 * comes from the service worker and each screen renders semantic native controls.
 */
import { send, type DiscoveryStatusView, type ScheduleInfo, type SourceView } from "../../platform/messaging";
import type { VendorRunSummary } from "../../platform/collector";
import type { LedgerEntry } from "../../platform/storage";
import { vendorLifecycleLabel } from "../../../../src/vendors/lifecycle";
import {
  hasTabAwarenessPermission,
  requestHostPermissions,
  requestTabAwarenessPermission,
  revokeTabAwarenessPermission,
} from "../../platform/permissions";
import { brandIcon } from "../../../../src/vendors/icons";
import {
  filterLedgerByDate,
  groupLedgerBySupplier,
  invoiceCountLabel,
  isRecentlyCollected,
  ledgerDateFilterLabel,
  type LedgerDateFilter,
} from "./ledger-view";
import { PANEL_UI_STATE_KEY, parsePanelUiState, type PanelScreen } from "./panel-state";
import {
  queryActiveSupplierTab,
  watchActiveSupplierTab,
  type ActiveSupplierTab,
} from "./active-supplier-tab";
import { parseConfigResponse, parseInitialBackgroundState, PopupLoadError } from "./load-state";
import { folderPath, getDownloadRoot } from "../../platform/filesystem-sink";
import {
  ordinalDay,
  syncScheduleLabel,
  weekdayNames,
  type SyncSchedule,
} from "../../../../src/core/sync-schedule";

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
const syncDialog = document.getElementById("sync-dialog") as HTMLDialogElement;
const syncFromMonth = document.getElementById("sync-from-month") as HTMLInputElement;
const confirmSync = document.getElementById("confirm-sync") as HTMLButtonElement;
const cancelSync = document.getElementById("cancel-sync") as HTMLButtonElement;
const VENDOR_GUIDANCE_SEEN = "ui.vendorGuidanceSeen.v1";

let screen: PanelScreen = "home";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let disconnectVendorId: string | null = null;
let historyVendorId: string | null = null;
type CollectionTarget =
  | { kind: "connected"; vendorId?: string }
  | { kind: "discovery"; vendorId: string };
let pendingSyncTarget: CollectionTarget | null = null;
let hasLoadedBackgroundState = false;
/** How long the discovery success card stays before retiring itself. Matches
 * the `discovery-retire` fade in popup.html so it leaves rather than blinks. */
const SUCCESS_CARD_MS = 4_000;
let successDismissTimer: ReturnType<typeof setTimeout> | undefined;
let retiredSuccessVendorId: string | null = null;
const expandedSupplierIds = new Set<string>();
const state = {
  sources: [] as SourceView[],
  ledger: [] as LedgerEntry[],
  config: null as Awaited<ReturnType<typeof getConfig>>,
  schedule: { schedule: { mode: "daily" }, nextRunAt: null } as ScheduleInfo,
  vendorGuidanceSeen: false,
  forceGuidance: false,
  busyVendorId: null as string | null,
  inlineError: null as InlineError | null,
  discovery: { stage: "idle" } as DiscoveryStatusView,
  activeSupplierTab: null as ActiveSupplierTab | null,
  tabAwarenessEnabled: false,
  tabAwarenessRequestPending: false,
  ledgerDateFilter: "all" as LedgerDateFilter,
  attentionOnly: false,
  /** Absolute directory Chrome saves into, known only after the first save. */
  downloadRoot: null as string | null,
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
  const match = entry.issuedAt?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (
      date.getUTCFullYear() === Number(match[1]) &&
      date.getUTCMonth() === Number(match[2]) - 1 &&
      date.getUTCDate() === Number(match[3])
    ) {
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(date);
    }
  }
  return "—";
}

function invoiceLabel(entry: LedgerEntry): string {
  if (entry.invoiceNumber) return entry.invoiceNumber;
  const filename = entry.filename?.replace(/\.pdf$/i, "").trim();
  if (
    filename &&
    !/(?:^|[-_])unknown(?:[-_]|$)|document-[a-f0-9]{12,}/i.test(filename)
  ) return filename;
  return "Invoice";
}

function sourceNeedsAttention(source: SourceView): boolean {
  return Boolean(
    source.connection && (
      source.missingHosts.length > 0 ||
      source.connection.lastStatus === "auth_expired" ||
      source.connection.lastStatus === "partial" ||
      source.connection.lastStatus === "error" ||
      source.connection.lastStatus === "rate_limited"
    )
  );
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
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
    toastTimer = setTimeout(() => {
      toastEl.textContent = "";
      toastTimer = undefined;
    }, 180);
  }, 4_000);
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

function replaceApp(markup: string): void {
  const focused = document.activeElement instanceof HTMLElement && app.contains(document.activeElement)
    ? {
        action: document.activeElement.dataset.action,
        id: document.activeElement.dataset.id,
        range: document.activeElement.dataset.range,
      }
    : undefined;
  app.innerHTML = markup;
  if (!focused?.action) return;
  const selector = [
    `[data-action="${CSS.escape(focused.action)}"]`,
    focused.id ? `[data-id="${CSS.escape(focused.id)}"]` : "",
    focused.range ? `[data-range="${CSS.escape(focused.range)}"]` : "",
  ].join("");
  app.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
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
      getDownloadRoot().then((root) => { state.downloadRoot = root ?? null; }),
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
  const needsAttention = connected.filter(sourceNeedsAttention);

  let status = "";
  if (!state.config) {
    // The button below is this screen's action; repeating it here as a link
    // only makes a person choose between two identical things.
    status = `<div class="status"><span class="dot warn" aria-hidden="true"></span><strong>Setup Required</strong></div>`;
  } else if (needsReconnect.length) {
    status = `<button type="button" class="status status-action" data-action="open-attention"><span class="dot warn" aria-hidden="true"></span><strong>${needsReconnect.length} Vendor${needsReconnect.length > 1 ? "s" : ""} Need Reconnecting</strong><span aria-hidden="true">→</span></button>`;
  } else if (needsAttention.length) {
    status = `<button type="button" class="status status-action" data-action="open-attention"><span class="dot warn" aria-hidden="true"></span><strong>${needsAttention.length} Vendor${needsAttention.length > 1 ? "s" : ""} Need Attention</strong><span aria-hidden="true">→</span></button>`;
  } else if (state.schedule.schedule.mode !== "off" && connected.length) {
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
    const visibleEntries = filterLedgerByDate(state.ledger, state.ledgerDateFilter);
    const groups = groupLedgerBySupplier(visibleEntries);
    const groupRows = groups.map((group) => {
      const isOpen = expandedSupplierIds.has(group.vendorId);
      const hasFresh = group.entries.some((entry) => isRecentlyCollected(entry.collectedAt));
      const rows = group.entries.map((entry) => {
        const fresh = isRecentlyCollected(entry.collectedAt) ? '<span class="new" aria-label="New"></span>' : "";
        const datetime = entry.issuedAt?.slice(0, 10);
        const displayedDate = invoiceDate(entry);
        const date = datetime && displayedDate !== "—"
          ? `<time class="invoice-date" datetime="${esc(datetime)}">${displayedDate}</time>`
          : `<span class="invoice-date unavailable" aria-label="Invoice date unavailable">—</span>`;
        const total = amount(entry.total, entry.currency);
        return `<li class="invoice-row"><span class="invoice-row-copy"><span class="invoice-label">${esc(invoiceLabel(entry))} ${fresh}</span><small>Collected ${relTime(entry.collectedAt)}</small></span>${date}<span class="invoice-amount${total ? "" : " unavailable"}" ${total ? "" : 'aria-label="Invoice amount unavailable"'}>${esc(total || "—")}</span></li>`;
      }).join("");
      return `<details class="supplier-group" data-supplier-id="${esc(group.vendorId)}" ${isOpen ? "open" : ""}>
        <summary>${logo(iconFor(group.vendorId), group.vendorName)}<span class="supplier-group-copy"><strong>${esc(group.vendorName)}${hasFresh ? '<span class="new" aria-label="New"></span>' : ""}</strong><small>${group.entries.length} invoice${group.entries.length === 1 ? "" : "s"}</small></span><span class="supplier-updated">${relTime(group.latestCollectedAt)}</span><span class="supplier-chevron" aria-hidden="true">${chevronIcon()}</span></summary>
        <ul class="invoice-list" aria-label="${esc(group.vendorName)} invoices">${rows}</ul>
      </details>`;
    }).join("");
    const history = groups.length
      ? `<div class="supplier-groups">${groupRows}</div>`
      : `<div class="feed-empty"><strong>No invoices in this period</strong><span>Choose a wider date range.</span></div>`;
    body = `<section class="invoice-history" aria-labelledby="invoice-history-title">
      <div class="feed-toolbar"><span><strong id="invoice-history-title">Invoices</strong><small>${invoiceCountLabel(visibleEntries.length, state.ledger.length)}</small></span><span class="feed-toolbar-actions">${ledgerDateFilter()}</span></div>
      ${history}
    </section>${homeActionBar()}`;
  } else if (connected.length) {
    const count = connected.length;
    body = `<section class="home-editorial" aria-label="Invoice collection">
      ${homePrimaryAction()}
      <div class="home-facts">
        <button type="button" class="fact" data-action="open-vendors"><span class="fact-key">Vendors</span><span class="fact-value">${count} connected</span></button>
        <button type="button" class="fact" data-action="open-settings" title="${esc(destinationLabel())}"><span class="fact-key">Destination</span><span class="fact-value">${esc(destinationLabel())}</span></button>
      </div>
    </section>`;
  } else {
    const hasDestination = Boolean(state.config);
    body = `<section class="home-editorial" aria-labelledby="setup-title">
      <h1 id="setup-title">Every invoice, in one place.</h1>
      <ol class="setup-ledger">
        <li class="${hasDestination ? "done" : "current"}"><span class="ledger-number">01</span><span><strong>Destination</strong><small>${hasDestination ? esc(destinationLabel()) : "Where invoices are saved"}</small></span><span class="ledger-state">${hasDestination ? "Ready" : "Next"}</span></li>
        <li class="${hasDestination ? "current" : ""}"><span class="ledger-number">02</span><span><strong>Vendor</strong><small>Uses your Chrome session</small></span><span class="ledger-state">${hasDestination ? "Next" : "Waiting"}</span></li>
      </ol>
      <div class="home-actions"><button type="button" class="btn lg" data-action="${hasDestination ? "open-vendors" : "open-settings"}">${hasDestination ? "Connect First Vendor" : "Choose Destination"}</button></div>
      <p class="trust">Passwords and cookies are never stored.</p>
    </section>`;
  }

  replaceApp(header() + status + body);
}

/**
 * The supplier site the person is looking at right now, when Ratatosk does not
 * already know it. Searching that site is the product's headline capability, so
 * it belongs on the first screen rather than at the bottom of a second one.
 */
function discoverableTab(): ActiveSupplierTab | null {
  const page = state.activeSupplierTab;
  if (!state.config || !page) return null;
  return state.sources.some((source) => source.primaryOrigin === page.origin) ? null : page;
}

/** Offered only while that tab is open, so it never competes for the primary
 * slot a screen's own action occupies. */
function discoveryBanner(): string {
  const page = discoverableTab();
  if (!page || state.discovery.stage !== "idle") return "";
  return `<button type="button" class="btn tonal block discover-here" data-action="discover-here">${branchIcon()}<span>Find invoices on ${esc(page.hostname)}</span><span aria-hidden="true">→</span></button>`;
}

function homePrimaryAction(): string {
  return `<div class="home-actions">
    <button type="button" class="btn lg" data-action="sync-all">Check for Invoices</button>
    ${discoveryBanner()}
  </div>`;
}

/** The recurring action, kept at thumb height under the list it acts on. */
function homeActionBar(): string {
  const banner = discoveryBanner();
  return `${banner ? `<div class="bar-lead">${banner}</div>` : ""}<div class="action-bar">
    <button type="button" class="btn lg" data-action="sync-all">Collect All</button>
    <button type="button" class="ghost" data-action="open-vendors">${branchIcon()}<span>Vendors</span></button>
  </div>`;
}

function sheetHeader(title: string, trailing = ""): string {
  return `<header class="sheet-head"><button type="button" class="icon-btn lead" data-action="home" aria-label="Back to invoices">${backIcon()}</button><h1>${title}</h1><span class="sheet-actions">${trailing}</span></header>`;
}

function renderVendors(): void {
  const destination = state.config?.kind === "filesystem"
    ? "your local Downloads folder"
    : state.config?.kind === "igdrasil" ? "your connected Igdrasil company" : "the destination you select";
  const showGuidance = !state.vendorGuidanceSeen || state.forceGuidance;
  // Collapsed by default. It answers a question a person may not have yet, and
  // expanded it pushed the vendors — and their buttons — below the fold.
  const guidance = showGuidance ? `<details class="guidance" ${state.forceGuidance ? "open" : ""}>
    <summary>${chevronIcon()} How Ratatosk Connects</summary>
    <div class="guidance-body">
      <ul><li>Uses your Chrome session, only for vendors you pick.</li><li>Invoices go to ${esc(destination)}.</li><li>No passwords or cookies are stored.</li></ul>
      <div class="guidance-actions"><button type="button" class="btn tonal sm" data-action="dismiss-vendor-guidance">Got It</button></div>
    </div>
  </details>` : "";

  const visibleSources = state.attentionOnly ? state.sources.filter(sourceNeedsAttention) : state.sources;
  const rows = visibleSources.map((source) => {
    const connection = source.connection;
    const isBusy = state.busyVendorId === source.id;
    let sub = source.kind === "discovered" ? new URL(source.primaryOrigin).hostname : categoryLabel(source.category);
    let action = source.runnable
      ? `<button type="button" class="btn tonal sm" data-action="connect" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}" ${isBusy ? "disabled" : ""}>${isBusy ? "Connecting…" : "Connect"}</button>`
      : `<button type="button" class="btn tonal sm" disabled aria-describedby="vendor-status-${esc(source.id)}">Unavailable</button>`;
    let secondaryAction = `<span class="action-spacer" aria-hidden="true"></span>`;
    // A row is a status plus a button. The button says what to do, so the status
    // only has to say what is true — not repeat the instruction.
    if (connection && source.missingHosts.length > 0) {
      sub = "New site access needed";
      action = `<button type="button" class="btn warn sm" data-action="connect" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}" ${isBusy ? "disabled" : ""}>${isBusy ? "Reviewing…" : "Review Access"}</button>`;
    } else if (connection?.lastStatus === "auth_expired") {
      sub = "Signed out of this vendor";
      action = `<button type="button" class="btn warn sm" data-action="connect" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}" ${isBusy ? "disabled" : ""}>${isBusy ? "Connecting…" : "Reconnect"}</button>`;
    } else if (connection) {
      const count = connection.lastCount ?? 0;
      const synced = relTime(connection.lastCompleteSyncAt ?? connection.lastRunAt);
      sub = connection.lastStatus === "ok" && connection.lastCode === "month_range_fallback_all"
        ? `${count > 0 ? `${count} collected` : "No new invoices"} · all history checked, no invoice dates`
        : connection.lastStatus === "partial"
          ? `${count > 0 ? `${count} collected` : "No new invoices"} · ${connection.lastFailedScopes ?? 0} account scope${connection.lastFailedScopes === 1 ? "" : "s"} skipped`
        : connection.lastStatus === "rate_limited"
          ? `Paused by vendor · resumes ${relTime(connection.nextEligibleRunAt)}`
          : connection.lastStatus === "error"
        ? connection.lastError ? `Sync failed — ${connection.lastError}` : "Sync failed"
        : count > 0 ? `${count} collected · ${synced}` : `Connected · ${synced}`;
      action = `<button type="button" class="btn outline sm" data-action="sync" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}">Sync</button>`;
    }
    const error = state.inlineError?.scope === "vendor" && state.inlineError.vendorId === source.id
      ? `<div class="inline-error" id="vendor-error-${esc(source.id)}" role="alert" tabindex="-1">${esc(state.inlineError.message)}</div>` : "";
    if (connection) {
      const diagnostic = connection.lastStatus && connection.lastStatus !== "ok"
        ? `<button type="button" data-action="copy-diagnostic" data-id="${esc(source.id)}">Copy details</button>`
        : "";
      secondaryAction = `<details class="vendor-menu"><summary aria-label="More actions for ${esc(source.name)}">${moreIcon()}</summary><div class="vendor-menu-items">${diagnostic}<button type="button" data-action="forget-history" data-id="${esc(source.id)}">Forget history</button><button type="button" class="danger" data-action="disconnect" data-id="${esc(source.id)}">Disconnect</button></div></details>`;
    }
    const lifecycle = source.kind === "discovered"
      ? `<div class="vlifecycle"><span class="local-badge">Discovered · this browser</span></div>`
      : source.lifecycle?.stage === "pilot"
        ? ""
      : `<div class="vlifecycle">${esc(source.lifecycle ? vendorLifecycleLabel(source.lifecycle) : "Unavailable")}</div>`;
    return `<li class="vrow">${logo(source.icon, source.name)}<div class="mid"><div class="vn">${esc(source.name)}</div>${lifecycle}<div class="vs" id="vendor-status-${esc(source.id)}">${esc(sub)}</div>${error}</div><div class="actions">${action}${secondaryAction}</div></li>`;
  }).join("");

  const infoButton = state.vendorGuidanceSeen && !showGuidance
    ? `<button type="button" class="icon-btn" data-action="show-vendor-guidance" aria-label="How vendor connections work">${infoIcon()}</button>` : "";
  const attentionHeader = state.attentionOnly
    ? `<div class="attention-filter" role="status"><span>Showing vendors that need attention</span><button type="button" class="quiet-link compact" data-action="show-all-vendors">Show All</button></div>`
    : "";
  const missingSupplier = discoveryCard();
  replaceApp(`${sheetHeader(state.attentionOnly ? "Vendor Attention" : "Vendors", infoButton)}${attentionHeader}${guidance}<ul class="vendor-list">${rows}</ul>${missingSupplier}`);
}

function discoveryCard(): string {
  const discovery = state.discovery;
  const page = state.activeSupplierTab;
  if (discovery.stage === "scanning") {
    return `<aside class="supplier-request discovery-progress" role="status"><span class="discovery-spinner" aria-hidden="true"></span><span class="supplier-request-copy"><strong>Searching ${esc(new URL(discovery.origin).hostname)}…</strong></span><button type="button" class="quiet-link compact" data-action="cancel-discovery">Cancel</button></aside>`;
  }
  if (discovery.stage === "preview") {
    const sites = discovery.requiredOrigins.length;
    const hostnames = discovery.requiredOrigins.map((pattern) => new URL(pattern.slice(0, -2)).hostname).join(", ");
    const clues = discovery.candidateCount;
    // Access is what the person is granting, so it is stated where they grant
    // it. A token exchange changes what Ratatosk holds during a run, and that
    // belongs on this card rather than only in the security notes.
    const sessionToken = discovery.usesSessionToken
      ? `<small class="discovery-consent">Uses the sign-in token ${esc(discovery.name)} issues to itself. Re-read each time, never stored.</small>`
      : "";
    return `<aside class="supplier-request discovery-found" aria-labelledby="supplier-request-title"><span class="supplier-request-mark letter" aria-hidden="true">${esc(discovery.name.charAt(0).toUpperCase())}</span><span class="supplier-request-copy"><strong id="supplier-request-title">Invoice source found</strong><small>${esc(discovery.name)} · ${clues} invoice clue${clues === 1 ? "" : "s"} · ${sites} site${sites === 1 ? "" : "s"}</small><small class="discovery-hosts">Access: ${esc(hostnames)}</small>${sessionToken}</span><span class="discovery-actions"><button type="button" class="supplier-request-link" data-action="connect-discovery" data-id="${esc(discovery.vendorId)}">Connect &amp; Collect</button><button type="button" class="quiet-link compact" data-action="cancel-discovery">Cancel</button></span></aside>`;
  }
  if (discovery.stage === "connecting") {
    return `<aside class="supplier-request discovery-progress" role="status"><span class="discovery-spinner" aria-hidden="true"></span><span class="supplier-request-copy"><strong>Verifying a real PDF…</strong><small>${esc(discovery.name)} is saved only if one arrives.</small></span></aside>`;
  }
  if (discovery.stage === "complete") {
    const fallback = discovery.monthFallbackAll ? " All history checked, no invoice dates." : "";
    // No dismissal to perform: the supplier is already in the list above with
    // this same count, so the card retires itself. See `scheduleSuccessDismiss`.
    scheduleSuccessDismiss();
    return `<aside class="supplier-request discovery-complete" role="status"><span class="supplier-request-mark success" aria-hidden="true">✓</span><span class="supplier-request-copy"><strong>${esc(discovery.name)} connected</strong><small>${discovery.count} invoice${discovery.count === 1 ? "" : "s"} collected.${fallback}</small></span></aside>`;
  }
  if (discovery.stage === "failed") {
    const emptyResult = discovery.reason === "not_found" || discovery.reason === "limit_reached";
    const title = emptyResult ? "No invoices found" : "Couldn’t check this supplier";
    // The finite reason belongs in the copyable diagnostic, not in three lines
    // of prose above the button that retries.
    const detail = emptyResult
      ? "This account may not include billing access."
      : discovery.message;
    const diagnostic = discovery.diagnosticAvailable
      ? `<button type="button" class="quiet-link compact" data-action="copy-discovery-diagnostic">Copy details</button>`
      : "";
    return `<aside class="supplier-request discovery-failed" role="${emptyResult ? "status" : "alert"}"><span class="supplier-request-mark" aria-hidden="true">${emptyResult ? "–" : "!"}</span><span class="supplier-request-copy"><strong>${title}</strong><small>${esc(detail)}</small></span><span class="discovery-actions"><button type="button" class="supplier-request-link" data-action="retry-discovery">${emptyResult ? "Search Again" : "Try Again"}</button>${diagnostic}</span></aside>`;
  }
  if (state.config && !page && !state.tabAwarenessEnabled) {
    return `<aside class="supplier-request tab-awareness" aria-labelledby="tab-awareness-title"><span class="supplier-request-mark" aria-hidden="true">${branchIcon()}</span><span class="supplier-request-copy"><strong id="tab-awareness-title">Find invoices on this site</strong><small>Chrome will ask once to recognize your active tab.</small></span><span class="discovery-actions"><button type="button" class="supplier-request-link" data-action="enable-tab-awareness" ${state.tabAwarenessRequestPending ? "disabled" : ""}>${state.tabAwarenessRequestPending ? "Preparing…" : "Find Invoices"}</button></span></aside>`;
  }
  const listed = page ? state.sources.find((source) => source.primaryOrigin === page.origin) : undefined;
  if (listed) {
    const connected = Boolean(listed.connection);
    return `<aside class="supplier-request"><span class="supplier-request-mark letter" aria-hidden="true">${esc(listed.name.charAt(0).toUpperCase())}</span><span class="supplier-request-copy"><strong>${esc(listed.name)} is already listed</strong><small>${connected ? "Collect from this signed-in session." : `Connect to collect from ${page!.hostname}.`}</small></span><button type="button" class="supplier-request-link" data-action="${connected ? "sync" : "connect"}" data-id="${esc(listed.id)}">${connected ? "Sync Now" : "Connect"}</button></aside>`;
  }
  const ready = Boolean(state.config && page);
  const detail = !state.config
    ? "Choose a destination first."
    : page ? `Search ${page.hostname}.` : "Open an HTTPS supplier app first.";
  return `<aside class="supplier-request" aria-labelledby="supplier-request-title"><span class="supplier-request-mark" aria-hidden="true">${branchIcon()}</span><span class="supplier-request-copy"><strong id="supplier-request-title">Supplier not listed?</strong><small>${esc(detail)}</small></span><button type="button" class="supplier-request-link" data-action="try-discovery" ${ready ? "" : "disabled"}>Find Invoices</button></aside>`;
}

/**
 * Clear the completed run without making the person acknowledge it.
 *
 * Confirmation is the card's whole job, and the supplier row above it already
 * carries the same name and count permanently. Requiring a click to get back
 * to the list turned a finished task into an outstanding one.
 *
 * Armed once per completed run: `retiredSuccessVendorId` keeps a re-render from
 * restarting the timer, and the background copy expires on its own shortly
 * after, so a panel closed before the timer fires does not reopen to the card.
 */
function scheduleSuccessDismiss(): void {
  const discovery = state.discovery;
  if (discovery.stage !== "complete") return;
  if (successDismissTimer || retiredSuccessVendorId === discovery.vendorId) return;
  const vendorId = discovery.vendorId;
  successDismissTimer = setTimeout(() => {
    successDismissTimer = undefined;
    retiredSuccessVendorId = vendorId;
    void (async () => {
      try {
        await send({ type: "dismissDiscovery" });
        await load();
      } catch {
        // The card expires in the background regardless; a failed refresh here
        // is not worth an error in front of a run that succeeded.
      }
    })();
  }, SUCCESS_CARD_MS);
}

function renderSettings(): void {
  const config = state.config;
  const kind = config?.kind ?? "unconfigured";
  const filesystemConfig = config?.kind === "filesystem" ? config : null;
  const filesystemChecked = kind === "filesystem" ? "checked" : "";

  const destinationFields = filesystemConfig
    ? `<div class="fields"><div class="field wide"><label for="folder">Folder</label><input id="folder" name="folder" autocomplete="off" spellcheck="false" maxlength="200" placeholder="Accounting/Invoices" data-field="folder" value="${esc(filesystemConfig.rootFolder)}" aria-describedby="folder-path" /></div><p class="save-path" id="folder-path">Saves to <code>${esc(savePath(filesystemConfig.rootFolder))}</code>/supplier/date<span class="save-path-note">Use <code>/</code> to nest. Chrome only lets extensions write inside Downloads.</span></p><div class="field"><label for="date-mode">Folders By</label><select id="date-mode" name="dateMode" autocomplete="off" data-field="datemode"><option value="extraction" ${filesystemConfig.dateMode === "extraction" ? "selected" : ""}>Date Collected</option><option value="invoice" ${filesystemConfig.dateMode === "invoice" ? "selected" : ""}>Invoice Date</option></select></div></div>`
    : kind === "igdrasil"
      ? `<div class="callout"><strong>Connected through Igdrasil.</strong> Manage it from the Igdrasil web app.</div>`
      : `<div class="callout"><strong>Choose a destination first.</strong> Nothing is fetched or saved until you do.</div>`;
  const error = state.inlineError?.scope === "settings"
    ? `<div class="inline-error settings-error" id="settings-error" role="alert" tabindex="-1">${esc(state.inlineError.message)}</div>` : "";
  const tabAwareness = state.tabAwarenessEnabled
    ? `<div class="context-access"><span><strong>Recognizing supplier tabs</strong><small>Only the current tab URL is read. Nothing is stored.</small></span><button type="button" class="btn outline sm" data-action="disable-tab-awareness">Turn Off</button></div>`
    : `<div class="context-access"><span><strong>Recognize supplier tabs</strong><small>Chrome calls this permission “Read your browsing history.” Only the current tab URL is read.</small></span><button type="button" class="btn tonal sm" data-action="enable-tab-awareness" ${state.tabAwarenessRequestPending ? "disabled" : ""}>${state.tabAwarenessRequestPending ? "Preparing…" : "Enable"}</button></div>`;

  replaceApp(`${sheetHeader("Settings")}
    <form class="settings-form">
      <fieldset class="grp"><legend>Save Invoices To</legend><div class="opts">
        <label class="opt"><input type="radio" name="destination" value="filesystem" ${filesystemChecked} /><span class="radio" aria-hidden="true"></span><span><strong>This Computer</strong><small>Downloads folder</small></span></label>
        <button type="button" class="opt opt-link ${kind === "igdrasil" ? "selected" : ""}" data-action="${kind === "igdrasil" ? "manage-igdrasil" : "connect-igdrasil"}"><span class="radio" aria-hidden="true"></span><span><strong>Igdrasil Accounting</strong><small>${kind === "igdrasil" ? "Connected · invoices go to your inbox" : "Connect or create an Igdrasil account"}</small></span><span class="open-label">${kind === "igdrasil" ? "Manage" : "Connect"}</span></button>
      </div>${destinationFields}${error}</fieldset>
      <fieldset class="grp divider"><legend>Check for New Invoices</legend>${scheduleControls()}</fieldset>
      <fieldset class="grp divider"><legend>Browser Context</legend>${tabAwareness}</fieldset>
    </form>
    <p class="foot">Runs while Chrome is open. If it is closed, Ratatosk catches up next time.</p>`);
}

/**
 * The schedule, stated as a calendar rather than an interval.
 *
 * "Every 12 hours" is a machine's way of saying it. A person filing invoices
 * thinks in days of the week and days of the month, so the cadence and the day
 * it lands on are chosen separately, and the exact next run is spelled out
 * underneath rather than left to be inferred.
 */
function scheduleControls(): string {
  const schedule = state.schedule.schedule;
  const modeOption = (label: string, value: SyncSchedule["mode"]) =>
    `<label><input type="radio" name="schedule-mode" value="${value}" ${schedule.mode === value ? "checked" : ""} /><span>${label}</span></label>`;

  const dayPicker = schedule.mode === "weekly"
    ? menuSelect({
        label: "Day of the week to sync",
        action: "set-schedule-weekday",
        current: String(schedule.weekday),
        options: weekdayNames().map((name, index) => ({ value: String(index), label: name })),
      })
    : schedule.mode === "monthly"
      ? menuSelect({
          label: "Day of the month to sync",
          action: "set-schedule-monthday",
          current: String(schedule.day),
          options: Array.from({ length: 31 }, (_value, index) => ({ value: String(index + 1), label: ordinalDay(index + 1) })),
        })
      : "";

  const dayRow = dayPicker ? `<div class="schedule-day"><span>On</span>${dayPicker}</div>` : "";
  // Only surfaced once it can actually bite, so the common choices stay silent.
  const shortMonths = schedule.mode === "monthly" && schedule.day > 28
    ? `<p class="schedule-note">Months without a ${ordinalDay(schedule.day)} use their last day.</p>`
    : "";
  const next = schedule.mode !== "off" && state.schedule.nextRunAt
    ? `<p class="schedule-next">Next check ${esc(nextRunLabel(state.schedule.nextRunAt))}</p>`
    : "";

  return `<div class="seg">${modeOption("Off", "off")}${modeOption("Daily", "daily")}${modeOption("Weekly", "weekly")}${modeOption("Monthly", "monthly")}</div>${dayRow}${shortMonths}${next}`;
}

/** The chosen day, with the weekday and time it resolves to. */
function nextRunLabel(timestamp: number): string {
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(timestamp));
  return `${when} · ${relTime(timestamp)}`;
}

/**
 * A listbox that looks like the rest of the panel.
 *
 * A native `<select>` renders as an OS menu that ignores the panel's type and
 * colour, and a date input would offer a calendar for what is a recurring day,
 * not a date. `<details>` supplies the open/close, dismissal and Escape
 * handling the platform already does well; the options carry listbox semantics
 * on top so the control is announced and driven as one.
 */
function menuSelect(input: {
  label: string;
  action: string;
  current: string;
  options: readonly { value: string; label: string }[];
}): string {
  const selectedLabel = input.options.find((option) => option.value === input.current)?.label
    ?? input.options[0]?.label ?? "";
  const options = input.options.map((option) => {
    const selected = option.value === input.current;
    return `<button type="button" role="option" aria-selected="${selected}" class="menu-option${selected ? " selected" : ""}" data-action="${esc(input.action)}" data-value="${esc(option.value)}"><span class="menu-check" aria-hidden="true">${selected ? checkIcon() : ""}</span>${esc(option.label)}</button>`;
  }).join("");
  return `<details class="menu-select"><summary aria-label="${esc(input.label)}"><span class="menu-value">${esc(selectedLabel)}</span>${chevronIcon()}</summary><div class="menu-options" role="listbox" aria-label="${esc(input.label)}">${options}</div></details>`;
}

/** Put focus back after a re-render replaced the control that was just used. */
function restoreFocusTo(selector: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
}

/** Close an open menu and hand focus back to the control that opened it. */
function closeMenuSelect(): void {
  const open = document.querySelector<HTMLDetailsElement>(".menu-select[open]");
  if (!open) return;
  open.open = false;
  open.querySelector<HTMLElement>("summary")?.focus();
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
  if (action === "discover-here") {
    // The search reports progress on the vendors screen, so move there before
    // it renders — and stay inside the click activation Chrome needs to prompt.
    screen = "vendors";
    state.attentionOnly = false;
    persistPanelUiState();
    void discoverFromUserGesture();
    return;
  }
  if (action === "retry-discovery") {
    void retryDiscovery();
    return;
  }
  if (action === "connect-discovery" && vendorId) {
    openSyncDialog({ kind: "discovery", vendorId });
    return;
  }
  if (action === "set-schedule-weekday" || action === "set-schedule-monthday") {
    const value = Number(element.dataset.value);
    closeMenuSelect();
    // The re-render replaces the menu, so focus is put back on the control that
    // was just used rather than dropped to the document.
    void updateSchedule(action === "set-schedule-weekday"
      ? { mode: "weekly", weekday: value }
      : { mode: "monthly", day: value },
    ).then(() => restoreFocusTo(".menu-select summary"));
    return;
  }
  if (action === "set-ledger-range") {
    const filter = element.dataset.range;
    if (filter === "all" || filter === "30d" || filter === "90d" || filter === "year") {
      state.ledgerDateFilter = filter;
      persistPanelUiState();
      renderHome();
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".date-filter summary")?.focus());
    }
    return;
  }
  void handle(action, vendorId);
});

app.addEventListener("change", (event) => {
  const element = event.target as HTMLInputElement | HTMLSelectElement;
  if (element.dataset.field) {
    void saveField(element.dataset.field, element.value);
    return;
  }
  if (element instanceof HTMLInputElement && element.name === "schedule-mode") {
    const mode = element.value;
    void updateSchedule(scheduleForMode(mode))
      .then(() => restoreFocusTo(`input[name="schedule-mode"][value="${CSS.escape(mode)}"]`));
  } else if (element instanceof HTMLInputElement && element.name === "destination" && element.value === "filesystem") {
    void switchToFilesystem();
  }
});

// The path is the point of the field, so it resolves while typing rather than
// waiting for the value to be committed on blur.
app.addEventListener("input", (event) => {
  const element = event.target;
  if (!(element instanceof HTMLInputElement) || element.dataset.field !== "folder") return;
  const preview = document.querySelector<HTMLElement>("#folder-path code");
  if (preview) preview.textContent = savePath(element.value || "Ratatosk");
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

async function connectDiscoveryFromUserGesture(vendorId: string, fromMonth?: string): Promise<void> {
  const discovery = state.discovery;
  if (discovery.stage !== "preview" || discovery.vendorId !== vendorId) return;
  const prepared = send({
    type: "beginDiscoveryConnect",
    vendorId,
    ...(fromMonth ? { fromMonth } : {}),
  });
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
    await load();
    if (!response.ok && (state.discovery as DiscoveryStatusView).stage !== "complete") toast(response.error);
    else if (response.ok && "summaries" in response && response.summaries.length) {
      showRunCompletion(response.summaries);
    }
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
    case "open-vendors": screen = "vendors"; state.attentionOnly = false; state.inlineError = null; persistPanelUiState(); render(); return;
    case "open-attention": screen = "vendors"; state.attentionOnly = true; state.inlineError = null; persistPanelUiState(); render(); return;
    case "show-all-vendors": state.attentionOnly = false; renderVendors(); return;
    case "home": screen = "home"; state.attentionOnly = false; state.inlineError = null; persistPanelUiState(); await load(); return;
    case "retry-load": await load(); return;
    case "sync": openSyncDialog({ kind: "connected", vendorId: vendorId! }); return;
    case "sync-all": openSyncDialog({ kind: "connected" }); return;
    case "disconnect": openDisconnectDialog(vendorId!); return;
    case "forget-history": openHistoryDialog(vendorId!); return;
    case "disable-tab-awareness": await disableTabAwareness(); return;
    case "copy-diagnostic": await copyVendorDiagnostic(vendorId!); return;
    case "copy-discovery-diagnostic": await copyDiscoveryDiagnostic(); return;
    case "connect-igdrasil": await openIgdrasilConnect(); return;
    case "manage-igdrasil": await chrome.tabs.create({ url: "https://accounting.igdrasil.se/integrations/invoice-collector" }); return;
    case "cancel-discovery":
      await send({ type: "cancelDiscovery" });
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
      showRunCompletion(response.summaries);
    }
    await load();
  } catch (error) {
    console.error("[collector] side panel action failed", error);
    if (vendorId) sourceError(vendorId, "Ratatosk couldn’t reach the background process. Reopen the extension and try again.");
    else toast("Couldn’t finish. Reopen Ratatosk and try again.");
  }
}

function showRunCompletion(summaries: readonly VendorRunSummary[]): void {
  const collected = summaries.reduce((count, summary) =>
    count + (summary.status === "ok" || summary.status === "partial" ? summary.count : 0), 0);
  const waiting = summaries.find((summary) => summary.status === "rate_limited" || summary.status === "skipped");
  const expired = summaries.find((summary) => summary.status === "auth_expired");
  const failed = summaries.find((summary) => summary.status === "error");
  const fallbackCount = summaries.filter((summary) => summary.code === "month_range_fallback_all").length;
  const bounded = summaries.find((summary) => summary.syncWindow?.mode === "bounded");
  const attention = summaries.filter((summary) =>
    summary.status !== "ok" && summary.status !== "partial").length;

  if (collected && fallbackCount) {
    toast(`Collected ${collected} Invoice${collected === 1 ? "" : "s"} · used all history for ${fallbackCount} supplier${fallbackCount === 1 ? "" : "s"} because invoice dates were unavailable`);
  } else if (collected) {
    toast(`Collected ${collected} Invoice${collected === 1 ? "" : "s"}${attention ? ` · ${attention} need attention` : ""}`);
  } else if (waiting) {
    toast(`Supplier asked Ratatosk to wait until ${relTime(waiting.nextEligibleRunAt)}`);
  } else if (expired) {
    toast("Session expired — sign in to the supplier and reconnect");
  } else if (failed?.error) {
    toast(failed.error);
  } else if (fallbackCount) {
    toast(`Checked all available history for ${fallbackCount} supplier${fallbackCount === 1 ? "" : "s"} because invoice dates were unavailable · no new invoices`);
  } else if (bounded?.syncWindow) {
    toast(`No new invoices from ${monthLabel(bounded.syncWindow.range.fromMonth)}`);
  } else {
    toast("No New Invoices");
  }
}

function openSyncDialog(target: CollectionTarget): void {
  pendingSyncTarget = target;
  const now = new Date();
  syncFromMonth.value = "";
  syncFromMonth.max = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  syncDialog.showModal();
  requestAnimationFrame(() => syncFromMonth.focus());
}

confirmSync.addEventListener("click", () => {
  if (!pendingSyncTarget || !syncFromMonth.reportValidity()) return;
  const target = pendingSyncTarget;
  const fromMonth = syncFromMonth.value || undefined;
  syncDialog.close();
  pendingSyncTarget = null;
  if (target.kind === "discovery") {
    void connectDiscoveryFromUserGesture(target.vendorId, fromMonth);
    return;
  }
  const message: Extract<Parameters<typeof send>[0], { type: "runNow" }> = {
    type: "runNow",
    ...(target.vendorId ? { vendorId: target.vendorId } : {}),
    ...(fromMonth ? { fromMonth } : {}),
  };
  void run(message, target.vendorId);
});

cancelSync.addEventListener("click", () => syncDialog.close());
syncDialog.addEventListener("close", () => { pendingSyncTarget = null; });

function monthLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

async function retryDiscovery(): Promise<void> {
  await send({ type: "cancelDiscovery" });
  await discoverFromUserGesture();
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

/**
 * Switching cadence keeps the day already chosen where it still applies, so
 * moving weekly → monthly → weekly does not silently reset it.
 */
function scheduleForMode(mode: string): SyncSchedule {
  const current = state.schedule.schedule;
  if (mode === "weekly") {
    return { mode: "weekly", weekday: current.mode === "weekly" ? current.weekday : new Date().getDay() };
  }
  if (mode === "monthly") {
    return { mode: "monthly", day: current.mode === "monthly" ? current.day : 1 };
  }
  return mode === "daily" ? { mode: "daily" } : { mode: "off" };
}

async function updateSchedule(schedule: SyncSchedule): Promise<void> {
  const response = await send({ type: "setSchedule", schedule });
  if (!response.ok) {
    settingsError(response.error);
    return;
  }
  toast(schedule.mode === "off" ? "Auto-Sync Turned Off" : `Auto-Sync · ${syncScheduleLabel(schedule)}`);
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
  if (config?.kind === "filesystem") return savePath(config.rootFolder);
  if (config?.kind === "igdrasil") return "Igdrasil Accounting";
  if (config?.kind === "http") return "Connected Accounting App";
  return "Not Selected";
}

/**
 * Name the destination as a path a person can go and open.
 *
 * The absolute directory is only knowable once a download has revealed it, so
 * until then this says `Downloads/…` — which is where Chrome puts extension
 * downloads regardless of what that folder is called on this machine.
 */
function savePath(rootFolder: string): string {
  const folders = folderPath(rootFolder);
  return state.downloadRoot ? `${state.downloadRoot}/${folders}` : `Downloads/${folders}`;
}

function ledgerDateFilter(): string {
  const filters: LedgerDateFilter[] = ["all", "30d", "90d", "year"];
  const options = filters.map((filter) => {
    const selected = state.ledgerDateFilter === filter;
    return `<button type="button" class="date-filter-option${selected ? " selected" : ""}" data-action="set-ledger-range" data-range="${filter}" aria-pressed="${selected}"><span aria-hidden="true">${selected ? checkIcon() : ""}</span>${ledgerDateFilterLabel(filter)}</button>`;
  }).join("");
  return `<details class="date-filter"><summary aria-label="Filter invoices by date">${filterIcon()}<span>${ledgerDateFilterLabel(state.ledgerDateFilter)}</span>${chevronIcon()}</summary><div class="date-filter-options">${options}</div></details>`;
}

function closeDateFilter(restoreFocus = false): void {
  const details = document.querySelector<HTMLDetailsElement>(".date-filter[open]");
  if (!details) return;
  details.open = false;
  if (restoreFocus) details.querySelector<HTMLElement>("summary")?.focus();
}

document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (target instanceof Node && !document.querySelector(".date-filter")?.contains(target)) closeDateFilter();
  if (target instanceof Node) {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>(".vendor-menu[open]")) {
      if (!menu.contains(target)) menu.open = false;
    }
    for (const menu of document.querySelectorAll<HTMLDetailsElement>(".menu-select[open]")) {
      if (!menu.contains(target)) menu.open = false;
    }
  }
});

// A listbox is driven with the arrow keys, and 31 days are far too many to
// reach by tabbing. Home/End matter most in the month list, where the useful
// choices sit at both ends.
app.addEventListener("keydown", (event) => {
  const option = (event.target as HTMLElement).closest<HTMLElement>(".menu-option");
  if (!option) return;
  const options = [...option.closest(".menu-options")!.querySelectorAll<HTMLElement>(".menu-option")];
  const index = options.indexOf(option);
  const next = event.key === "ArrowDown" ? index + 1
    : event.key === "ArrowUp" ? index - 1
    : event.key === "Home" ? 0
    : event.key === "End" ? options.length - 1
    : -1;
  if (next < 0 || next >= options.length) return;
  event.preventDefault();
  options[next].focus();
});

// Opening a menu puts the keyboard on the current value, not the first option —
// otherwise choosing "the 28th" starts 27 keystrokes away.
app.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("menu-select") || !details.open) return;
  const selected = details.querySelector<HTMLElement>(".menu-option.selected") ?? details.querySelector<HTMLElement>(".menu-option");
  selected?.scrollIntoView({ block: "nearest" });
  requestAnimationFrame(() => selected?.focus());
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeDateFilter(true);
  closeMenuSelect();
  const menu = document.querySelector<HTMLDetailsElement>(".vendor-menu[open]");
  if (menu) {
    menu.open = false;
    menu.querySelector<HTMLElement>("summary")?.focus();
  }
});

// ---- inline icons ---------------------------------------------------------

function gearIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/></svg>`; }
function backIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>`; }
function chevronIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>`; }
function infoIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>`; }
function branchIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="6" r="2.2"/><circle cx="17" cy="8" r="2.2"/><circle cx="7" cy="18" r="2.2"/><path d="M7 8.2v7.6M9.2 8h3.3A4.5 4.5 0 0 1 17 12.5v2.3"/></svg>`; }
function filterIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M5.5 10h9M8 15h4"/></svg>`; }
function checkIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 8 3 3 7-7"/></svg>`; }
function moreIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`; }

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
