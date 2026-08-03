import { isBoundedTenantIdentifierSegment } from "../../../src/core/discovery";

/**
 * Pure planning policy for unsupported-supplier exploration.
 *
 * The browser transport lives in discovery.ts. Keeping route selection here
 * makes the security boundary deterministic and straightforward to test: only
 * exact-origin HTTPS GET navigations with explicit billing intent are emitted.
 */

export const MAX_EXPLORATION_PAGES = 15;
export const MAX_EXPLORATION_DEPTH = 3;
export const EXPLORATION_DEADLINE_MS = 10_000;
export const DISCOVERY_ENGINE_REVISION = 36;

/**
 * A scan starts in the inexpensive fast lane, but its policy is deliberately
 * capable of a deeper, user-initiated pass.  These are global budgets, not
 * per-route timeouts: a noisy application cannot turn one click into an
 * unbounded crawler.
 */
export type ExplorationMode = "fast" | "deep" | "self_heal";

export interface ExplorationBudget {
  pages: number;
  depth: number;
  durationMs: number;
  /** Self-heal work is split so ordinary collection work can interleave. */
  slices: number;
}

/**
 * `fast` is the interactive envelope: a person is watching a spinner, so the
 * whole scan is capped at ten seconds. It stays capable rather than shallow —
 * the page budget is spent in wide concurrent waves and the run stops the
 * moment a candidate is proven, so the cap is a ceiling, not the usual cost.
 *
 * `deep` is the explicit second attempt for a portal the fast envelope could not
 * resolve, and `self_heal` is background repair of an already-connected
 * supplier. Neither blocks a person at a spinner, but both stay far below the
 * multi-minute budgets that made an unattended scan indistinguishable from a
 * hang.
 */
export const EXPLORATION_BUDGETS: Readonly<Record<ExplorationMode, ExplorationBudget>> = {
  fast: { pages: MAX_EXPLORATION_PAGES, depth: MAX_EXPLORATION_DEPTH, durationMs: EXPLORATION_DEADLINE_MS, slices: 1 },
  deep: { pages: 40, depth: 4, durationMs: 45_000, slices: 1 },
  self_heal: { pages: 60, depth: 5, durationMs: 120_000, slices: 5 },
};

export function explorationBudget(mode: ExplorationMode = "fast"): ExplorationBudget {
  return EXPLORATION_BUDGETS[mode];
}

export type ExplorationPageSource = "entry" | "entry_replay" | "linked" | "common_route";

/** A family is a path *kind*, never an origin, tenant identifier, or URL. */
export type ExplorationFamily =
  | "exact_entry"
  | "observed_navigation"
  | "tenant_contextual_route"
  | "common_billing_route"
  | "observed_network"
  | "embedded_data"
  | "document_provider"
  | "semantic_download";

export const ENABLED_EXPLORATION_FAMILIES: readonly ExplorationFamily[] = [
  "exact_entry",
  "observed_navigation",
  "tenant_contextual_route",
  "common_billing_route",
  "observed_network",
  "embedded_data",
  "document_provider",
  "semantic_download",
];

export interface ExplorationTarget {
  url: string;
  depth: number;
  source: ExplorationPageSource;
  score: number;
  /** Optional for legacy callers; all newly planned targets carry a family. */
  family?: ExplorationFamily;
}

export function explorationFamilyForTarget(target: Pick<ExplorationTarget, "source" | "family">): ExplorationFamily {
  if (target.family) return target.family;
  if (target.source === "entry" || target.source === "entry_replay") return "exact_entry";
  return target.source === "linked" ? "observed_navigation" : "common_billing_route";
}

const EXPLORATION_CHECKPOINT_SCHEMA = "ratatosk.exploration-checkpoint.v1" as const;

/**
 * Durable progress intentionally contains only route templates.  It must not
 * retain query strings, authenticated URLs, tenant IDs, response data, or
 * captured request material in chrome.storage.session.
 */
export interface ExplorationCheckpoint {
  schema: typeof EXPLORATION_CHECKPOINT_SCHEMA;
  mode: ExplorationMode;
  pagesAttempted: number;
  linkedPagesAttempted: number;
  commonRoutePagesAttempted: number;
  elapsedMs: number;
  frontier: ExplorationFrontierItem[];
  completedTargetKeys: string[];
  attemptedFamilies: ExplorationFamily[];
  slicesCompleted: number;
}

export interface ExplorationFrontierItem {
  key: string;
  family: ExplorationFamily;
  score: number;
  depth: number;
}

export function explorationTargetKey(target: Pick<ExplorationTarget, "url" | "source" | "family">): string {
  return `${explorationFamilyForTarget(target)}|${structuralRoute(target.url)}`;
}

export function createExplorationCheckpoint(input: Omit<ExplorationCheckpoint, "schema">): ExplorationCheckpoint {
  const budget = explorationBudget(input.mode);
  const pagesAttempted = Math.max(0, Math.min(budget.pages, Math.trunc(input.pagesAttempted)));
  const linkedPagesAttempted = Math.max(0, Math.min(pagesAttempted, Math.trunc(input.linkedPagesAttempted)));
  const commonRoutePagesAttempted = Math.max(0, Math.min(pagesAttempted - linkedPagesAttempted, Math.trunc(input.commonRoutePagesAttempted)));
  return {
    schema: EXPLORATION_CHECKPOINT_SCHEMA,
    mode: input.mode,
    pagesAttempted,
    linkedPagesAttempted,
    commonRoutePagesAttempted,
    elapsedMs: Math.max(0, Math.min(budget.durationMs, Math.trunc(input.elapsedMs))),
    frontier: normalizeFrontier(input.frontier, budget),
    completedTargetKeys: [...new Set(input.completedTargetKeys.filter(isSafeTargetKey))].slice(0, budget.pages),
    attemptedFamilies: ENABLED_EXPLORATION_FAMILIES.filter((family) => input.attemptedFamilies.includes(family)),
    slicesCompleted: Math.max(0, Math.min(budget.slices, Math.trunc(input.slicesCompleted))),
  };
}

export function parseExplorationCheckpoint(value: unknown): ExplorationCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<ExplorationCheckpoint>;
  if (
    raw.schema !== EXPLORATION_CHECKPOINT_SCHEMA ||
    (raw.mode !== "fast" && raw.mode !== "deep" && raw.mode !== "self_heal") ||
    !Array.isArray(raw.frontier) || !Array.isArray(raw.completedTargetKeys) || !Array.isArray(raw.attemptedFamilies) ||
    !Number.isInteger(raw.pagesAttempted) || !Number.isInteger(raw.linkedPagesAttempted) ||
    !Number.isInteger(raw.commonRoutePagesAttempted) || !Number.isInteger(raw.elapsedMs) || !Number.isInteger(raw.slicesCompleted)
  ) return undefined;
  const checkpoint = createExplorationCheckpoint({
    mode: raw.mode,
    pagesAttempted: Number(raw.pagesAttempted),
    linkedPagesAttempted: Number(raw.linkedPagesAttempted),
    commonRoutePagesAttempted: Number(raw.commonRoutePagesAttempted),
    elapsedMs: Number(raw.elapsedMs),
    frontier: raw.frontier.filter((item): item is ExplorationFrontierItem => Boolean(item && typeof item === "object")),
    completedTargetKeys: raw.completedTargetKeys.filter((item): item is string => typeof item === "string"),
    attemptedFamilies: raw.attemptedFamilies.filter((item): item is ExplorationFamily => typeof item === "string" && ENABLED_EXPLORATION_FAMILIES.includes(item as ExplorationFamily)),
    slicesCompleted: Number(raw.slicesCompleted),
  });
  return checkpoint.pagesAttempted === raw.pagesAttempted &&
    checkpoint.linkedPagesAttempted === raw.linkedPagesAttempted &&
    checkpoint.commonRoutePagesAttempted === raw.commonRoutePagesAttempted &&
    checkpoint.elapsedMs === raw.elapsedMs &&
    checkpoint.frontier.length === raw.frontier.length &&
    checkpoint.linkedPagesAttempted + checkpoint.commonRoutePagesAttempted <= checkpoint.pagesAttempted &&
    checkpoint.slicesCompleted === raw.slicesCompleted &&
    checkpoint.completedTargetKeys.length === raw.completedTargetKeys.length
    ? checkpoint
    : undefined;
}

export interface ExplorationLinkEvidence {
  url: string;
  label?: string;
  context?: string;
}

export interface ExplorationProbeOptions {
  settleMs: number;
  maxResources: number;
  deadlineMs: number;
}

/**
 * Where the evidence is, spend the render window; everywhere else, be cheap.
 *
 * A route reaches the frontier either because it states billing intent or
 * because it is a settings/account *bridge* toward one. Only the first kind can
 * hold invoices, so it gets the wide resource sample and a render window long
 * enough for a single-page app to boot and issue its billing calls. Bridges are
 * navigation: they are read for their links and abandoned.
 *
 * The previous rule keyed on the literal path `settings/billing`, so the most
 * common billing routes there are — `/billing`, `/account/billing`,
 * `/<tenant>/billing`, `/subscriptions` — were funded like dead ends while a
 * page that merely mentioned "invoice" received the generous budget.
 */
export function explorationProbeOptions(
  target: ExplorationTarget,
  mode: ExplorationMode = "fast",
): ExplorationProbeOptions {
  const pathname = new URL(target.url).pathname;
  const billing = BILLING_INTENT.test(pathname);
  // The escalation is not just a larger frontier. A portal the interactive pass
  // could not resolve is often one whose billing view simply had not finished
  // rendering, so the deeper envelope buys patience per route as well as more
  // routes — otherwise a second pass re-probes the same page the same way and
  // reaches the same conclusion.
  if (mode === "fast") {
    return billing
      ? { settleMs: 2_600, maxResources: 12, deadlineMs: 4_200 }
      : { settleMs: 900, maxResources: 6, deadlineMs: 2_200 };
  }
  return billing
    ? { settleMs: 8_000, maxResources: 12, deadlineMs: 10_000 }
    : { settleMs: 2_000, maxResources: 6, deadlineMs: 3_500 };
}

/** The active tab is already loaded and rendered, so it needs a settle window
 * only for late billing widgets — never for a cold application boot. */
export function entryProbeOptions(mode: ExplorationMode = "fast"): ExplorationProbeOptions {
  return mode === "fast"
    ? { settleMs: 500, maxResources: 6, deadlineMs: 2_200 }
    : { settleMs: 1_500, maxResources: 12, deadlineMs: 3_500 };
}

/** Clamp a page probe to the time left in the one global exploration budget. */
export function capExplorationProbeOptions(
  options: ExplorationProbeOptions,
  remainingMs: number,
): ExplorationProbeOptions {
  const deadlineMs = Math.max(0, Math.min(options.deadlineMs, Math.trunc(remainingMs)));
  return {
    ...options,
    deadlineMs,
    settleMs: Math.min(options.settleMs, deadlineMs),
  };
}

/** Ensure a concurrent probe wave cannot outlive the advertised global cap. */
export function runWithinExplorationBudget<T>(operation: Promise<T>, remainingMs: number): Promise<T> {
  const bounded = Math.max(0, Math.trunc(remainingMs));
  if (bounded === 0) return Promise.reject(new Error("supplier exploration deadline exceeded"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("supplier exploration deadline exceeded")), bounded);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Guessed routes, most likely first.
 *
 * The interactive budget only affords a couple of probe waves, so this order is
 * the whole value of the guess. It is curated rather than derived from
 * `pathScore`, because that function ranks by how many billing words a path
 * contains — which puts `/billing/subscriptions` above `/billing` and buries
 * the single most common billing surface behind its own sub-pages.
 */
const COMMON_BILLING_PATHS = [
  "/settings/billing",
  "/billing",
  "/account/billing",
  "/invoices",
  "/billing/history",
  "/account/billing/history",
  "/receipts",
  "/settings/subscription",
] as const;

const CONTEXTUAL_BILLING_SUFFIXES = [
  "/billing",
  "/settings/billing",
  "/invoices",
  "/billing/history",
  "/receipts",
  "/billing/subscriptions",
] as const;
const TENANT_CONTAINER = /^(?:account|accounts|organization|organizations|org|workspace|workspaces|tenant|tenants|customer|customers)$/i;
const TENANT_CONTEXT_PREFIX = /^(?:app|v|t|home|dashboard|manage|admin|account|accounts|organization|organizations|org|workspace|workspaces|team|teams)$/i;

export const EXPLORATION_ROUTE_POLICY = {
  intent: "invoice|receipt|billing|payment|subscription|statement|transaction",
  bridgeIntent: "settings|preferences|account settings|workspace settings|organization settings|team settings",
  unsafe: "logout|log-out|signout|sign-out|delete|remove|cancel|checkout|purchase|upgrade|downgrade|authorize|oauth|callback|invite|payment[-_/]?method",
  unsafeSegment: "(?:^|[-_/])(?:confirm|create|new)[a-z0-9]*|(?:^|[-_/])pay(?:$|[-_/])",
  directDocument: "\\.pdf$|(?:^|/)(?:download|pdf)(?:/|$)|^/account/receipt/",
} as const;

const BILLING_INTENT = new RegExp(EXPLORATION_ROUTE_POLICY.intent, "i");
const BRIDGE_INTENT = new RegExp(EXPLORATION_ROUTE_POLICY.bridgeIntent, "i");
const MUTATING_OR_SESSION_PATH = new RegExp(EXPLORATION_ROUTE_POLICY.unsafe, "i");
const MUTATING_SEGMENT = new RegExp(EXPLORATION_ROUTE_POLICY.unsafeSegment, "i");
const DIRECT_DOCUMENT_PATH = new RegExp(EXPLORATION_ROUTE_POLICY.directDocument, "i");
const SAFE_NUMERIC_PAGINATION_QUERY = /^(?:page|p|offset|start|per_page|limit)$/i;

export function planExplorationTargets(input: {
  origin: string;
  contextUrl?: string;
  links: readonly (string | ExplorationLinkEvidence)[];
  visited: ReadonlySet<string>;
  nextDepth: number;
  includeCommonRoutes?: boolean;
  limit?: number;
  maxDepth?: number;
}): ExplorationTarget[] {
  const maxDepth = Math.max(MAX_EXPLORATION_DEPTH, Math.min(5, Math.trunc(input.maxDepth ?? MAX_EXPLORATION_DEPTH)));
  if (input.nextDepth < 1 || input.nextDepth > maxDepth) return [];
  const origin = exactPublicHttpsOrigin(input.origin);
  const targets = new Map<string, ExplorationTarget>();

  for (const link of input.links.slice(0, 80)) {
    const evidence = typeof link === "string" ? { url: link } : link;
    const label = boundedSemanticLabel(evidence.label);
    const context = boundedSemanticContext(evidence.context);
    const semantic = `${label} ${context}`.trim();
    const candidatePath = safePathname(evidence.url, origin);
    const bridge = input.nextDepth <= 2 && BRIDGE_INTENT.test(`${candidatePath} ${semantic}`);
    const url = safeExplorationUrl(evidence.url, origin, semantic, { allowBridgeIntent: bridge });
    if (!url || input.visited.has(url)) continue;
    const billing = BILLING_INTENT.test(`${new URL(url).pathname} ${semantic}`);
    addBest(targets, {
      url,
      depth: input.nextDepth,
      source: "linked",
      family: "observed_navigation",
      score: (billing ? 100 : 85) + pathScore(new URL(url).pathname) + semanticScore(semantic) - (input.nextDepth - 1) * 3,
    });
  }

  if (input.includeCommonRoutes) {
    const contextPrefix = input.contextUrl ? tenantPrefixFromContext(input.contextUrl, origin) : undefined;
    if (contextPrefix) {
      for (const [index, suffix] of CONTEXTUAL_BILLING_SUFFIXES.entries()) {
        const url = new URL(`${contextPrefix}${suffix}`, `${origin}/`).toString();
        if (input.visited.has(url)) continue;
        addBest(targets, {
          url,
          depth: 1,
          source: "common_route",
          family: "tenant_contextual_route",
          score: 80 + (CONTEXTUAL_BILLING_SUFFIXES.length - index),
        });
      }
    }
    for (const [index, path] of COMMON_BILLING_PATHS.entries()) {
      const url = new URL(path, `${origin}/`).toString();
      if (input.visited.has(url)) continue;
      addBest(targets, {
        url,
        depth: 1,
        source: "common_route",
        family: "common_billing_route",
        score: 60 + (COMMON_BILLING_PATHS.length - index),
      });
    }
  }

  const ranked = rankExplorationQueue([...targets.values()]);
  const limit = Math.max(0, Math.min(79, input.limit ?? MAX_EXPLORATION_PAGES - 1));
  return ranked.slice(0, limit);
}

/**
 * Fair, best-first scheduling. Every represented family receives a turn
 * before any family receives a second. This prevents a large SPA navigation
 * graph from starving tenant-aware or common billing routes while preserving
 * useful route quality within every family.
 */
export function rankExplorationQueue(targets: readonly ExplorationTarget[]): ExplorationTarget[] {
  const byFamily = new Map<ExplorationFamily, ExplorationTarget[]>();
  for (const family of ENABLED_EXPLORATION_FAMILIES) byFamily.set(family, []);
  for (const target of targets) byFamily.get(explorationFamilyForTarget(target))!.push(target);
  for (const queue of byFamily.values()) queue.sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));

  const result: ExplorationTarget[] = [];
  const take = (family: ExplorationFamily, count = 1) => {
    const queue = byFamily.get(family)!;
    result.push(...queue.splice(0, count));
  };
  while (ENABLED_EXPLORATION_FAMILIES.some((family) => byFamily.get(family)!.length)) {
    for (const family of ENABLED_EXPLORATION_FAMILIES) take(family);
  }
  return result;
}

function tenantPrefixFromContext(value: string, expectedOrigin: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== expectedOrigin || url.protocol !== "https:" || url.username || url.password) return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    // An opaque tenant value is safe to bind only when the application itself
    // placed it immediately after a trusted structural container in the exact
    // approved route. The value remains ephemeral and is never inferred from a
    // broad string shape or persisted in diagnostics/checkpoints.
    const opaqueTenantIndex = segments.findIndex((segment, index) => (
      index > 0 && index <= 3 &&
      TENANT_CONTAINER.test(segments[index - 1]) &&
      segments.slice(0, index - 1).every((prefix) => TENANT_CONTEXT_PREFIX.test(prefix)) &&
      isBoundedOpaqueTenantSegment(segment)
    ));
    if (opaqueTenantIndex >= 0) return `/${segments.slice(0, opaqueTenantIndex + 1).join("/")}`;

    const tenantIndex = segments.findIndex((segment) => isBoundedTenantIdentifierSegment(segment));
    if (tenantIndex < 0 || tenantIndex > 3) return undefined;
    if (tenantIndex === 1 && !TENANT_CONTAINER.test(segments[0])) return undefined;
    if (tenantIndex > 1 && (!TENANT_CONTAINER.test(segments[tenantIndex - 1]) ||
      !segments.slice(0, tenantIndex - 1).every((segment) => TENANT_CONTEXT_PREFIX.test(segment)))) return undefined;
    return `/${segments.slice(0, tenantIndex + 1).join("/")}`;
  } catch {
    return undefined;
  }
}

function isBoundedOpaqueTenantSegment(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{3,79}$/i.test(value) &&
    !TENANT_CONTAINER.test(value) &&
    !TENANT_CONTEXT_PREFIX.test(value) &&
    !BILLING_INTENT.test(value) &&
    !MUTATING_OR_SESSION_PATH.test(value) &&
    !MUTATING_SEGMENT.test(value);
}

/**
 * The exact page the person is looking at, made safe to *reopen* — not to store.
 *
 * The cold replay is the only probe that watches an application boot, so it is
 * where a single-page portal's billing calls are observed. Routing it through
 * the persistence rules instead dropped the tenant prefix from a URL like
 * `/organization/<id>/projects` and reopened the site root, which is the one
 * page guaranteed to hold no billing evidence.
 *
 * Nothing here reaches storage: a candidate's entry URL is separately reduced by
 * `safeEntryUrl`, and diagnostics carry route templates only. So this admits the
 * current page's own path while still refusing anything that could act: no
 * credentials in the authority, no mutating or session route, no direct document
 * fetch, no query beyond bounded numeric pagination.
 */
export function safeReplayUrl(value: string, expectedOrigin: string): string | undefined {
  try {
    const origin = exactPublicHttpsOrigin(expectedOrigin);
    const url = new URL(value, `${origin}/`);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return undefined;
    const decodedPathname = safeDecodedExplorationPath(url.pathname);
    if (!decodedPathname) return undefined;
    const pathname = `${url.pathname}\n${decodedPathname}`;
    if (
      url.pathname.length > 320 || decodedPathname.length > 320 ||
      MUTATING_OR_SESSION_PATH.test(pathname) || MUTATING_SEGMENT.test(pathname) ||
      DIRECT_DOCUMENT_PATH.test(pathname)
    ) return undefined;
    for (const [key, queryValue] of [...url.searchParams.entries()]) {
      if (!SAFE_NUMERIC_PAGINATION_QUERY.test(key) || !/^\d{1,6}$/.test(queryValue)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function safeExplorationUrl(
  value: string,
  expectedOrigin: string,
  semanticLabel?: string,
  options: { allowBridgeIntent?: boolean } = {},
): string | undefined {
  try {
    const origin = exactPublicHttpsOrigin(expectedOrigin);
    const url = new URL(value, `${origin}/`);
    const label = boundedSemanticLabel(semanticLabel);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return undefined;
    const decodedPathname = safeDecodedExplorationPath(url.pathname);
    if (!decodedPathname) return undefined;
    // URL.pathname intentionally retains escapes. Route the policy over both
    // representations so a server-side decoded action (for example
    // /billing/%63ancel) cannot enter the authenticated exploration lane.
    const pathname = `${url.pathname}\n${decodedPathname}`;
    if (
      url.pathname.length > 320 || decodedPathname.length > 320 || (
        !BILLING_INTENT.test(pathname) && !BILLING_INTENT.test(label) &&
        !(options.allowBridgeIntent && BRIDGE_INTENT.test(`${pathname} ${label}`))
      ) ||
      MUTATING_OR_SESSION_PATH.test(pathname) || MUTATING_SEGMENT.test(pathname) ||
      DIRECT_DOCUMENT_PATH.test(pathname) || MUTATING_OR_SESSION_PATH.test(label) || MUTATING_SEGMENT.test(label)
    ) return undefined;
    for (const [key, queryValue] of [...url.searchParams.entries()]) {
      if (!SAFE_NUMERIC_PAGINATION_QUERY.test(key) || !/^\d{1,6}$/.test(queryValue)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Decode a route only for policy evaluation. Reject encoded delimiters and
 * malformed/repeated escapes rather than letting an upstream router interpret
 * a more dangerous pathname than the explorer validated. */
function safeDecodedExplorationPath(pathname: string): string | undefined {
  let decoded = pathname;
  for (let pass = 0; pass < 3; pass += 1) {
    if (/%(?:2f|5c)/i.test(decoded)) return undefined;
    if (!decoded.includes("%")) return decoded;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    } catch {
      return undefined;
    }
  }
  // A fourth encoded layer would be ambiguous at the navigation boundary.
  return /%[0-9a-f]{2}/i.test(decoded) ? undefined : decoded;
}

function addBest(targets: Map<string, ExplorationTarget>, target: ExplorationTarget): void {
  const current = targets.get(target.url);
  if (!current || target.score > current.score) targets.set(target.url, target);
}

function pathScore(pathname: string): number {
  let score = 0;
  if (/invoice|receipt/i.test(pathname)) score += 18;
  if (/billing/i.test(pathname)) score += 15;
  if (/history|statement|transaction/i.test(pathname)) score += 8;
  if (/payment|subscription/i.test(pathname)) score += 5;
  if (/settings|account/i.test(pathname)) score += 2;
  return score;
}

function semanticScore(label: string): number {
  return label ? Math.min(18, pathScore(`/${label}`)) : 0;
}

function boundedSemanticLabel(value: string | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 160) : "";
}

function boundedSemanticContext(value: string | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 240) : "";
}

function safePathname(value: string, origin: string): string {
  try {
    return new URL(value, `${origin}/`).pathname;
  } catch {
    return "";
  }
}

function exactPublicHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("exploration requires an exact HTTPS origin");
  }
  return url.origin;
}

function structuralRoute(value: string): string {
  try {
    const url = new URL(value, "https://checkpoint.invalid/");
    const segments = url.pathname.split("/").filter(Boolean).slice(0, 12).map((raw) => {
      let segment: string;
      try { segment = decodeURIComponent(raw); } catch { return ":segment"; }
      if (/^(?:app|v|t|home|dashboard|manage|admin|account|accounts|organization|organizations|org|workspace|workspaces|team|teams|settings|preferences|billing|billings|invoice|invoices|receipt|receipts|payment|payments|subscription|subscriptions|statement|statements|transaction|transactions|history|plans|login)$/i.test(segment)) {
        return segment.toLowerCase();
      }
      return /^(?:\d{4,}|[0-9a-f]{12,}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|(?:inv|invoice|receipt|rcpt|team|workspace|account)[_-][a-z0-9_-]{4,})$/i.test(segment)
        ? ":id"
        : ":segment";
    });
    const route = `/${segments.join("/")}`;
    return route.length <= 160 ? route : "/:segment";
  } catch {
    return "/:segment";
  }
}

function isSafeTargetKey(value: string): boolean {
  const [family, route, ...extra] = value.split("|");
  return extra.length === 0 && ENABLED_EXPLORATION_FAMILIES.includes(family as ExplorationFamily) &&
    isStructuralRoute(route) &&
    value.length <= 200;
}

function isStructuralRoute(route: string): boolean {
  if (route === "/") return true;
  if (!route.startsWith("/") || route.length > 160 || route.includes("?") || route.includes("#")) return false;
  return route.slice(1).split("/").every((segment) => segment === ":id" || segment === ":segment" ||
    /^(?:app|v|t|home|dashboard|manage|admin|account|accounts|organization|organizations|org|workspace|workspaces|team|teams|settings|preferences|billing|billings|invoice|invoices|receipt|receipts|payment|payments|subscription|subscriptions|statement|statements|transaction|transactions|history|plans|login)$/i.test(segment));
}

function normalizeFrontier(value: readonly ExplorationFrontierItem[], budget: ExplorationBudget): ExplorationFrontierItem[] {
  const seen = new Set<string>();
  const frontier: ExplorationFrontierItem[] = [];
  for (const item of value) {
    if (!item || typeof item.key !== "string" || !isSafeTargetKey(item.key) ||
      !ENABLED_EXPLORATION_FAMILIES.includes(item.family) || !Number.isInteger(item.score) || !Number.isInteger(item.depth) ||
      item.score < 0 || item.score > 10_000 || item.depth < 0 || item.depth > budget.depth || seen.has(item.key)) continue;
    const [family] = item.key.split("|");
    if (family !== item.family) continue;
    seen.add(item.key);
    frontier.push({ key: item.key, family: item.family, score: item.score, depth: item.depth });
    if (frontier.length >= budget.pages) break;
  }
  return frontier;
}
