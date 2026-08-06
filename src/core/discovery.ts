import { z } from "zod";
import type { Extractor, RequestSpec, VendorRecipe } from "./types";
import { VendorRecipeSchema, validateRecipe } from "./schema";
import { deriveVendorId } from "./recorder/infer";
import { isSafeStaticDiscoveryQueryValue } from "./discovery-query";
import { documentProviderForUrl } from "./document-provider";
import {
  exactPublicHttpsOriginPattern,
  isExactPublicHttpsOriginPattern,
  isPublicHostname,
} from "./origin-policy";

export const DISCOVERED_SUPPLIER_SCHEMA = "ratatosk.discovered-supplier.v1" as const;
export const DISCOVERED_CANDIDATE_SET_SCHEMA = "ratatosk.discovery-candidates.v1" as const;
export const DISCOVERY_ADAPTERS = ["network-json", "embedded-json", "dom-links", "dom-actions"] as const;

const MAX_PROFILE_BYTES = 24 * 1024;
const MAX_CANDIDATE_SET_BYTES = 80 * 1024;
export const MAX_DISCOVERY_CANDIDATES = 3;
const MAX_HOSTS = 8;
const MAX_NAME_LENGTH = 80;
const SECRET_QUERY_KEY = /(?:^|_)(?:access_?token|api_?key|auth|authorization|code|credential|jwt|secret|session|sig|signature)(?:$|_)/i;
const SECRET_SCOPE_NAME = /(?:^|_)(?:token|secret|password|passwd|passcode|credential|private_?key|auth(?:orization)?|session|cookie|csrf|xsrf)(?:_|$)/i;
const DISCOVERED_SCOPE_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BILLING_ROUTE_SEGMENT = /^(?:billing|billings|invoice|invoices|receipt|receipts|payment|payments|subscription|subscriptions|statement|statements|transaction|transactions)$/i;
const BILLING_SPA_FRAGMENT = /(?:^|\/)(?:billing|billings|invoice|invoices|receipt|receipts|payment|payments|subscription|subscriptions|statement|statements|transaction|transactions)(?:\/|$)/i;
const UNSAFE_SPA_FRAGMENT = /(?:^|\/)(?:logout|log-out|signout|sign-out|delete|remove|cancel|checkout|purchase|upgrade|downgrade|authorize|oauth|callback|invite|payment[-_]?method)(?:\/|$)/i;
const SAFE_SPA_FRAGMENT_SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/;
const TENANT_PATH_CONTAINER = /^(?:account|accounts|organization|organizations|org|orgs|workspace|workspaces|team|teams|project|projects|tenant|tenants|customer|customers)$/i;
const TEMPLATE = /\{[A-Za-z_][A-Za-z0-9_]*\}/g;
const EXACT_HTTPS_HOST = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/\*$/;
const GRAPHQL_OPERATION_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/;
const MAX_DISCOVERED_GRAPHQL_BODY = 64 * 1024;

const discoveredSupplierProfileSchema = z
  .object({
    schema: z.literal(DISCOVERED_SUPPLIER_SCHEMA),
    id: z.string().regex(/^discovered-[a-z0-9][a-z0-9-]{0,67}$/),
    primaryOrigin: z.string().url(),
    entryUrl: z.string().url(),
    displayName: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    nameSource: z.enum(["page", "domain"]),
    nameConfidence: z.enum(["medium", "low"]),
    adapter: z.object({ id: z.enum(DISCOVERY_ADAPTERS), version: z.literal(1) }).strict(),
    candidateCount: z.number().int().min(1).max(500),
    discoveredAt: z.string().datetime(),
    recipe: VendorRecipeSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.recipe.id !== profile.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipe", "id"], message: "recipe id must match profile id" });
    }
    if (profile.recipe.name !== profile.displayName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipe", "name"], message: "recipe name must match display name" });
    }
    try {
      assertDiscoveredRecipePolicy(validateRecipe(profile.recipe), profile.primaryOrigin, profile.entryUrl);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipe"],
        message: error instanceof Error ? error.message : "recipe violates discovered-supplier policy",
      });
    }
  });

export type DiscoveryAdapterId = (typeof DISCOVERY_ADAPTERS)[number];
export type DiscoveredSupplierProfileV1 = z.infer<typeof discoveredSupplierProfileSchema> & { recipe: VendorRecipe };

const discoveredSupplierCandidateSetSchema = z.object({
  schema: z.literal(DISCOVERED_CANDIDATE_SET_SCHEMA),
  id: z.string().regex(/^discovered-[a-z0-9][a-z0-9-]{0,67}$/),
  primaryOrigin: z.string().url(),
  displayName: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  nameSource: z.enum(["page", "domain"]),
  nameConfidence: z.enum(["medium", "low"]),
  candidates: z.array(discoveredSupplierProfileSchema).min(1).max(MAX_DISCOVERY_CANDIDATES),
}).strict().superRefine((set, ctx) => {
  const origins = new Set<string>();
  for (const [index, candidate] of set.candidates.entries()) {
    if (
      candidate.id !== set.id || candidate.primaryOrigin !== set.primaryOrigin ||
      candidate.displayName !== set.displayName || candidate.nameSource !== set.nameSource ||
      candidate.nameConfidence !== set.nameConfidence
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates", index], message: "candidate identity must match its set" });
    }
    for (const host of candidate.recipe.hosts) origins.add(host);
  }
  if (origins.size > MAX_HOSTS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "candidate set requires too many origins" });
  }
});

export type DiscoveredSupplierCandidateSetV1 = Omit<z.infer<typeof discoveredSupplierCandidateSetSchema>, "candidates"> & {
  candidates: DiscoveredSupplierProfileV1[];
};

export function parseDiscoveredSupplierProfile(value: unknown): DiscoveredSupplierProfileV1 {
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size > MAX_PROFILE_BYTES) throw new Error("discovered supplier profile is too large");
  const profile = discoveredSupplierProfileSchema.parse(value);
  return { ...profile, recipe: validateRecipe(profile.recipe) } as DiscoveredSupplierProfileV1;
}

export function parseDiscoveredSupplierCandidateSet(value: unknown): DiscoveredSupplierCandidateSetV1 {
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size > MAX_CANDIDATE_SET_BYTES) throw new Error("discovered supplier candidate set is too large");
  const set = discoveredSupplierCandidateSetSchema.parse(value);
  return {
    ...set,
    candidates: set.candidates.map((candidate) => parseDiscoveredSupplierProfile(candidate)),
  } as DiscoveredSupplierCandidateSetV1;
}

export function createDiscoveredSupplierCandidateSet(
  candidates: readonly DiscoveredSupplierProfileV1[],
): DiscoveredSupplierCandidateSetV1 {
  const validated = candidates.map((candidate) => parseDiscoveredSupplierProfile(candidate));
  const first = validated[0];
  if (!first) throw new Error("discovery needs at least one candidate");
  const unique: DiscoveredSupplierProfileV1[] = [];
  const keys = new Set<string>();
  const origins = new Set<string>();
  for (const candidate of validated) {
    const key = candidateKey(candidate);
    if (keys.has(key)) continue;
    const nextOrigins = new Set([...origins, ...candidate.recipe.hosts]);
    // Keep the highest-ranked usable subset instead of discarding the entire
    // discovery when lower-ranked fallbacks would broaden the permission union.
    if (nextOrigins.size > MAX_HOSTS) continue;
    keys.add(key);
    unique.push(candidate);
    for (const origin of nextOrigins) origins.add(origin);
    if (unique.length >= MAX_DISCOVERY_CANDIDATES) break;
  }
  return parseDiscoveredSupplierCandidateSet({
    schema: DISCOVERED_CANDIDATE_SET_SCHEMA,
    id: first.id,
    primaryOrigin: first.primaryOrigin,
    displayName: first.displayName,
    nameSource: first.nameSource,
    nameConfidence: first.nameConfidence,
    candidates: unique,
  });
}

export function requiredCandidateOrigins(set: DiscoveredSupplierCandidateSetV1): string[] {
  return [...new Set(parseDiscoveredSupplierCandidateSet(set).candidates.flatMap((candidate) => candidate.recipe.hosts))];
}

/** Add a document origin only to candidates that prove the matching provider
 * or use the bounded semantic-action transport that produced the origin. */
export function extendCandidateDocumentOrigins(
  set: DiscoveredSupplierCandidateSetV1,
  origins: readonly string[],
): DiscoveredSupplierCandidateSetV1 {
  const validated = parseDiscoveredSupplierCandidateSet(set);
  const additions = [...new Set(origins)];
  if (!additions.length || additions.some((origin) => !isExactPublicHttpsOriginPattern(origin))) {
    throw new Error("candidate document origins are invalid");
  }
  const additionsByProvider = additions.map((origin) => {
    const provider = documentProviderForUrl(origin.slice(0, -2));
    return { origin, providerId: provider?.id };
  });
  const matchedAdditions = new Set<string>();
  const candidates = validated.candidates.map((candidate) => {
    const providerIds = new Set(candidate.recipe.hosts.flatMap((host) => {
      const provider = documentProviderForUrl(host.slice(0, -2));
      return provider ? [provider.id] : [];
    }));
    const semanticActionCandidate = candidate.adapter.id === "dom-actions" &&
      candidate.recipe.invoices.strategy === "dom" &&
      candidate.recipe.invoices.list.steps.some((step) => step.action === "extractSemanticDownloads");
    const matchingAdditions = additionsByProvider.filter(({ providerId }) =>
      (providerId !== undefined && providerIds.has(providerId)) || semanticActionCandidate);
    if (!matchingAdditions.length) return candidate;
    const copy = structuredClone(candidate);
    copy.recipe.hosts = [...new Set([...copy.recipe.hosts, ...matchingAdditions.map(({ origin }) => origin)])];
    for (const { origin } of matchingAdditions) matchedAdditions.add(origin);
    return parseDiscoveredSupplierProfile(copy);
  });
  if (matchedAdditions.size !== additions.length) throw new Error("candidate document origins are invalid");
  return parseDiscoveredSupplierCandidateSet({ ...validated, candidates });
}

export function createDiscoveredSupplierProfile(input: {
  primaryOrigin: string;
  entryUrl: string;
  displayName: string;
  nameSource: "page" | "domain";
  nameConfidence: "medium" | "low";
  adapterId: DiscoveryAdapterId;
  candidateCount: number;
  recipe: VendorRecipe;
  now?: Date;
}): DiscoveredSupplierProfileV1 {
  const entryUrl = safeEntryUrl(input.entryUrl);
  const id = discoveredSupplierId(input.primaryOrigin);
  const recipe = validateRecipe({
    ...input.recipe,
    id,
    name: input.displayName,
    homepage: input.primaryOrigin,
    category: "discovered",
    icon: undefined,
    fetchContext: "page",
    notes: "Locally discovered by Ratatosk using a packaged, bounded adapter.",
  });
  return parseDiscoveredSupplierProfile({
    schema: DISCOVERED_SUPPLIER_SCHEMA,
    id,
    primaryOrigin: input.primaryOrigin,
    entryUrl,
    displayName: input.displayName,
    nameSource: input.nameSource,
    nameConfidence: input.nameConfidence,
    adapter: { id: input.adapterId, version: 1 },
    candidateCount: input.candidateCount,
    discoveredAt: (input.now ?? new Date()).toISOString(),
    recipe,
  });
}

/**
 * Re-name a compiled profile without disturbing anything else about it.
 *
 * A candidate is compiled the moment its evidence is sufficient, which is
 * usually before every page has been seen. The recipe is settled at that point;
 * the name is not, because naming improves with corroboration. Applying the
 * finished run's name to the whole set also keeps the candidates in agreement,
 * which `createDiscoveredSupplierCandidateSet` requires.
 */
export function withSupplierDisplayName(
  profile: DiscoveredSupplierProfileV1,
  display: { name: string; source: "page" | "domain"; confidence: "medium" | "low" },
): DiscoveredSupplierProfileV1 {
  if (profile.displayName === display.name) return profile;
  return parseDiscoveredSupplierProfile({
    ...profile,
    displayName: display.name,
    nameSource: display.source,
    nameConfidence: display.confidence,
    recipe: { ...profile.recipe, name: display.name },
  });
}

export interface SupplierNameObservation {
  title?: string;
  applicationName?: string;
  siteName?: string;
}

const MAX_NAME_OBSERVATIONS = 24;

/**
 * Name a supplier from what several of its own pages agree on.
 *
 * One page title is a weak identifier. An application's billing route is as
 * likely to be titled "Overview" as anything else, and that word says nothing
 * about who issued the invoice — `dashboard.clerk.com` was named "Overview" for
 * exactly this reason. Taking the first page's title also made the name depend
 * on probe ordering, so the same supplier could be named differently run to run.
 *
 * A page-derived name therefore has to be corroborated before it outranks the
 * domain, which is the one identifier the browser has already verified:
 *
 *   1. a name whose opening words are the registrable label ("Clerk" at
 *      `clerk.com`) — two independent sources naming the same party;
 *   2. a title fragment that survives across *differing* pages, since the part
 *      that stays constant is the brand and the part that changes is the route;
 *   3. `og:site_name` or `application-name`, which a site declares for itself
 *      rather than for one page;
 *   4. the domain label.
 *
 * An uncorroborated title fragment ranks below the domain and is reached only
 * when the origin yields no label at all. Nothing here is supplier-specific:
 * every rule is about how many independent sources agree.
 */
export function deriveSupplierDisplayName(input: {
  origin: string;
  applicationName?: string;
  siteName?: string;
  title?: string;
  observations?: readonly SupplierNameObservation[];
}): { name: string; source: "page" | "domain"; confidence: "medium" | "low" } {
  const observations = (input.observations ?? [{
    title: input.title,
    applicationName: input.applicationName,
    siteName: input.siteName,
  }]).slice(0, MAX_NAME_OBSERVATIONS);
  const label = domainNameLabel(input.origin);

  const declared: string[] = [];
  const titles = new Set<string>();
  for (const observation of observations) {
    for (const raw of [observation.applicationName, observation.siteName]) {
      const name = cleanPageName(raw);
      if (name) declared.push(name);
    }
    const title = observation.title?.replace(/\s+/g, " ").trim();
    if (title) titles.add(title);
  }
  // Distinct titles only: the same page probed twice corroborates nothing.
  const fragmentsByPage = [...titles].map((title) => pageNameFragments(title));

  for (const candidate of [...declared, ...fragmentsByPage.flat()]) {
    const corroborated = matchDomainLabel(candidate, label.id);
    if (corroborated) return { name: corroborated, source: "page", confidence: "medium" };
  }

  const stable = stableAcrossPages(fragmentsByPage);
  if (stable) return { name: stable, source: "page", confidence: "medium" };

  if (declared[0]) return { name: declared[0], source: "page", confidence: "medium" };
  if (label.name) return { name: label.name, source: "domain", confidence: "low" };

  const uncorroborated = fragmentsByPage.flat()[0];
  return uncorroborated
    ? { name: uncorroborated, source: "page", confidence: "low" }
    : { name: "Discovered Supplier", source: "domain", confidence: "low" };
}

/** The registrable label, as both a comparison key and a display name. */
function domainNameLabel(origin: string): { id: string; name: string } {
  try {
    new URL(origin);
  } catch {
    return { id: "", name: "" };
  }
  const id = deriveVendorId(origin);
  const name = id.replace(/(^|-)([a-z])/g, (_match, separator: string, letter: string) => `${separator ? " " : ""}${letter.toUpperCase()}`);
  return { id, name };
}

/**
 * Match a page name against the domain label, tolerating the ways a brand gets
 * spaced or punctuated: "My Vendor" corroborates `my-vendor.com`, "Clerk"
 * corroborates `clerk.com`. What follows the label is kept — "Example Cloud" is
 * the supplier's name, not "Example" — except for a trailing page word, which
 * makes "Clerk Dashboard" resolve to "Clerk".
 */
function matchDomainLabel(candidate: string, labelId: string): string | undefined {
  const target = normalizeNameWord(labelId);
  if (!target) return undefined;
  const words = candidate.split(/\s+/).filter(Boolean);
  let joined = "";
  for (let index = 0; index < words.length; index += 1) {
    joined += normalizeNameWord(words[index]);
    if (joined === target) {
      let end = words.length;
      while (end > index + 1 && GENERIC_NAME.test(words[end - 1])) end -= 1;
      return words.slice(0, end).join(" ").slice(0, MAX_NAME_LENGTH);
    }
    if (!target.startsWith(joined)) return undefined;
  }
  return undefined;
}

/** The fragment repeated across the most distinct pages, shortest first — the
 * part of a title that does not change is the part that names the supplier. */
function stableAcrossPages(fragmentsByPage: readonly string[][]): string | undefined {
  if (fragmentsByPage.length < 2) return undefined;
  const counts = new Map<string, { name: string; pages: number }>();
  for (const fragments of fragmentsByPage) {
    for (const fragment of new Set(fragments)) {
      const entry = counts.get(fragment.toLowerCase()) ?? { name: fragment, pages: 0 };
      entry.pages += 1;
      counts.set(fragment.toLowerCase(), entry);
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.pages >= 2)
    .sort((left, right) => right.pages - left.pages || left.name.length - right.name.length)[0]?.name;
}

function normalizeNameWord(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function safeEntryUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("discovery requires a normal HTTPS supplier page");
  const fragment = url.search ? "" : safeBillingSpaFragment(url.hash);
  url.search = "";
  url.hash = fragment;
  if (hasUnsafeCredentialPath(url.pathname, 96)) url.pathname = "/";
  return url.toString();
}

/**
 * Preserve only a route-shaped billing fragment. Some SPAs expose billing as
 * `#settings/Billing`; dropping that route makes a verified generic recipe
 * reopen the home page on every later sync. Query-like, encoded, mutating, and
 * credential-shaped fragments remain excluded from persisted discovery state.
 */
function safeBillingSpaFragment(value: string): string {
  if (!value) return "";
  const raw = value.slice(1);
  if (
    raw.length === 0 || raw.length > 240 ||
    /[?=&%\\]/.test(raw) ||
    !BILLING_SPA_FRAGMENT.test(raw) ||
    UNSAFE_SPA_FRAGMENT.test(raw)
  ) return "";
  const route = raw.startsWith("/") ? raw.slice(1) : raw;
  const segments = route.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) =>
    !SAFE_SPA_FRAGMENT_SEGMENT.test(segment) || looksCredentialLike(segment)
  )) return "";
  return `#${raw}`;
}

/** Preserve an already-persisted source namespace while refreshing mutable
 * discovery metadata and recipe behavior for the same supplier origin. */
export function reuseDiscoveredSupplierIdentity(
  profile: DiscoveredSupplierProfileV1,
  existing: DiscoveredSupplierProfileV1 | undefined,
): DiscoveredSupplierProfileV1 {
  if (!existing || existing.primaryOrigin !== profile.primaryOrigin || existing.id === profile.id) return profile;
  return parseDiscoveredSupplierProfile({
    ...profile,
    id: existing.id,
    recipe: { ...profile.recipe, id: existing.id },
  });
}

export function exactOriginPattern(origin: string): string {
  try {
    return exactPublicHttpsOriginPattern(origin);
  } catch {
    throw new Error("supplier origin must be exact HTTPS");
  }
}

export function assertDiscoveredRecipePolicy(recipe: VendorRecipe, primaryOrigin: string, entryUrl: string): void {
  const primary = new URL(primaryOrigin);
  if (primary.protocol !== "https:" || primary.origin !== primaryOrigin) throw new Error("primary origin must be exact HTTPS");
  if (new URL(entryUrl).origin !== primaryOrigin) throw new Error("entry page must stay on the primary origin");
  if (safeEntryUrl(entryUrl) !== entryUrl) throw new Error("entry page cannot contain query, fragment, or credential-like path data");
  if (new URL(recipe.homepage).origin !== primaryOrigin) throw new Error("recipe homepage must match the primary origin");
  if (recipe.fetchContext !== "page") throw new Error("discovered recipes must use the first-party page transport");
  if (recipe.icon) throw new Error("discovered recipes cannot provide remote or unreviewed logos");
  assertSafeDiscoveredTokenExchange(recipe);
  if (recipe.hosts.length > MAX_HOSTS || new Set(recipe.hosts).size !== recipe.hosts.length) {
    throw new Error("discovered recipes have too many or duplicate origins");
  }

  const allowedOrigins = new Set<string>();
  for (const host of recipe.hosts) {
    const parsed = new URL(host.slice(0, -2));
    if (!EXACT_HTTPS_HOST.test(host) || host.includes("*.") || !isPublicHostname(parsed.hostname)) {
      throw new Error("discovered recipes require exact public HTTPS origins");
    }
    allowedOrigins.add(parsed.origin);
  }
  if (!allowedOrigins.has(primaryOrigin)) throw new Error("primary origin is missing from recipe permissions");

  const requests: RequestSpec[] = [recipe.auth.check.request];
  if (recipe.auth.token) requests.push(recipe.auth.token.request);
  for (const option of recipe.config ?? []) assertSafeDiscoveredScope(option, allowedOrigins);
  if (recipe.invoices.strategy === "network") requests.push(recipe.invoices.list.request);
  if (recipe.invoices.strategy === "html") requests.push(recipe.invoices.list.request);
  if (recipe.invoices.document.request) requests.push(recipe.invoices.document.request);

  for (const request of requests) assertSafeRequest(request, allowedOrigins);
  if (!("statusIn" in recipe.auth.check.expect) || recipe.auth.check.expect.statusIn.some((status) => status < 200 || status >= 400)) {
    throw new Error("discovered auth checks must use a bounded success status list");
  }

  if (recipe.invoices.strategy === "dom") {
    const { list } = recipe.invoices;
    if (safeEntryUrl(list.open) !== list.open) throw new Error("DOM discovery page cannot contain query, fragment, or credential-like path data");
    if (list.steps.length < 1 || list.steps.length > 4) throw new Error("DOM discovery has too many steps");
    for (const step of list.steps) {
      if ((step as { action: string }).action === "click") {
        throw new Error("discovered recipes cannot click page controls automatically");
      }
      if ("selector" in step && step.selector.length > 400) throw new Error("DOM selector is too large");
      if (step.action === "waitFor" && (step.timeoutMs ?? 0) > 10_000) throw new Error("DOM wait exceeds the discovery budget");
      if (step.action === "extractAll" && step.attr !== "href") throw new Error("DOM discovery may extract only document links");
      if (step.action === "extractSemanticDownloads" && (step.maxActions ?? 8) > 12) {
        throw new Error("DOM semantic action budget is too large");
      }
    }
    if (list.steps.filter((step) => step.action === "extractSemanticDownloads").length > 1) {
      throw new Error("DOM discovery may use only one semantic download primitive");
    }
    if (list.continuation) {
      if (list.continuation.mode !== "auto") throw new Error("DOM discovery continuation must use the packaged auto mode");
      if ((list.continuation.maxActions ?? 8) > 12) throw new Error("DOM continuation exceeds the action budget");
      if ((list.continuation.maxDocuments ?? 500) > 500) throw new Error("DOM continuation exceeds the document budget");
      if ((list.continuation.timeoutMs ?? 30_000) > 60_000) throw new Error("DOM continuation exceeds the time budget");
    }
  }
}

/**
 * A discovered recipe may exchange the user's own session for the short-lived
 * bearer that same site issues to itself — and nothing more.
 *
 * The credential is never stored: what persists is the *instruction* to fetch it
 * from an endpoint that rides the cookie, and `resolveAuthToken` re-mints it at
 * the start of every run and holds it in that run's variables. So the cookie
 * remains the only thing that proves identity; the token is a derivative with
 * the lifetime of one collection.
 *
 * The risk in automatic discovery was never the token's existence. It was that
 * a page it observed could influence *which* endpoint mints one and *where* it
 * is then sent. These rules remove that freedom:
 *
 *   - the minting request is a plain same-origin GET with no body and no
 *     headers, so it can only ever be a read of the site's own session;
 *   - every request that carries the token is on that same origin, so the token
 *     can never be forwarded to a second host the evidence named;
 *   - the token variable is `token`, referenced only from an `authorization`
 *     header, so it cannot be smuggled into a URL, a query value, or a body
 *     where it would be logged or persisted by something downstream.
 *
 * Admission is still not proof. `previewCandidate` has to mint the token and
 * come back with real invoices before the candidate is retained at all.
 */
function assertSafeDiscoveredTokenExchange(recipe: VendorRecipe): void {
  const token = recipe.auth.token;
  if (!token) return;
  const variable = token.as ?? "token";
  if (variable !== "token") throw new Error("discovered token exchange must bind the reviewed token variable");

  const method = token.request.method ?? "GET";
  if (method !== "GET" || token.request.body || Object.keys(token.request.headers ?? {}).length) {
    throw new Error("discovered token exchange must be a plain GET that rides the existing session");
  }
  const source = new URL(token.request.url.replace(TEMPLATE, "x"));
  if (source.origin !== new URL(recipe.homepage).origin) {
    throw new Error("discovered token exchange must read the supplier's own origin");
  }
  const path = typeof token.value === "string" ? token.value : token.value.path;
  if (typeof token.value !== "string" && token.value.transforms?.length) {
    throw new Error("discovered token exchange cannot transform the credential");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path) || path.length > 160) {
    throw new Error("discovered token exchange must read a named response field");
  }

  const marker = `{${variable}}`;
  for (const request of tokenBearingRequests(recipe)) {
    const carries = Object.values(request.headers ?? {}).some((value) => value.includes(marker));
    if (!carries) continue;
    if (Object.entries(request.headers ?? {}).some(([name, value]) =>
      value.includes(marker) && name.toLowerCase() !== "authorization")) {
      throw new Error("a discovered token may only be sent as an authorization header");
    }
    if (new URL(request.url.replace(TEMPLATE, "x")).origin !== source.origin) {
      throw new Error("a discovered token may only be sent to the origin that issued it");
    }
  }
  if ([...tokenBearingRequests(recipe)].some((request) =>
    request.url.includes(marker) || (request.body ?? "").includes(marker))) {
    throw new Error("a discovered token may not be placed in a URL or request body");
  }
}

function* tokenBearingRequests(recipe: VendorRecipe): Generator<RequestSpec> {
  yield recipe.auth.check.request;
  for (const option of recipe.config ?? []) yield option.discover.request;
  if (recipe.invoices.strategy !== "dom") yield recipe.invoices.list.request;
  if (recipe.invoices.document.request) yield recipe.invoices.document.request;
}

function assertSafeRequest(request: RequestSpec, allowedOrigins: Set<string>): void {
  const method = request.method ?? "GET";
  if (method === "GET") {
    if (request.body) throw new Error("discovered GET requests cannot persist request bodies");
    // The one header a GET may carry is the templated authorization the token
    // exchange fills in at run time. It holds no value at rest, and
    // `assertSafeDiscoveredTokenExchange` has already bound it to one origin.
    const headers = Object.entries(request.headers ?? {});
    if (headers.some(([name, value]) => name.toLowerCase() !== "authorization" || value !== "Bearer {token}")) {
      throw new Error("discovered GET requests cannot persist request headers");
    }
  } else if (!isSafeReadOnlyGraphqlRequest(request)) {
    throw new Error("discovered POST requests must be an explicit read-only GraphQL query");
  }
  const rendered = request.url.replace(TEMPLATE, "x");
  const url = new URL(rendered);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("discovered request URL is not safe HTTPS");
  if (!allowedOrigins.has(url.origin)) throw new Error("discovered request targets an unapproved origin");
  if (hasUnsafeCredentialPath(url.pathname, 160)) {
    throw new Error("discovered request contains credential-like path data");
  }
  assertSafePathTemplates(request.url);
  for (const [key, value] of url.searchParams) if (!isSafeDiscoveredQueryValue(key, value)) {
    throw new Error("discovered request contains credential-like query data");
  }
}

/**
 * A query parameter a discovered recipe may replay.
 *
 * Real billing endpoints address themselves with query data — a GraphQL
 * operation name, a year, a status filter, a page cursor, a tenant id. An
 * allowlist of parameter *names* cannot enumerate those, and dropping them does
 * not produce a safer request, it produces a request for the wrong resource. So
 * the rule is a denial: names that mean "credential", values shaped like a
 * credential, and anything unbounded are refused; ordinary addressing data is
 * kept.
 */
function isSafeDiscoveredQueryValue(key: string, value: string): boolean {
  if (isSecretScopeName(key) || value.length > 160) return false;
  // Filled at run time from a config scope discovery, so it holds no captured
  // identity at rest.
  if (value.includes("{")) return true;
  if (isSafeStaticDiscoveryQueryValue(key, value)) return true;
  // One bounded tenant identifier, the same shape a first-party billing path may
  // already carry, when the parameter says that is what it is.
  if (isTenantScopeName(key) && isBoundedTenantIdentifierSegment(value)) return true;
  // Otherwise the value must read as route structure: an operation name, an
  // enum, a date, a slug, a page number. The charset is what keeps free text,
  // email addresses, and anything with whitespace out, and `looksCredentialLike`
  // is the shared test for an opaque capability string. A run of digits is an
  // identifier or a timestamp rather than a secret, so it stays admissible.
  return STRUCTURAL_QUERY_VALUE.test(value) && (!looksCredentialLike(value) || /^\d{1,20}$/.test(value));
}

const STRUCTURAL_QUERY_VALUE = /^[A-Za-z0-9_.:+-]{1,64}$/;

function isTenantScopeName(value: string): boolean {
  return /^(?:workspace|organization|org|team|project|tenant|account|customer)s?(?:_id)?$/.test(normalizedPolicyKey(value));
}

function assertSafePathTemplates(rawUrl: string): void {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(rawUrl).pathname);
  } catch {
    // `assertSafeRequest` performs the canonical URL validation immediately
    // afterward; fail closed here if the raw template URL cannot be inspected.
    throw new Error("discovered request path templates are invalid");
  }
  const segments = pathname.split("/").filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    const templateNames = [...segment.matchAll(TEMPLATE)].map((match) => match[0].slice(1, -1));
    if (!templateNames.length) continue;
    const previous = segments[index - 1] ?? "";
    const next = segments[index + 1] ?? "";
    if (isSecretScopeName(segment) || isSecretScopeName(previous) || isSecretScopeName(next) || templateNames.some(isSecretScopeName)) {
      throw new Error("discovered request contains credential-like path templates");
    }
    // Discovery may parameterize a tenant/workspace identifier but never an
    // arbitrary capability-like path segment. This preserves ordinary
    // `/teams/{teamId}/billing` retrieval while rejecting `/download/{token}`.
    if (segment !== `{${templateNames[0]}}` || !TENANT_PATH_CONTAINER.test(previous)) {
      throw new Error("discovered request path templates must be tenant identifiers");
    }
  }
}

function assertSafeDiscoveredScope(option: NonNullable<VendorRecipe["config"]>[number], allowedOrigins: Set<string>): void {
  if (!DISCOVERED_SCOPE_ID.test(option.id) || isSecretScopeName(option.id)) {
    throw new Error("discovered config scope name is not allowed");
  }
  const extractors: Extractor[] = [option.discover.value];
  if (option.discover.label) extractors.push(option.discover.label);
  if (option.discover.items) extractors.push(option.discover.items);
  for (const extractor of extractors) {
    const path = typeof extractor === "string" ? extractor : extractor.path;
    if (path.split(/[.\[\]/]+/).some(isSecretScopeName)) {
      throw new Error("discovered config scope cannot extract credential data");
    }
  }
  assertTypedDiscoveredScopeValue(option.id, option.discover.value);
  assertSafeRequest(option.discover.request, allowedOrigins);
}

function assertTypedDiscoveredScopeValue(scopeId: string, extractor: Extractor): void {
  if (typeof extractor !== "string" && extractor.transforms?.length) {
    throw new Error("discovered config scope values cannot use transforms");
  }
  const path = typeof extractor === "string" ? extractor : extractor.path;
  const parts = path
    .split(/[.\[\]/]+/)
    .filter((part) => part && !/^\d+$/.test(part))
    .map(normalizedPolicyKey);
  const leaf = parts.at(-1) ?? "";
  const pathFamily = parts.map(discoveredScopeFamily).find((family): family is string => Boolean(family));
  const scope = normalizedPolicyKey(scopeId);
  const expectedFamily = discoveredScopeFamily(scope);
  const genericId = scope === "id";
  const isTypedLeaf = expectedFamily !== undefined && leaf === `${expectedFamily}_id`;
  const isNestedId = leaf === "id" && pathFamily !== undefined && (
    genericId || pathFamily === expectedFamily
  );
  const isNamedScope = expectedFamily !== undefined && scope === expectedFamily && isNestedId;
  if (!isTypedLeaf && !isNestedId && !isNamedScope) {
    throw new Error("discovered config scope value must be a typed tenant identifier");
  }
}

function discoveredScopeFamily(value: string): string | undefined {
  const match = /^(workspace|organization|org|team|project|tenant|account|customer)s?(?:_?id)?$/.exec(value);
  return match?.[1];
}

function isSecretScopeName(value: string): boolean {
  const normalized = normalizedPolicyKey(value);
  return SECRET_QUERY_KEY.test(normalized) || SECRET_SCOPE_NAME.test(normalized);
}

/**
 * The only POST shape automatic discovery may persist. This deliberately does
 * not try to classify arbitrary REST actions: an explicit GraphQL `query`
 * operation is structurally read-only, while mutation/subscription operations,
 * persisted-query extensions, arbitrary headers, and opaque variable values
 * are rejected.
 */
export function isSafeReadOnlyGraphqlRequest(request: RequestSpec): boolean {
  if (request.method !== "POST" || typeof request.body !== "string" || request.body.length > MAX_DISCOVERED_GRAPHQL_BODY) return false;
  const headers = Object.entries(request.headers ?? {});
  if (headers.length !== 1 || headers[0][0].toLowerCase() !== "content-type" || headers[0][1].toLowerCase() !== "application/json") return false;

  let body: unknown;
  try { body = JSON.parse(request.body); } catch { return false; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["query", "variables", "operationName"].includes(key))) return false;
  if (typeof record.query !== "string" || record.query.length > 48 * 1024) return false;
  const query = record.query.replace(/#[^\r\n]*/g, " ").trim();
  if (!/^query(?:\s+[_A-Za-z][_0-9A-Za-z]*)?\s*(?:\([^)]*\)\s*)?\{/s.test(query)) return false;
  if (/\b(?:mutation|subscription)\b/i.test(query)) return false;
  if (!isLiteralFreeGraphqlQuery(query)) return false;
  if (record.operationName !== undefined && (typeof record.operationName !== "string" || !GRAPHQL_OPERATION_NAME.test(record.operationName))) return false;
  return record.variables === undefined || isSafeGraphqlVariables(record.variables);
}

/**
 * Automatic discovery persists only an identity-free GraphQL subset.
 *
 * No quoted string may appear at all, so a captured customer ID, email, or
 * signed token can never survive as a literal. What remains is the vocabulary a
 * real billing query needs in order to be the query the application actually
 * sent: `$variables`, a page size, a boolean, and a schema enum. Rejecting those
 * too did not protect anything — an unquoted `PAID` is not an account — it just
 * meant a portal whose invoice query takes any argument had no candidate at all.
 *
 * Numbers stay short and enums stay digit-free, so an unquoted account number
 * cannot pass as either. Reviewed packaged recipes retain the full vocabulary.
 */
const GRAPHQL_ARGUMENT_VALUE = /^(?:\$[_A-Za-z][_0-9A-Za-z]*|\d{1,4}|true|false|null|[A-Za-z_][A-Za-z_]{0,31})$/;

function isLiteralFreeGraphqlQuery(query: string): boolean {
  if (/["']/.test(query)) return false;
  // The negative lookbehind distinguishes `$workspaceId: ID!` in an operation
  // definition, which names a type, from `workspaceId: $workspaceId` in a field
  // argument, which supplies a value. An inline input object yields an empty
  // capture and is rejected: its shape is exactly what the variable policy
  // declines to reason about.
  for (const argument of query.matchAll(/(?<![$\w])[_A-Za-z][_0-9A-Za-z]*\s*:\s*([^\s,){]*)/g)) {
    if (!GRAPHQL_ARGUMENT_VALUE.test(argument[1])) return false;
  }
  return true;
}

function isSafeGraphqlVariables(value: unknown, key = "", depth = 0, seen = { nodes: 0 }): boolean {
  if (depth > 8 || ++seen.nodes > 200) return false;
  if (key && isSecretScopeName(key)) return false;
  if (value === null) return isPaginationVariable(key);
  if (typeof value === "boolean") return isBooleanGraphqlVariable(key);
  if (typeof value === "number") return isBoundedPaginationNumber(key, value);
  if (typeof value === "string") return isSafeGraphqlStringVariable(key, value);
  // Nested filter inputs and arrays can carry arbitrary tenant/account values.
  // Automatic discovery persists only the small flat variable subset below;
  // richer shapes require an explicitly reviewed vendor recipe.
  if (Array.isArray(value)) return false;
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 50 && entries.every(([childKey, child]) => (
    GRAPHQL_OPERATION_NAME.test(childKey) && isSafeGraphqlVariables(child, childKey, depth + 1, seen)
  ));
}

function normalizedPolicyKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

function isPaginationVariable(key: string): boolean {
  return /^(?:after|before|cursor|page_token|next_cursor)$/i.test(normalizedPolicyKey(key));
}

function isBooleanGraphqlVariable(key: string): boolean {
  return /^(?:include_(?:archived|deleted|inactive)|with_[a-z_]+)$/i.test(normalizedPolicyKey(key));
}

function isBoundedPaginationNumber(key: string, value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 500 && /^(?:first|last|limit|offset|page|page_size)$/i.test(normalizedPolicyKey(key));
}

function isSafeGraphqlStringVariable(key: string, value: string): boolean {
  if (value.length > 160 || isSecretScopeName(key)) return false;
  const normalized = normalizedPolicyKey(key);
  // A template names a runtime config scope; the value it stands for is
  // discovered per user and never captured, so any non-secret variable may
  // carry one. Literals are what must stay narrow.
  if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return true;
  // The same bounded tenant identifier a first-party billing route may already
  // carry in its own path is acceptable as a scope literal when discovery could
  // not trace the endpoint that mints it.
  if (isTenantScopeName(normalized) && isBoundedTenantIdentifierSegment(value)) return true;
  return /^(?:status|type|sort|order|state|interval|period|currency)$/i.test(normalized) &&
    /^[a-z][a-z0-9_-]{0,31}$/i.test(value);
}

/** Words that name a page rather than the party that issued the invoice. */
const GENERIC_NAME = /^(?:account|billing|billing portal|dashboard|home|invoice|invoices|payments?|receipts?|settings|subscription)$/i;

/**
 * Split a title into the parts that could name a supplier. Titles are
 * conventionally "<page> | <brand>", so every separated piece is a candidate
 * and the caller decides which one the evidence supports.
 */
function pageNameFragments(raw: string): string[] {
  return raw
    .replace(/\s+/g, " ")
    .split(/\s+[|·–—]\s+|\s+-\s+/)
    .map((piece) => piece.trim())
    .filter((piece) =>
      piece.length >= 2 && piece.length <= MAX_NAME_LENGTH &&
      !GENERIC_NAME.test(piece) && !/sign in|log in|customer portal/i.test(piece))
    .map((piece) => piece.slice(0, MAX_NAME_LENGTH));
}

function cleanPageName(raw: string | undefined): string | undefined {
  return raw ? pageNameFragments(raw)[0] : undefined;
}

function discoveredSupplierId(origin: string): string {
  const slug = deriveVendorId(origin).slice(0, 38) || "supplier";
  // One canonical origin represents one provisional supplier. Display names,
  // locale, page titles, and candidate routes are mutable presentation data.
  const hash = fnv1a(new URL(origin).origin.toLowerCase());
  return `discovered-${slug}-${hash}`;
}

function candidateKey(profile: DiscoveredSupplierProfileV1): string {
  const invoices = profile.recipe.invoices;
  const listIdentity = invoices.strategy === "dom" ? invoices.list.open : invoices.list.request.url;
  return `${profile.adapter.id}|${invoices.strategy}|${listIdentity}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 7);
}

function looksCredentialLike(value: string): boolean {
  if (value.includes("{")) return false;
  try {
    return /^(?:eyJ[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,}|[0-9a-f]{32,}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|\d{7,})$/i.test(decodeURIComponent(value));
  } catch {
    return true;
  }
}

function hasUnsafeCredentialPath(pathname: string, maxSegmentLength: number): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const credentialIndexes = segments
    .map((segment, index) => looksCredentialLike(segment) ? index : -1)
    .filter((index) => index >= 0);
  return segments.some((segment, index) => (
    segment.length > maxSegmentLength ||
    (looksCredentialLike(segment) && !isBoundedBillingTenantIdentifier(segments, credentialIndexes, index))
  ));
}

function isBoundedBillingTenantIdentifier(segments: string[], credentialIndexes: number[], index: number): boolean {
  // Some first-party portals put a non-secret account identifier in the path,
  // e.g. /<cloudflare-account-id>/billing/subscriptions. Permit one narrowly
  // shaped identifier only when a later path segment has explicit billing
  // intent. JWTs and general opaque strings remain rejected.
  if (credentialIndexes.length !== 1) return false;
  const value = segments[index];
  if (!isBoundedTenantIdentifierSegment(value)) return false;
  // A root-level opaque segment has no structural tenant context and is
  // indistinguishable from a capability token. Generic discovery must not
  // bless it merely because a later route says "billing".
  if (index === 0 || !TENANT_PATH_CONTAINER.test(segments[index - 1])) return false;
  return segments.slice(index + 1).some((segment) => BILLING_ROUTE_SEGMENT.test(segment));
}

export function isBoundedTenantIdentifierSegment(value: string): boolean {
  return /^(?:[0-9a-f]{24}|[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|\d{7,20})$/i.test(value);
}

export { discoveredSupplierProfileSchema };
