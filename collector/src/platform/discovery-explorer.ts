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
export const EXPLORATION_DEADLINE_MS = 30_000;
export const DISCOVERY_ENGINE_REVISION = 22;

export type ExplorationPageSource = "entry" | "linked" | "common_route";

export interface ExplorationTarget {
  url: string;
  depth: number;
  source: ExplorationPageSource;
  score: number;
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

/** High-signal billing routes get a larger condition-based SPA render window
 * and a wider, still bounded resource sample. Other routes remain inexpensive. */
export function explorationProbeOptions(target: ExplorationTarget): ExplorationProbeOptions {
  const highSignal = /(?:^|\/)settings\/billing(?:\/|$)|invoice|receipt/i.test(new URL(target.url).pathname);
  return highSignal
    ? { settleMs: 5_000, maxResources: 12, deadlineMs: 7_000 }
    : { settleMs: 1_500, maxResources: 6, deadlineMs: 3_500 };
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

const COMMON_BILLING_PATHS = [
  "/account/billing/history",
  "/settings/billing",
  "/billing/history",
  "/account/billing",
  "/billing",
  "/invoices",
  "/receipts",
  "/settings/subscription",
] as const;

const CONTEXTUAL_BILLING_SUFFIXES = [
  "/billing/history",
  "/billing/subscriptions",
  "/billing",
  "/invoices",
  "/receipts",
  "/settings/billing",
] as const;
const TENANT_CONTAINER = /^(?:account|accounts|organization|organizations|workspace|workspaces|tenant|tenants|customer|customers)$/i;

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
}): ExplorationTarget[] {
  if (input.nextDepth < 1 || input.nextDepth > MAX_EXPLORATION_DEPTH) return [];
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
      score: (billing ? 100 : 85) + pathScore(new URL(url).pathname) + semanticScore(semantic) - (input.nextDepth - 1) * 3,
    });
  }

  if (input.includeCommonRoutes) {
    const contextPrefix = input.contextUrl ? tenantPrefixFromContext(input.contextUrl, origin) : undefined;
    if (contextPrefix) {
      for (const suffix of CONTEXTUAL_BILLING_SUFFIXES) {
        const url = new URL(`${contextPrefix}${suffix}`, `${origin}/`).toString();
        if (input.visited.has(url)) continue;
        addBest(targets, {
          url,
          depth: 1,
          source: "common_route",
          score: 80 + contextualPathScore(suffix),
        });
      }
    }
    for (const path of COMMON_BILLING_PATHS) {
      const url = new URL(path, `${origin}/`).toString();
      if (input.visited.has(url)) continue;
      addBest(targets, {
        url,
        depth: 1,
        source: "common_route",
        score: 60 + pathScore(path),
      });
    }
  }

  const ranked = rankExplorationQueue([...targets.values()]);
  const limit = Math.max(0, Math.min(MAX_EXPLORATION_PAGES - 1, input.limit ?? MAX_EXPLORATION_PAGES - 1));
  return ranked.slice(0, limit);
}

/** Rank the live frontier while preserving one early reviewed-route lane.
 * This must be applied after every insertion, not only inside the per-page
 * planner, because deeper linked targets can otherwise starve common routes. */
export function rankExplorationQueue(targets: readonly ExplorationTarget[]): ExplorationTarget[] {
  const ranked = [...targets]
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
  const commonIndex = ranked.findIndex((target) => target.source === "common_route");
  if (commonIndex < 0 || commonIndex <= 2) return ranked;
  const [commonRoute] = ranked.splice(commonIndex, 1);
  ranked.splice(Math.min(2, ranked.length), 0, commonRoute);
  return ranked;
}

function tenantPrefixFromContext(value: string, expectedOrigin: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== expectedOrigin || url.protocol !== "https:" || url.username || url.password) return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    const tenantIndex = segments.findIndex((segment) => isBoundedTenantIdentifierSegment(segment));
    if (tenantIndex < 0 || tenantIndex > 1) return undefined;
    if (tenantIndex === 1 && !TENANT_CONTAINER.test(segments[0])) return undefined;
    return `/${segments.slice(0, tenantIndex + 1).join("/")}`;
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

function contextualPathScore(pathname: string): number {
  return pathScore(pathname) + (/\/settings\/billing\/?$/i.test(pathname) ? 10 : 0);
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
