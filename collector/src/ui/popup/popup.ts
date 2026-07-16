/**
 * Ratatosk Collector popup. Framework-free and intentionally small: state comes
 * from the service worker and each screen renders semantic native controls.
 */
import { send, type ScheduleInfo, type SourceView } from "../../platform/messaging";
import type { LedgerEntry } from "../../platform/storage";
import { vendorLifecycleLabel } from "../../../../src/vendors/lifecycle";
import { requestHostPermissions } from "../../platform/permissions";
import { clearConnectBadge } from "../../platform/popup-handoff";
import { brandIcon } from "../../../../src/vendors/icons";

type Screen = "home" | "vendors" | "settings";
type InlineError = { scope: "vendor"; vendorId: string; message: string } | { scope: "settings"; message: string };

const app = document.getElementById("app") as HTMLElement;
const toastEl = document.getElementById("toast") as HTMLElement;
const disconnectDialog = document.getElementById("disconnect-dialog") as HTMLDialogElement;
const disconnectName = document.getElementById("disconnect-name") as HTMLElement;
const confirmDisconnect = document.getElementById("confirm-disconnect") as HTMLButtonElement;
const cancelDisconnect = document.getElementById("cancel-disconnect") as HTMLButtonElement;
const VENDOR_GUIDANCE_SEEN = "ui.vendorGuidanceSeen.v1";
const ADD_SUPPLIER_URL = "https://github.com/Igdrasil-AB/ratatosk#download-studio-to-add-a-new-supplier";

let screen: Screen = "home";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let disconnectVendorId: string | null = null;
const state = {
  sources: [] as SourceView[],
  ledger: [] as LedgerEntry[],
  config: null as Awaited<ReturnType<typeof getConfig>>,
  schedule: { periodMinutes: null, nextRunAt: null } as ScheduleInfo,
  vendorGuidanceSeen: false,
  forceGuidance: false,
  busyVendorId: null as string | null,
  inlineError: null as InlineError | null,
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

const getConfig = () => send({ type: "getConfig" }).then((response) => (
  response.ok && "config" in response ? response.config : null
));

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

// ---- load + render --------------------------------------------------------

async function load(): Promise<void> {
  try {
    const [sourceResponse, ledgerResponse, config, scheduleResponse, ui] = await Promise.all([
      send({ type: "listSources" }),
      send({ type: "getLedger" }),
      getConfig(),
      send({ type: "getSchedule" }),
      chrome.storage.local.get(VENDOR_GUIDANCE_SEEN),
    ]);
    state.sources = sourceResponse.ok && "sources" in sourceResponse ? sourceResponse.sources : [];
    state.ledger = ledgerResponse.ok && "ledger" in ledgerResponse ? ledgerResponse.ledger : [];
    state.config = config;
    state.schedule = scheduleResponse.ok && "schedule" in scheduleResponse
      ? scheduleResponse.schedule
      : { periodMinutes: null, nextRunAt: null };
    state.vendorGuidanceSeen = ui[VENDOR_GUIDANCE_SEEN] === true;
    render();
  } catch (error) {
    console.error("[collector] popup state failed to load", error);
    app.setAttribute("aria-busy", "false");
    app.innerHTML = `${header()}<section class="empty error-state"><h1>Ratatosk couldn’t load</h1><p>Close and reopen the extension, or try again now.</p><button class="btn" data-action="retry-load">Try Again</button></section>`;
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
    <button type="button" class="settings-btn" data-action="open-settings">${gearIcon()}<span>Settings</span></button>
  </header>`;
}

function renderHome(): void {
  const connected = state.sources.filter((source) => source.connection);
  const needsReconnect = connected.filter((source) => source.connection?.lastStatus === "auth_expired");

  let status = "";
  if (!state.config) {
    status = `<div class="status"><span class="dot warn" aria-hidden="true"></span><strong>Setup Required</strong><span class="sep" aria-hidden="true">·</span><button type="button" class="status-link" data-action="open-settings">Choose Destination</button></div>`;
  } else if (needsReconnect.length) {
    status = `<button type="button" class="status status-action" data-action="open-vendors"><span class="dot warn" aria-hidden="true"></span><strong>${needsReconnect.length} Vendor${needsReconnect.length > 1 ? "s" : ""} Need Reconnecting</strong><span aria-hidden="true">→</span></button>`;
  } else if (state.schedule.periodMinutes) {
    const synced = connected.map((source) => source.connection?.lastRunAt ?? 0).sort((left, right) => right - left)[0];
    status = `<div class="status" role="status"><span class="dot" aria-hidden="true"></span><strong>Up to Date</strong><span class="sep" aria-hidden="true">·</span><span>synced ${relTime(synced || undefined)}</span></div>`;
  }

  let body: string;
  if (state.ledger.length) {
    const newest = Math.max(...state.ledger.map((entry) => entry.collectedAt));
    const rows = state.ledger.map((entry) => {
      const fresh = entry.collectedAt >= newest - 60_000 ? '<span class="new" aria-label="New"></span>' : "";
      return `<li class="inv">${logo(iconFor(entry.vendorId), entry.vendorName)}<span class="name"><span class="text">${esc(entry.vendorName)}</span>${fresh}</span><time class="meta" datetime="${esc(entry.issuedAt?.slice(0, 10) ?? new Date(entry.collectedAt).toISOString())}">${invoiceDate(entry)}</time><span class="amt">${amount(entry.total, entry.currency)}</span></li>`;
    }).join("");
    body = `<ul class="feed" aria-label="Collected invoices">${rows}</ul><div class="add"><button type="button" class="ghost" data-action="open-vendors">Manage Vendors <span aria-hidden="true">→</span></button></div>`;
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
      <div class="guidance-actions"><span class="guidance-note">Only reviewed recipes are included.</span><button type="button" class="btn tonal sm" data-action="dismiss-vendor-guidance">Got It</button></div>
    </div>
  </details>` : "";

  const rows = state.sources.map((source) => {
    const connection = source.connection;
    const isBusy = state.busyVendorId === source.id;
    let sub = categoryLabel(source.category);
    let action = source.runnable
      ? `<button type="button" class="btn tonal sm" data-action="connect" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}" ${isBusy ? "disabled" : ""}>${isBusy ? "Connecting…" : "Connect"}</button>`
      : `<button type="button" class="btn tonal sm" disabled aria-describedby="vendor-status-${esc(source.id)}">Unavailable</button>`;
    let secondaryAction = `<span class="action-spacer" aria-hidden="true"></span>`;
    if (connection?.lastStatus === "auth_expired") {
      sub = "Session expired — sign in, then reconnect";
      action = `<button type="button" class="btn warn sm" data-action="connect" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}" ${isBusy ? "disabled" : ""}>${isBusy ? "Connecting…" : "Reconnect"}</button>`;
    } else if (connection) {
      const count = connection.lastCount ?? 0;
      sub = connection.lastStatus === "partial"
        ? `Collected ${count}; ${connection.lastFailedScopes ?? 0} account scope${connection.lastFailedScopes === 1 ? "" : "s"} need attention`
        : connection.lastStatus === "rate_limited"
          ? `Supplier asked Ratatosk to wait · resumes ${relTime(connection.nextEligibleRunAt)}`
          : connection.lastStatus === "error"
        ? connection.lastError ? `Couldn’t sync — ${connection.lastError}` : "Couldn’t sync — try again"
        : count > 0 ? `${count} collected · synced ${relTime(connection.lastRunAt)}` : `Connected · synced ${relTime(connection.lastRunAt)}`;
      action = `<button type="button" class="btn outline sm" data-action="sync" data-id="${esc(source.id)}" aria-describedby="vendor-status-${esc(source.id)}">Sync</button>`;
      secondaryAction = `<button type="button" class="icon-btn danger" data-action="disconnect" data-id="${esc(source.id)}" aria-label="Disconnect ${esc(source.name)}">${xIcon()}</button>`;
    }
    const error = state.inlineError?.scope === "vendor" && state.inlineError.vendorId === source.id
      ? `<div class="inline-error" id="vendor-error-${esc(source.id)}" role="alert" tabindex="-1">${esc(state.inlineError.message)}</div>` : "";
    const diagnostic = connection?.lastStatus && connection.lastStatus !== "ok"
      ? `<button type="button" class="diagnostic-link" data-action="copy-diagnostic" data-id="${esc(source.id)}">Copy diagnostic</button>` : "";
    return `<li class="vrow">${logo(source.icon, source.name)}<div class="mid"><div class="vn">${esc(source.name)}</div><div class="vlifecycle">${esc(vendorLifecycleLabel(source.lifecycle))}</div><div class="vs" id="vendor-status-${esc(source.id)}">${esc(sub)}</div>${diagnostic}${error}</div><div class="actions">${action}${secondaryAction}</div></li>`;
  }).join("");

  const infoButton = state.vendorGuidanceSeen && !showGuidance
    ? `<button type="button" class="icon-btn" data-action="show-vendor-guidance" aria-label="How vendor connections work">${infoIcon()}</button>` : "";
  const missingSupplier = `<aside class="supplier-request" aria-labelledby="supplier-request-title">
    <span class="supplier-request-mark" aria-hidden="true">${branchIcon()}</span>
    <span class="supplier-request-copy"><strong id="supplier-request-title">Can’t find your supplier?</strong><small>Help Ratatosk add it on GitHub.</small></span>
    <button type="button" class="supplier-request-link" data-action="open-add-supplier" aria-label="Open the Ratatosk supplier contribution guide on GitHub">GitHub${externalIcon()}</button>
  </aside>`;
  app.innerHTML = `${sheetHeader("Vendors", infoButton)}${guidance}<ul class="vendor-list">${rows}</ul>${missingSupplier}<p class="foot">Chrome may briefly hide this window while confirming vendor access. Setup continues safely in the background.</p>`;
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

  app.innerHTML = `${sheetHeader("Settings")}
    <form class="settings-form">
      <fieldset class="grp"><legend>Save Invoices To</legend><div class="opts">
        <label class="opt"><input type="radio" name="destination" value="filesystem" ${filesystemChecked} /><span class="radio" aria-hidden="true"></span><span><strong>This Computer</strong><small>Downloads folder</small></span></label>
        <button type="button" class="opt opt-link ${kind === "igdrasil" ? "selected" : ""}" data-action="${kind === "igdrasil" ? "manage-igdrasil" : "connect-igdrasil"}"><span class="radio" aria-hidden="true"></span><span><strong>Igdrasil Accounting</strong><small>${kind === "igdrasil" ? "Connected · invoices go to your inbox" : "Connect or create an Igdrasil account"}</small></span><span class="open-label">${kind === "igdrasil" ? "Manage" : "Connect"}</span></button>
      </div>${destinationFields}${error}</fieldset>
      <fieldset class="grp divider"><legend>Check for New Invoices</legend><div class="seg">${scheduleOption("Off", 0)}${scheduleOption("6h", 360)}${scheduleOption("12h", 720)}${scheduleOption("Daily", 1440)}</div></fieldset>
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
  void handle(action, vendorId);
});

app.addEventListener("change", (event) => {
  const element = event.target as HTMLInputElement | HTMLSelectElement;
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

async function connectFromUserGesture(vendorId: string): Promise<void> {
  if (!state.config) {
    screen = "settings";
    settingsError("Choose where invoices should be saved, then connect a vendor.");
    return;
  }
  const source = state.sources.find((candidate) => candidate.id === vendorId);
  if (!source) {
    sourceError(vendorId, "That vendor is no longer available. Reopen Ratatosk and try again.");
    return;
  }

  const prepared = send({ type: "beginConnect", vendorId });
  const permission = requestHostPermissions(source.hosts);
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

async function handle(action: string, vendorId?: string): Promise<void> {
  switch (action) {
    case "open-settings": screen = "settings"; state.inlineError = null; render(); return;
    case "open-vendors": screen = "vendors"; state.inlineError = null; render(); return;
    case "home": screen = "home"; state.inlineError = null; await load(); return;
    case "retry-load": await load(); return;
    case "sync": await run({ type: "runNow", vendorId: vendorId! }, vendorId); return;
    case "sync-all": await run({ type: "runNow" }); return;
    case "disconnect": openDisconnectDialog(vendorId!); return;
    case "copy-diagnostic": await copyVendorDiagnostic(vendorId!); return;
    case "connect-igdrasil": await openIgdrasilConnect(); return;
    case "manage-igdrasil": await chrome.tabs.create({ url: "https://accounting.igdrasil.se/integrations/invoice-collector" }); return;
    case "open-add-supplier":
      await chrome.tabs.create({ url: ADD_SUPPLIER_URL });
      window.close();
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
  window.close();
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
      if (waiting) toast(`Supplier asked Ratatosk to wait until ${relTime(waiting.nextEligibleRunAt)}`);
      else
      toast(collected ? `Collected ${collected} Invoice${collected === 1 ? "" : "s"}` : "No New Invoices");
    }
    await load();
  } catch (error) {
    console.error("[collector] popup action failed", error);
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

// ---- inline icons ---------------------------------------------------------

function gearIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1"/></svg>`; }
function backIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>`; }
function xIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>`; }
function chevronIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>`; }
function infoIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>`; }
function branchIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="6" r="2.2"/><circle cx="17" cy="8" r="2.2"/><circle cx="7" cy="18" r="2.2"/><path d="M7 8.2v7.6M9.2 8h3.3A4.5 4.5 0 0 1 17 12.5v2.3"/></svg>`; }
function externalIcon(): string { return `<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3.5H3.5v9h9V10M8.5 3.5h4v4M12.2 3.8 7 9"/></svg>`; }

void clearConnectBadge();
void load();
