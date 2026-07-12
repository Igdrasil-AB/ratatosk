/**
 * The popup — one screen (your invoices) with the machinery tucked behind a gear
 * and an "Add a vendor" action. Framework-free: it loads state from the service
 * worker and renders the current screen into #app; clicks are handled by
 * delegation on `data-action`.
 */
import { send, type RecorderProgress, type ScheduleInfo, type SourceView } from "../../platform/messaging";
import type { LedgerEntry } from "../../platform/storage";
import type { RecorderStopResult } from "../../platform/messaging";
import { brandIcon } from "../../vendors/icons";

type Screen = "home" | "vendors" | "settings" | "record";

const app = document.getElementById("app") as HTMLElement;
const toastEl = document.getElementById("toast") as HTMLElement;

let screen: Screen = "home";
const state = {
  sources: [] as SourceView[],
  ledger: [] as LedgerEntry[],
  config: null as Awaited<ReturnType<typeof getConfig>>,
  schedule: { periodMinutes: null, nextRunAt: null } as ScheduleInfo,
  recording: false,
  progress: { recording: false, captured: 0, documents: 0, detected: false } as RecorderProgress,
  result: null as RecorderStopResult | null,
};

let progressTimer: ReturnType<typeof setInterval> | undefined;

// ---- helpers --------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function logo(icon: string | undefined, name: string): string {
  const b = brandIcon(icon);
  if (b) return `<span class="logo"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${b.path}"/></svg></span>`;
  return `<span class="logo letter">${esc(name.charAt(0).toUpperCase())}</span>`;
}

function relTime(ts?: number | null): string {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function untilTime(ts?: number | null): string {
  if (!ts) return "—";
  const m = Math.round((ts - Date.now()) / 60000);
  if (m <= 1) return "soon";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
function amount(total?: string, currency?: string): string {
  if (!total) return "";
  const c = (currency ?? "").toUpperCase();
  if (SYMBOL[c]) return `${SYMBOL[c]}${total}`;
  return c === "SEK" ? `${total} kr` : `${total}${c ? " " + c : ""}`;
}

function invoiceDate(e: LedgerEntry): string {
  if (e.issuedAt && /^\d{4}-\d{2}-\d{2}/.test(e.issuedAt)) {
    const [, mo, d] = e.issuedAt.split("-");
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(mo) - 1];
    return `${month} ${Number(d)}`;
  }
  return relTime(e.collectedAt);
}

const getConfig = () => send({ type: "getConfig" }).then((r) => (r.ok && "config" in r ? r.config : null));

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1800);
}

// ---- load + render --------------------------------------------------------

async function load(): Promise<void> {
  const [srcR, ledR, cfg, schR, recR] = await Promise.all([
    send({ type: "listSources" }),
    send({ type: "getLedger" }),
    getConfig(),
    send({ type: "getSchedule" }),
    send({ type: "recorderStatus" }),
  ]);
  state.sources = srcR.ok && "sources" in srcR ? srcR.sources : [];
  state.ledger = ledR.ok && "ledger" in ledR ? ledR.ledger : [];
  state.config = cfg;
  state.schedule = schR.ok && "schedule" in schR ? schR.schedule : { periodMinutes: null, nextRunAt: null };
  state.recording = recR.ok && "recording" in recR ? recR.recording : false;
  // An active capture is modal: always resume onto the record screen when the
  // popup reopens (navigating to the billing page closes the popup mid-record).
  if (state.recording) {
    screen = "record";
    startProgress();
  }
  render();
}

// ---- live capture progress ------------------------------------------------

function startProgress(): void {
  stopProgress();
  progressTimer = setInterval(() => void pollProgress(), 1500);
  void pollProgress();
}

function stopProgress(): void {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = undefined;
}

async function pollProgress(): Promise<void> {
  const res = await send({ type: "recorderProgress" });
  if (!res.ok || !("progress" in res)) return;
  if (!res.progress.recording) { stopProgress(); state.recording = false; return void load(); }
  const changed = res.progress.captured !== state.progress.captured || res.progress.detected !== state.progress.detected;
  state.progress = res.progress;
  if (changed && screen === "record" && state.recording) renderRecord();
}

function render(): void {
  if (screen === "home") renderHome();
  else if (screen === "vendors") renderVendors();
  else if (screen === "settings") renderSettings();
  else renderRecord();
}

function header(): string {
  return `<div class="head">
    <span class="mark">${docIcon("var(--primary-fg)")}</span>
    <span class="title">Invoice Collector</span>
    <button class="icon-btn" data-action="open-settings" aria-label="Settings">${gearIcon()}</button>
  </div>`;
}

function renderHome(): void {
  const connected = state.sources.filter((s) => s.connection);
  const needsReconnect = connected.filter((s) => s.connection?.lastStatus === "auth_expired");

  let status: string;
  if (needsReconnect.length) {
    status = `<div class="status" data-action="open-vendors" style="cursor:pointer"><span class="dot warn"></span><b>${needsReconnect.length} vendor${needsReconnect.length > 1 ? "s" : ""} need reconnecting</b></div>`;
  } else if (state.schedule.periodMinutes) {
    const synced = connected.map((s) => s.connection?.lastRunAt ?? 0).sort((a, b) => b - a)[0];
    status = `<div class="status"><span class="dot"></span><b>Up to date</b><span class="sep">·</span><span>synced ${relTime(synced || undefined)}</span><span class="sep">·</span><span>next in <span class="n">${untilTime(state.schedule.nextRunAt)}</span></span></div>`;
  } else {
    status = `<div class="status"><span class="dot warn"></span><b>Auto-sync off</b><span class="sep">·</span><span data-action="open-settings" style="cursor:pointer;color:var(--primary)">turn on</span></div>`;
  }

  let body: string;
  if (state.ledger.length) {
    const newest = Math.max(...state.ledger.map((e) => e.collectedAt));
    const rows = state.ledger
      .map((e) => {
        const fresh = e.collectedAt >= newest - 60_000 ? '<span class="new"></span>' : "";
        return `<div class="inv">${logo(iconFor(e.vendorId), e.vendorName)}<span class="name"><span class="t">${esc(e.vendorName)}</span>${fresh}</span><span class="meta">${invoiceDate(e)}</span><span class="amt">${amount(e.total, e.currency)}</span></div>`;
      })
      .join("");
    body = `<div class="feed">${rows}</div>
      <div class="add"><button class="ghost" data-action="open-vendors">${plusIcon()} Add a vendor</button></div>`;
  } else if (connected.length) {
    body = `<div class="empty"><div class="h">No invoices collected yet</div><div class="p">Your connected vendors will fill this in on the next sync.</div><button class="btn" data-action="sync-all">Sync now</button></div>
      <div class="add"><button class="ghost" data-action="open-vendors">${plusIcon()} Manage vendors</button></div>`;
  } else {
    body = `<div class="empty">
      <span class="m">${docIcon("var(--primary-fg)")}</span>
      <div class="h">Your invoices, collected automatically.</div>
      <div class="p">Connect a service you're signed into. New invoices arrive on their own.</div>
      <button class="btn" data-action="open-vendors">Connect a vendor</button>
      <div class="fineprint">No passwords, ever.</div>
    </div>`;
  }

  app.innerHTML = header() + status + body;
}

function renderVendors(): void {
  const rows = state.sources
    .map((s) => {
      const c = s.connection;
      let sub = s.category ?? "";
      let action = `<button class="btn sm" data-action="connect" data-id="${s.id}">Connect</button>`;
      if (c?.lastStatus === "auth_expired") {
        sub = "Session expired — sign in to resume";
        action = `<button class="btn warn sm" data-action="connect" data-id="${s.id}">Reconnect</button>`;
      } else if (c) {
        const count = c.lastCount ?? 0;
        sub = c.lastStatus === "error" ? "Last sync had a problem" : count > 0 ? `${count} collected · synced ${relTime(c.lastRunAt)}` : `Connected · synced ${relTime(c.lastRunAt)}`;
        action = `<button class="btn outline sm" data-action="sync" data-id="${s.id}">Sync</button><button class="icon-btn danger" data-action="disconnect" data-id="${s.id}" aria-label="Remove ${esc(s.name)}">${xIcon()}</button>`;
      }
      return `<div class="vrow">${logo(s.icon, s.name)}<div class="mid"><div class="vn">${esc(s.name)}</div><div class="vs">${esc(sub)}</div></div><div class="actions">${action}</div></div>`;
    })
    .join("");
  app.innerHTML = `<div class="sheet-head"><button class="icon-btn lead" data-action="home" aria-label="Back">${backIcon()}</button><span class="t">Vendors</span></div>
    ${rows}
    <div class="add"><button class="ghost" data-action="record">${plusIcon()} Record a new vendor</button></div>
    <div class="foot">Recording watches a billing page and drafts a recipe. Read-only — your passwords never leave this browser.</div>`;
}

function renderSettings(): void {
  const cfg = state.config;
  const kind = cfg?.kind ?? "filesystem";
  const per = state.schedule.periodMinutes ?? 0;
  const segOpt = (label: string, min: number) => `<span class="${per === min ? "on" : ""}" data-action="set-schedule" data-min="${min}">${label}</span>`;

  const destFields =
    kind === "filesystem"
      ? `<div class="field"><span class="k">Folder</span><input data-field="folder" value="${esc(cfg && cfg.kind === "filesystem" ? cfg.rootFolder : "InvoiceCollector")}" /></div>
         <div class="field"><span class="k">Folders by</span><select data-field="datemode"><option value="extraction" ${cfg && cfg.kind === "filesystem" && cfg.dateMode === "extraction" ? "selected" : ""}>Date collected</option><option value="invoice" ${cfg && cfg.kind === "filesystem" && cfg.dateMode === "invoice" ? "selected" : ""}>Invoice date</option></select></div>`
      : `<div class="field"><span class="k">Endpoint</span><input data-field="endpoint" placeholder="https://…" value="${esc(cfg && cfg.kind !== "filesystem" ? cfg.endpoint : "")}" /></div>
         <div class="field"><span class="k">Company</span><input data-field="company" placeholder="company id" value="${esc(cfg && cfg.kind !== "filesystem" ? cfg.companyId : "")}" /></div>`;

  app.innerHTML = `<div class="sheet-head"><button class="icon-btn lead" data-action="home" aria-label="Back">${backIcon()}</button><span class="t">Settings</span></div>
    <div class="grp">
      <div class="lbl">Save invoices to</div>
      <div class="opts">
        <label class="opt ${kind === "filesystem" ? "sel" : ""}" data-action="set-dest" data-kind="filesystem"><span class="radio"></span><div><div class="ot">This computer</div><div class="os">Downloads folder</div></div></label>
        <label class="opt ${kind !== "filesystem" ? "sel" : ""}" data-action="set-dest" data-kind="igdrasil"><span class="radio"></span><div><div class="ot">Igdrasil accounting</div><div class="os">Straight to your books</div></div></label>
      </div>
      ${destFields}
    </div>
    <div class="grp divider">
      <div class="lbl">Check for new invoices</div>
      <div class="seg">${segOpt("Off", 0)}${segOpt("6h", 360)}${segOpt("12h", 720)}${segOpt("Daily", 1440)}</div>
    </div>
    <div class="foot">Runs while Chrome is open, using your logged-in sessions. If it's closed, it catches up next time.</div>`;
}

function renderRecord(): void {
  const back = `<div class="sheet-head"><button class="icon-btn lead" data-action="${state.recording ? "stop-record" : "home"}" aria-label="Back">${backIcon()}</button><span class="t">Add a vendor</span></div>`;

  if (state.recording) {
    const p = state.progress;
    const state_line = p.detected
      ? `<div class="recstate on">${checkIcon("var(--primary)")}${p.documents > 0 ? "Invoice downloaded — you can stop now." : "Invoice list found — you can stop now."}</div>`
      : `<div class="recstate">Open your billing / invoices page and let it load…</div>`;
    app.innerHTML = `${back}<div class="rec-compact">
      <div class="reclive"><span class="rd"></span>Recording · <span class="n">${p.captured}</span> request${p.captured === 1 ? "" : "s"}${p.documents > 0 ? ` · <span class="n">${p.documents}</span> doc${p.documents === 1 ? "" : "s"}` : ""}</div>
      ${state_line}
      <button class="btn block${p.detected ? "" : " outline"}" data-action="stop-record">Stop &amp; analyze</button>
    </div>`;
    return;
  }

  const r = state.result;
  if (!r) {
    app.innerHTML = `${back}<div class="stage">
      <div class="callout">Go to a vendor's billing page, then start — we'll watch the network and draft a recipe.</div>
      <button class="btn block" data-action="record">Record this page</button>
    </div>`;
    return;
  }

  const hasDraft = Boolean(r.draft);
  const head = hasDraft
    ? `<div class="found"><span class="ic">${checkIcon()}</span><div><div class="ft">Recipe drafted</div><div class="fs">confidence: ${esc(r.draft!.confidence)} · captured ${r.captured}</div></div></div>`
    : `<div class="found warn"><span class="ic" style="background:var(--warn)">${checkIcon()}</span><div><div class="ft">No invoice list detected</div><div class="fs">captured ${r.captured} requests</div></div></div>`;

  const notes = hasDraft && r.draft!.notes.length
    ? `<ul class="notes">${r.draft!.notes.slice(0, 4).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
    : "";
  const recipe = hasDraft
    ? `<details class="disclose"><summary>Show recipe details</summary><pre>${esc(JSON.stringify(r.draft!.recipe, null, 2))}</pre></details>`
    : r.docLinks.length
      ? `<div class="callout">Document links found — the pattern likely just needs a tweak:</div><pre class="samples">${esc(r.docLinks.join("\n"))}</pre>`
      : `<pre class="samples">${esc(r.samples.join("\n"))}</pre>`;

  app.innerHTML = `${back}<div class="stage">
    ${head}
    <button class="btn block" data-action="copy-report">${copyIcon()} Copy for your agent</button>
    ${notes}
    ${recipe}
    <div class="rowbtns"><button class="btn outline" data-action="home">Done</button></div>
  </div>`;
}

// ---- actions --------------------------------------------------------------

app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (!el) return;
  const a = el.dataset.action!;
  const id = el.dataset.id;
  void (async () => {
    await press(el); // a visible depress, since the action often re-renders the button away
    await handle(a, id, el);
  })();
});

/** better-ui "scale on press": a brief 0.95 depress so every tap feels physical,
 * shown before any re-render replaces the element (transform-only, ~100ms). */
async function press(el: HTMLElement): Promise<void> {
  el.style.transition = "scale 90ms ease-out";
  el.style.scale = "0.95";
  await new Promise((r) => setTimeout(r, 95));
  el.style.scale = "1";
}

app.addEventListener("change", (e) => {
  const el = e.target as HTMLElement;
  const field = (el as HTMLInputElement).dataset?.field;
  if (field) void saveField(field, (el as HTMLInputElement).value);
});

async function handle(a: string, id?: string, el?: HTMLElement): Promise<void> {
  switch (a) {
    case "open-settings": screen = "settings"; return render();
    case "open-vendors": screen = "vendors"; return render();
    case "home": stopProgress(); screen = "home"; state.result = null; return void load();
    case "connect": await run({ type: "connect", vendorId: id! }, "Connecting…"); return;
    case "sync": await run({ type: "runNow", vendorId: id! }, "Syncing…"); return;
    case "sync-all": await run({ type: "runNow" }, "Syncing…"); return;
    case "disconnect": await run({ type: "disconnect", vendorId: id! }, "Removed"); return;
    case "set-schedule": await send({ type: "setSchedule", periodMinutes: Number(el!.dataset.min) }); return void load();
    case "set-dest": await switchDest(el!.dataset.kind as "filesystem" | "igdrasil"); return;
    case "record": {
      const res = await send({ type: "recorderStart", mode: "deep" });
      if (!res.ok) return toast("error" in res ? res.error : "couldn't start");
      state.recording = true; state.result = null;
      state.progress = { recording: true, captured: 0, documents: 0, detected: false };
      screen = "record"; render();
      return startProgress();
    }
    case "stop-record": {
      stopProgress();
      toast("Analyzing…");
      const res = await send({ type: "recorderStop" });
      state.recording = false;
      state.result = res.ok && "draft" in res ? res : null;
      screen = "record"; return render();
    }
    case "copy-report": {
      const report = state.result?.report ?? "";
      try { await navigator.clipboard.writeText(report); } catch { fallbackCopy(report); }
      toast(`Copied ${report.length.toLocaleString()} chars`);
      return;
    }
  }
}

async function run(message: Parameters<typeof send>[0], pending: string): Promise<void> {
  toast(pending);
  const res = await send(message);
  if (!res.ok) toast("error" in res ? res.error : "error");
  else if ("summaries" in res) {
    const n = res.summaries.reduce((a, s) => a + (s.status === "ok" ? s.count : 0), 0);
    toast(n ? `Collected ${n}` : "Up to date");
  }
  await load();
}

async function switchDest(kind: "filesystem" | "igdrasil"): Promise<void> {
  const cfg = state.config;
  if (kind === "filesystem") {
    await send({ type: "setConfig", config: { kind: "filesystem", rootFolder: cfg && cfg.kind === "filesystem" ? cfg.rootFolder : "InvoiceCollector", dateMode: cfg && cfg.kind === "filesystem" ? cfg.dateMode : "extraction" } });
  } else {
    await send({ type: "setConfig", config: { kind: "igdrasil", endpoint: cfg && cfg.kind !== "filesystem" ? cfg.endpoint : "", companyId: cfg && cfg.kind !== "filesystem" ? cfg.companyId : "" } });
  }
  await load();
}

async function saveField(field: string, value: string): Promise<void> {
  const cfg = state.config;
  if (field === "folder" && cfg?.kind === "filesystem") await send({ type: "setConfig", config: { ...cfg, rootFolder: value || "InvoiceCollector" } });
  else if (field === "datemode" && cfg?.kind === "filesystem") await send({ type: "setConfig", config: { ...cfg, dateMode: value as "extraction" | "invoice" } });
  else if (field === "endpoint" && cfg && cfg.kind !== "filesystem") await send({ type: "setConfig", config: { ...cfg, endpoint: value } });
  else if (field === "company" && cfg && cfg.kind !== "filesystem") await send({ type: "setConfig", config: { ...cfg, companyId: value } });
  state.config = await getConfig();
}

function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/** Ledger stores vendorId; the popup already knows each vendor's icon from listSources. */
function iconFor(vendorId: string): string | undefined {
  return state.sources.find((s) => s.id === vendorId)?.icon;
}

// ---- inline icons ---------------------------------------------------------

function docIcon(stroke: string): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h9l5 5v11H5z"/><path d="M14 4v5h5"/><path d="M9 13h6M9 16.5h4"/></svg>`; }
function gearIcon(): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1"/></svg>`; }
function plusIcon(): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`; }
function backIcon(): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>`; }
function xIcon(): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>`; }
function checkIcon(stroke = "var(--primary-fg)"): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`; }
function copyIcon(): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="var(--primary-fg)" stroke-width="2"><path d="M9 9h10v10H9z"/><path d="M5 15V5h10"/></svg>`; }

void load();
