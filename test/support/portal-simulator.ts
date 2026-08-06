/**
 * A deterministic supplier-portal simulator for supplier discovery.
 *
 * Discovery's two failure modes — "it found nothing" and "it took forever" —
 * are both properties of the *whole* search: which routes it plans, how long it
 * waits on each, what evidence survives the page boundary, and whether the
 * compiled recipe can actually be replayed. Unit tests over the individual
 * predicates cannot observe any of that.
 *
 * So this module stands in for Chrome. A portal is declared as routes with a
 * hydration delay, rendered HTML, the JSON its application fetches, and the HTTP
 * endpoints a compiled recipe would replay. `discoverSupplierInTab` then runs
 * unmodified against it.
 *
 * Time is virtual. Every modelled navigation and probe advances a shared clock
 * that `Date.now` reads, and concurrent work merges by taking the maximum rather
 * than the sum — so a reported elapsed time is the wall-clock a person would
 * experience, measured in one millisecond of real test time.
 *
 * The cost model is deliberately the honest one: a probe only sees a route's
 * billing evidence if the settle window it was granted covers that route's
 * hydration delay. Shortening settle windows therefore shows up as lost
 * candidates, not as free speed.
 */

import { EXPLORATION_ROUTE_POLICY, safeExplorationUrl } from "../../collector/src/platform/discovery-explorer";

export interface ObservedCall {
  url: string;
  method?: "GET" | "POST";
  status?: number;
  contentType?: string;
  requestBody?: string;
  requestHeaders?: Record<string, string>;
  body: string;
}

export interface PortalLink {
  href: string;
  label?: string;
  context?: string;
}

export interface PortalRoute {
  path: string;
  /** Milliseconds after navigation before billing evidence exists. */
  hydrateMs?: number;
  /** Milliseconds before the application shell (navigation) is rendered. */
  shellHydrateMs?: number;
  title?: string;
  applicationName?: string;
  html?: string;
  /** Fetch/XHR the application issues once hydrated. */
  calls?: ObservedCall[];
  links?: PortalLink[];
  /** Counted semantic download controls, as the in-page DOM policy would. */
  semanticControls?: number;
  semanticSections?: number;
  /** Applications that gate billing hydration on `document.visibilityState`. */
  visibleOnly?: boolean;
  /** Route answers with an error page. */
  missing?: boolean;
}

export interface HttpReply {
  status?: number;
  contentType?: string;
  body: string;
}

export interface Portal {
  name: string;
  origin: string;
  entryPath: string;
  /** Cost of a full page load in a fresh tab. */
  navMs?: number;
  routes: PortalRoute[];
  /** Serves what a compiled recipe replays during candidate preview. */
  endpoint?: (request: { url: string; method: string; body?: string }) => HttpReply | undefined;
}

export interface SimulationTrace {
  /** Modelled wall-clock a person would wait, in milliseconds. */
  elapsedMs: number;
  probes: Array<{ url: string; foreground: boolean; hydrated: boolean; costMs: number }>;
  navigations: number;
  openTabs: number;
}

const PROBE_FLOOR_MS = 120;
const DEFAULT_NAV_MS = 700;
const DEFAULT_SHELL_HYDRATE_MS = 250;
const BILLING_INTENT = new RegExp(EXPLORATION_ROUTE_POLICY.intent, "i");
const REPLAYABLE_RESOURCE = /invoice|billing|receipt|statement|transaction|charge|payment|subscription|plan|account|session|organization|workspace|team/i;

interface FakeTab {
  id: number;
  url: string;
  windowId: number;
  active: boolean;
  status: "complete";
  /** This tab's own timeline; steps on one tab never overlap each other. */
  clock: number;
  /** Virtual time the current document started loading. */
  navigatedAt: number;
  /** A document-start observer exists only on documents opened after the
   * discovery run registered it, exactly as `registerContentScripts` behaves. */
  observed: boolean;
}

export interface Simulation {
  trace: SimulationTrace;
  entryTabId: number;
  install(): void;
  restore(): void;
}

export function createSimulation(portal: Portal): Simulation {
  const origin = portal.origin;
  const navMs = portal.navMs ?? DEFAULT_NAV_MS;
  const routes = new Map(portal.routes.map((route) => [route.path, route]));
  const trace: SimulationTrace = { elapsedMs: 0, probes: [], navigations: 0, openTabs: 0 };

  let clock = 1_800_000_000_000;
  const started = clock;
  let nextTabId = 100;
  let observerRegistered = false;
  const tabs = new Map<number, FakeTab>();

  const now = () => clock;
  const advanceTo = (at: number) => {
    clock = Math.max(clock, at);
    trace.elapsedMs = clock - started;
  };

  /**
   * Work on different tabs overlaps, so their costs must merge by maximum, not
   * accumulate. `waveClock` is the clock as every task in the current batch saw
   * it; each tab then keeps its own timeline so steps *on one tab* still run in
   * sequence. Without this the model would charge four parallel page loads as
   * four serial ones and make any concurrency change look useless.
   */
  let waveClock = clock;
  let waveSyncScheduled = false;
  const scheduleWaveSync = () => {
    if (waveSyncScheduled) return;
    waveSyncScheduled = true;
    setTimeout(() => {
      waveClock = clock;
      waveSyncScheduled = false;
    }, 0);
  };
  const startOf = (tab: FakeTab) => Math.max(waveClock, tab.clock);
  const finish = (tab: FakeTab, start: number, cost: number) => {
    tab.clock = start + cost;
    advanceTo(tab.clock);
    scheduleWaveSync();
  };
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const entryTab: FakeTab = {
    id: nextTabId++,
    url: `${origin}${portal.entryPath}`,
    windowId: 1,
    active: true,
    status: "complete",
    clock,
    // The page the person is already looking at settled long before the click.
    navigatedAt: clock - 600_000,
    observed: false,
  };
  tabs.set(entryTab.id, entryTab);

  const routeFor = (url: string): PortalRoute | undefined => {
    try {
      return routes.get(new URL(url).pathname);
    } catch {
      return undefined;
    }
  };

  const navigate = async (tab: FakeTab, url: string): Promise<void> => {
    const start = startOf(tab);
    await tick();
    tab.url = url;
    tab.navigatedAt = start + navMs;
    tab.observed = observerRegistered;
    trace.navigations += 1;
    finish(tab, start, navMs);
  };

  const shellFor = (route: PortalRoute | undefined): string =>
    `<html><head><title>${route?.title ?? "Loading"}</title></head><body><div id="root"></div></body></html>`;

  const collectEvidence = async (tab: FakeTab, options: { settleMs: number; maxResources: number; deadlineMs: number }) => {
    const start = startOf(tab);
    await tick();
    const route = routeFor(tab.url);
    const missing = !route || route.missing;
    const budgetMs = Math.max(0, Math.min(options.settleMs, options.deadlineMs));
    const sinceNav = Math.max(0, start - tab.navigatedAt);

    const shellReadyIn = Math.max(0, (route?.shellHydrateMs ?? DEFAULT_SHELL_HYDRATE_MS) - sinceNav);
    const hydrateIn = route && !missing && !(route.visibleOnly && !tab.active)
      ? Math.max(0, (route.hydrateMs ?? 0) - sinceNav)
      : Number.POSITIVE_INFINITY;

    const hydrated = hydrateIn <= budgetMs;
    const shellReady = shellReadyIn <= budgetMs;
    const waited = Math.min(budgetMs, hydrated ? hydrateIn : budgetMs);
    const costMs = Math.min(Math.max(options.deadlineMs, PROBE_FLOOR_MS), PROBE_FLOOR_MS + waited);
    finish(tab, start, costMs);
    trace.probes.push({ url: tab.url, foreground: tab.active, hydrated, costMs });

    if (missing) throw new Error("supplier route did not render");

    const calls = hydrated ? route!.calls ?? [] : [];
    // Without a document-start observer the page's own fetches were never seen;
    // discovery can only replay the same-origin GET endpoints the browser's
    // resource timeline exposes.
    const visible = tab.observed
      ? calls
      : calls.filter((call) => (call.method ?? "GET") === "GET" &&
        safeSameOrigin(call.url, origin) && REPLAYABLE_RESOURCE.test(call.url));
    const resources = rankCalls(visible).slice(0, options.maxResources).map((call) => ({
      url: call.url,
      method: call.method ?? "GET",
      status: call.status ?? 200,
      contentType: call.contentType ?? "application/json",
      body: call.body,
      ...(call.requestBody !== undefined ? { requestBody: call.requestBody } : {}),
      ...(call.requestHeaders !== undefined ? { requestHeaders: call.requestHeaders } : {}),
      source: tab.observed ? ("observed" as const) : ("replayed" as const),
      hasLinkNext: false,
    }));

    const html = hydrated ? route!.html ?? shellFor(route) : shellFor(route);
    const links = shellReady ? route!.links ?? [] : [];
    const crossOriginHosts = [...new Set(resources
      .map((resource) => new URL(resource.url).hostname)
      .filter((host) => host !== new URL(origin).hostname))].slice(0, 8);

    return {
      url: `${origin}${new URL(tab.url).pathname}`,
      origin,
      title: route!.title,
      applicationName: route!.applicationName,
      html,
      resources,
      navigationUrls: plannableLinks(links, origin),
      crossOriginHosts,
      stats: {
        documentLinks: hydrated ? countDocumentLinks(html) : 0,
        structuredData: hydrated ? countStructuredData(html) : 0,
        semanticControls: hydrated ? route!.semanticControls ?? 0 : 0,
        semanticSections: hydrated ? route!.semanticSections ?? 0 : 0,
        semanticControlsRejected: 0,
        semanticNavigationSteps: 0,
      },
    };
  };

  const replay = (request: { url: string; method?: string; body?: string }) => {
    if (process.env.SIM_DEBUG) console.info("[sim] replay", JSON.stringify(request));
    const reply = portal.endpoint?.({
      url: request.url,
      method: (request.method ?? "GET").toUpperCase(),
      body: request.body,
    });
    advanceTo(now() + 90);
    return reply;
  };

  const realDateNow = Date.now;
  const realFetch = globalThis.fetch;
  const realChrome = (globalThis as { chrome?: unknown }).chrome;

  const fakeChrome = {
    tabs: {
      async get(tabId: number) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`no such tab ${tabId}`);
        return { ...tab };
      },
      async create({ url, active }: { url: string; active?: boolean }) {
        const tab: FakeTab = {
          id: nextTabId++,
          url,
          windowId: 1,
          active: active === true,
          status: "complete",
          clock: 0,
          navigatedAt: 0,
          observed: false,
        };
        tabs.set(tab.id, tab);
        trace.openTabs = Math.max(trace.openTabs, tabs.size);
        await navigate(tab, url);
        return { ...tab };
      },
      async update(tabId: number, properties: { url?: string; active?: boolean }) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`no such tab ${tabId}`);
        if (properties.active === true) {
          for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
          tab.active = true;
        }
        if (properties.url) await navigate(tab, properties.url);
        return { ...tab };
      },
      async remove(tabId: number) {
        tabs.delete(tabId);
      },
      async query(info: { active?: boolean; windowId?: number; url?: string }) {
        return [...tabs.values()]
          .filter((tab) => (info.active === undefined || tab.active === info.active) &&
            (info.windowId === undefined || tab.windowId === info.windowId) &&
            (info.url === undefined || tab.url.startsWith(info.url.replace(/\*$/, ""))))
          .map((tab) => ({ ...tab }));
      },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    scripting: {
      async registerContentScripts() {
        observerRegistered = true;
      },
      async unregisterContentScripts() {
        observerRegistered = false;
      },
      async executeScript({ target, args, files }: { target: { tabId: number }; args?: unknown[]; files?: string[] }) {
        const tab = tabs.get(target.tabId);
        if (!tab) throw new Error(`no such tab ${target.tabId}`);
        // Injecting the observer into an already-open document, as discovery
        // does for the tab the person is looking at.
        if (files?.length) {
          tab.observed = observerRegistered;
          return [{ result: undefined }];
        }
        const first = args?.[0] as Record<string, unknown> | undefined;
        // The document-action controller scopes the page observer around every
        // probe; it only proceeds when the observer reports it took the scope.
        if (args?.length === 1 && typeof args[0] === "boolean") {
          return [{ result: tab.observed }];
        }
        if (args?.length === 3 && typeof first?.settleMs === "number") {
          return [{ result: await collectEvidence(tab, first as unknown as { settleMs: number; maxResources: number; deadlineMs: number }) }];
        }
        if (args?.length === 1 && typeof first?.url === "string") {
          const reply = replay(first as { url: string; method?: string; body?: string });
          if (!reply) return [{ result: { ok: false, status: 404, contentType: null, base64: "" } }];
          return [{
            result: {
              ok: (reply.status ?? 200) < 400,
              status: reply.status ?? 200,
              contentType: reply.contentType ?? "application/json",
              base64: base64(reply.body),
            },
          }];
        }
        return [{ result: undefined }];
      },
    },
    // Discovery probes run inside a native-download guard and a request
    // observer. Neither can act in the model, but both must exist or the
    // controller refuses to run the probe at all.
    declarativeNetRequest: {
      async updateSessionRules() {},
      async getSessionRules() { return []; },
    },
    webRequest: {
      onBeforeRequest: { addListener() {}, removeListener() {} },
      onHeadersReceived: { addListener() {}, removeListener() {} },
      onBeforeRedirect: { addListener() {}, removeListener() {} },
    },
    downloads: { onCreated: { addListener() {}, removeListener() {} } },
    storage: memoryStorage(),
    permissions: { async contains() { return true; } },
    runtime: { lastError: undefined, id: "simulated" },
  };

  return {
    trace,
    entryTabId: entryTab.id,
    install() {
      Date.now = now;
      (globalThis as { chrome?: unknown }).chrome = fakeChrome;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const reply = replay({ url, method: init?.method, body: init?.body as string | undefined });
        const body = reply?.body ?? "";
        const status = reply ? reply.status ?? 200 : 404;
        return {
          status,
          ok: status < 400,
          url,
          redirected: false,
          json: async () => JSON.parse(body),
          text: async () => body,
          headers: { get: (name: string) => name.toLowerCase() === "content-type" ? reply?.contentType ?? "application/json" : null },
          clone() { return this; },
          body: null,
        } as unknown as Response;
      }) as typeof fetch;
    },
    restore() {
      Date.now = realDateNow;
      globalThis.fetch = realFetch;
      (globalThis as { chrome?: unknown }).chrome = realChrome;
    },
  };
}

function safeSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** The in-page collector ranks observed calls by billing signal before it
 * spends its bounded resource slots; mirror that so the cap bites the same way. */
function rankCalls(calls: readonly ObservedCall[]): ObservedCall[] {
  const score = (call: ObservedCall) => {
    const value = `${call.url} ${call.body.slice(0, 4_000)}`;
    return (/invoice|receipt|statement/i.test(value) ? 100 : 0) +
      (/billing|transaction|charge/i.test(value) ? 50 : 0) +
      (/payment|subscription|plan/i.test(value) ? 25 : 0) +
      (/account|session|organization|workspace|team/i.test(value) ? 5 : 0);
  };
  return [...calls].sort((left, right) => score(right) - score(left));
}

/** Only routes the in-page collector would have emitted reach the planner. */
function plannableLinks(links: readonly PortalLink[], origin: string): Array<string | { url: string; label?: string; context?: string }> {
  const out: Array<string | { url: string; label?: string; context?: string }> = [];
  for (const link of links.slice(0, 80)) {
    const semantic = `${link.label ?? ""} ${link.context ?? ""}`.trim();
    const url = safeExplorationUrl(absolute(link.href, origin), origin, semantic, { allowBridgeIntent: true });
    if (!url) continue;
    out.push(link.label || link.context
      ? { url, ...(link.label ? { label: link.label } : {}), ...(link.context ? { context: link.context } : {}) }
      : url);
  }
  return out;
}

function absolute(href: string, origin: string): string {
  try {
    return new URL(href, `${origin}/`).toString();
  } catch {
    return href;
  }
}

function countDocumentLinks(html: string): number {
  let count = 0;
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = match[1];
    const href = /\bhref="([^"]+)"/i.exec(attributes)?.[1];
    if (!href) continue;
    if (
      /\.pdf(?:[?#]|")?/i.test(href) || /\/download/i.test(href) || /\/pdf/i.test(href) ||
      /^\/account\/receipt\//i.test(href) || /invoice\.stripe\.com/i.test(href) ||
      /\bdownload\b/i.test(attributes)
    ) count += 1;
  }
  return Math.min(1_000, count);
}

function countStructuredData(html: string): number {
  return Math.min(1_000, [...html.matchAll(/<script[^>]+type="application\/(?:ld\+)?json"/gi)].length);
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function memoryStorage() {
  const area = () => {
    const data = new Map<string, unknown>();
    return {
      async get(keys?: string | string[] | Record<string, unknown> | null) {
        if (typeof keys === "string") return { [keys]: data.get(keys) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, data.get(key)]));
        return Object.fromEntries(data);
      },
      async set(items: Record<string, unknown>) {
        for (const [key, value] of Object.entries(items)) data.set(key, value);
      },
      async remove(keys: string | string[]) {
        for (const key of [keys].flat()) data.delete(key);
      },
      onChanged: { addListener() {}, removeListener() {} },
    };
  };
  return { local: area(), session: area(), sync: area(), onChanged: { addListener() {}, removeListener() {} } };
}

/** Convenience for portals whose invoice list is one static JSON endpoint. */
export function staticEndpoint(
  table: Record<string, HttpReply>,
): NonNullable<Portal["endpoint"]> {
  return (request) => table[request.url] ?? table[`${request.method} ${request.url}`];
}

export { BILLING_INTENT as SIMULATED_BILLING_INTENT };
