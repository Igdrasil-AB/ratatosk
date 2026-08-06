import {
  createDiscoveredSupplierCandidateSet,
  createDiscoveredSupplierProfile,
  deriveSupplierDisplayName,
  exactOriginPattern,
  MAX_DISCOVERY_CANDIDATES,
  safeEntryUrl,
  reuseDiscoveredSupplierIdentity,
  withSupplierDisplayName,
  type DiscoveryAdapterId,
  type DiscoveredSupplierCandidateSetV1,
  type DiscoveredSupplierProfileV1,
  type SupplierNameObservation,
} from "../../../src/core/discovery";
import { extract } from "../../../src/core/extract";
import { assertAuthenticated, resolveAuthToken } from "../../../src/core/auth";
import { AuthExpired, AuthFailure } from "../../../src/core/errors";
import { getArray } from "../../../src/core/jsonpath";
import { inferRecipe } from "../../../src/core/recorder/infer";
import type { CapturedEntry, DraftRecipe } from "../../../src/core/recorder/types";
import { validateRecipe } from "../../../src/core/schema";
import type { InvoiceRef, VendorRecipe } from "../../../src/core/types";
import { DEFAULT_SAFE_CONCURRENCY, mapConcurrentInSettleOrder, mapConcurrentOrdered } from "../../../src/core/concurrency";
import {
  canonicalDocumentProviderUrl,
  documentProviderForUrl,
  STRIPE_KNOWN_DOCUMENT_HOSTS,
} from "../../../src/core/document-provider";
import { buildRunContext, buildStrategies } from "./runtime";
import {
  DISCOVERY_DIAGNOSTIC_SCHEMA,
  parseDiscoveryDiagnostic,
  toDiagnosticRoute,
  type DiscoveryAttemptEvidence,
  type DiscoveryAttemptResult,
  type DiscoveryDiagnosticV1,
  type CandidateAdmissionSignal,
} from "./discovery-diagnostic";
import {
  entryProbeOptions,
  EXPLORATION_ROUTE_POLICY,
  capExplorationProbeOptions,
  createExplorationCheckpoint,
  ENABLED_EXPLORATION_FAMILIES,
  explorationBudget,
  explorationFamilyForTarget,
  explorationProbeOptions,
  explorationTargetKey,
  planExplorationTargets,
  rankExplorationQueue,
  runWithinExplorationBudget,
  safeExplorationUrl,
  safeReplayUrl,
  type ExplorationCheckpoint,
  type ExplorationFamily,
  type ExplorationLinkEvidence,
  type ExplorationMode,
  type ExplorationPageSource,
  type ExplorationTarget,
} from "./discovery-explorer";
import { COLLECTOR_RUNTIME_IDENTITY, formatCollectorRuntimeIdentity } from "./collector-runtime-identity";
import discoveryPageObserverScript from "./discovery-page-observer?script&iife";
import { getDiscoveredSuppliers } from "./discovered-suppliers";
import { getRememberedRoute } from "./discovery-route-memory";
import { DISCOVERY_DOM_POLICY } from "./discovery-dom-policy";
import { withForegroundTabVisibility } from "./tab-visibility";
import { DocumentActionController } from "./document-action-controller";

/**
 * Every provider host that admission can accept as a document link.
 *
 * Derived from the provider policy so a host can never be admissible as
 * evidence yet unmatchable when the compiled recipe reopens the page.
 */
const PROVIDER_DOCUMENT_LINK_SELECTORS = STRIPE_KNOWN_DOCUMENT_HOSTS.map(
  (host) => `a[href*="//${new URL(host.slice(0, -2)).host}/" i]`,
);

/**
 * The single matcher for document links.
 *
 * It must stay a superset of what `findLikelyDocumentLinks` admits. Admission
 * additionally requires invoice context, so this selector is deliberately the
 * broader of the two: a narrower one turns a correct billing page into a
 * selector miss at collection time.
 */
const DOM_LINK_SELECTOR = [
  'a[href$=".pdf" i]',
  'a[href*=".pdf?" i]',
  'a[href*=".pdf#" i]',
  'a[href*="/download" i]',
  'a[href*="/pdf" i]',
  'a[href*="/account/receipt/" i]',
  ...PROVIDER_DOCUMENT_LINK_SELECTORS,
  'a[aria-label*="download" i][href]',
  'a[title*="download" i][href]',
  "a[download]",
].join(",");
export const DISCOVERY_OBSERVER_REGISTRATION_ID = "ratatosk_discovery_observer";

type ProbedResource = {
  url: string;
  method?: "GET" | "POST";
  status: number;
  contentType: string;
  body: string;
  requestBody?: string;
  requestHeaders?: Record<string, string>;
  source?: "observed" | "replayed";
  hasLinkNext?: boolean;
  /** Structural authentication marker only: which scheme the application used,
   * never the credential it sent. */
  requestAuthScheme?: "bearer" | "basic" | "custom";
  /** Response paths whose value was a credential. Field names only — this is
   * what lets a token exchange be wired without the token ever being held. */
  credentialPaths?: string[];
};

export interface PageEvidence {
  url: string;
  origin: string;
  title?: string;
  applicationName?: string;
  siteName?: string;
  html: string;
  resources: ProbedResource[];
  navigationUrls: (string | ExplorationLinkEvidence)[];
  crossOriginHosts: string[];
  stats: {
    documentLinks: number;
    structuredData: number;
    semanticControls: number;
    semanticSections?: number;
    semanticControlsRejected?: number;
    semanticNavigationSteps?: number;
  };
}

type Candidate = {
  adapterId: DiscoveryAdapterId;
  recipe: VendorRecipe;
  previewCount?: number;
  admission: CandidateAdmissionSignal[];
};

export interface SupplierDiscoveryResult {
  candidates: DiscoveredSupplierCandidateSetV1;
  diagnostic: DiscoveryDiagnosticV1;
}

export class SupplierDiscoveryError extends Error {
  constructor(readonly diagnostic: DiscoveryDiagnosticV1) {
    super("no reusable invoice path was found after bounded same-origin exploration");
    this.name = "SupplierDiscoveryError";
  }
}

class CandidatePreviewError extends Error {
  constructor(readonly code: DiscoveryAttemptResult) {
    super(code);
    this.name = "CandidatePreviewError";
  }
}

export function createInitialExplorationTargets(
  entryUrl: string,
  observerReady: boolean,
  rememberedRoute?: string,
): ExplorationTarget[] {
  const targets: ExplorationTarget[] = [{
    url: entryUrl,
    depth: 0,
    source: "entry",
    family: "exact_entry",
    score: Number.MAX_SAFE_INTEGER,
  }];
  if (observerReady) {
    targets.push({
      url: entryUrl,
      depth: 0,
      source: "entry_replay",
      family: "exact_entry",
      score: Number.MAX_SAFE_INTEGER - 1,
    });
  }
  // Where this supplier's invoices were last found. Ranked above every curated
  // guess but kept out of `exact_entry`, so it is probed in the first explored
  // wave rather than sharing the trust boundary of the user's own tab — and so
  // a stale route costs one probe in a wave that was going to run regardless.
  if (rememberedRoute && rememberedRoute !== entryUrl) {
    targets.push({
      url: rememberedRoute,
      depth: 1,
      source: "remembered",
      family: "common_billing_route",
      score: REMEMBERED_ROUTE_SCORE,
    });
  }
  return targets;
}

/** Above the curated billing paths (which top out near 68) and every observed
 * link, but far below the entry page. */
const REMEMBERED_ROUTE_SCORE = 5_000;

export async function discoverSupplierInTab(
  tabId: number,
  expectedOrigin: string,
  options: {
    shouldContinue?: () => Promise<boolean>;
    mode?: ExplorationMode;
    checkpoint?: ExplorationCheckpoint;
    onCheckpoint?: (checkpoint: ExplorationCheckpoint) => Promise<void>;
  } = {},
): Promise<SupplierDiscoveryResult> {
  console.info(`[collector] discovery started ${formatCollectorRuntimeIdentity()}`);
  const mode = options.mode ?? options.checkpoint?.mode ?? "fast";
  const budget = explorationBudget(mode);
  const resumed = options.checkpoint?.mode === mode ? options.checkpoint : undefined;
  const startedAt = Date.now();
  const elapsedBefore = resumed?.elapsedMs ?? 0;
  const explorationDeadline = startedAt + Math.max(0, budget.durationMs - elapsedBefore);
  const firstTab = await chrome.tabs.get(tabId);
  const firstUrl = firstTab.url ? canonicalPageUrl(firstTab.url, expectedOrigin) : undefined;
  if (!firstUrl) throw new Error("the supplier tab changed before discovery started");
  const completedTargetKeys = new Set(resumed?.completedTargetKeys ?? []);
  const pageObserver = new DiscoveryPageObserverRegistration(expectedOrigin);
  const observerReady = await pageObserver.start();
  if (observerReady) await pageObserver.adopt(tabId);
  // Resuming a checkpoint already carries its own frontier, so the shortcut is
  // only seeded when a search actually starts.
  const remembered = resumed ? undefined : (await getRememberedRoute(expectedOrigin))?.entryUrl;
  if (remembered) console.info(`[collector] discovery will try the remembered route ${toDiagnosticRoute(remembered)} first`);
  const queue = createInitialExplorationTargets(firstUrl, observerReady, remembered);
  const known = new Set([firstUrl]);
  const foregroundProbeBudget = { remaining: 1 };
  const explorers = Array.from(
    // One tab per concurrent probe slot, and never fewer than the two the entry
    // wave needs to snapshot the live page and replay it cold at the same time.
    { length: Math.max(2, DEFAULT_SAFE_CONCURRENCY.routeProbes) },
    () => new BackgroundExplorationTab(expectedOrigin, foregroundProbeBudget),
  );
  const diagnostic = emptyDiagnostic(expectedOrigin, mode);
  diagnostic.pages.attempted = resumed?.pagesAttempted ?? 0;
  diagnostic.pages.linked = resumed?.linkedPagesAttempted ?? 0;
  diagnostic.pages.commonRoutes = resumed?.commonRoutePagesAttempted ?? 0;
  diagnostic.coverage!.attemptedFamilies = [...(resumed?.attemptedFamilies ?? [])];
  diagnostic.coverage!.slicesCompleted = resumed?.slicesCompleted ?? 0;
  let display: ReturnType<typeof deriveSupplierDisplayName> | undefined;
  const nameObservations: SupplierNameObservation[] = [];
  let entryExplored = false;
  let exploredWaves = 0;
  const retained: Array<{ profile: DiscoveredSupplierProfileV1; score: number }> = [];

  const checkpoint = async (): Promise<void> => {
    if (!options.onCheckpoint) return;
    const next = createExplorationCheckpoint({
      mode,
      pagesAttempted: diagnostic.pages.attempted,
      linkedPagesAttempted: diagnostic.pages.linked,
      commonRoutePagesAttempted: diagnostic.pages.commonRoutes,
      elapsedMs: Math.min(budget.durationMs, elapsedBefore + Math.max(0, Date.now() - startedAt)),
      frontier: queue.map((target) => ({
        key: explorationTargetKey(target),
        family: explorationFamilyForTarget(target),
        score: Math.max(0, Math.min(10_000, Math.trunc(target.score))),
        depth: target.depth,
      })),
      completedTargetKeys: [...completedTargetKeys],
      attemptedFamilies: diagnostic.coverage!.attemptedFamilies,
      slicesCompleted: diagnostic.coverage!.slicesCompleted,
    });
    try {
      await options.onCheckpoint(next);
    } catch (error) {
      // Checkpointing may be unavailable during a Chrome worker shutdown. The
      // active discovery remains safe and bounded even without resumption.
      console.warn("[collector] discovery checkpoint was not saved", error);
    }
  };

  try {
    while (queue.length && diagnostic.pages.attempted < budget.pages && Date.now() < explorationDeadline) {
      if (options.shouldContinue && !(await options.shouldContinue())) throw new Error("supplier discovery was cancelled");
      const remainingPages = budget.pages - diagnostic.pages.attempted;
      const isEntryWave = entryWave(queue);
      // The user's active entry tab is a unique trust boundary, so it is never
      // batched with explored routes. Its cold replay uses a separate disposable
      // tab, though, so the two run together: they cannot interfere, and
      // serializing them spent seconds of the interactive budget on nothing.
      const width = isEntryWave
        ? entryWaveWidth(queue)
        : Math.min(DEFAULT_SAFE_CONCURRENCY.routeProbes, remainingPages);
      const scheduled = queue.splice(0, Math.min(width, remainingPages)).map((target) => {
        const page = diagnostic.pages.attempted + 1;
        diagnostic.pages.attempted = page;
        if (target.source === "linked") diagnostic.pages.linked += 1;
        if (target.source === "common_route") diagnostic.pages.commonRoutes += 1;
        markCoverageFamily(diagnostic, explorationFamilyForTarget(target));
        return { target, page, pageStartedAt: Date.now() };
      });
      const foregroundCandidateIndex = foregroundProbeBudget.remaining > 0
        ? scheduled.findIndex(({ target }) => {
          // The active entry tab is already foreground; only a disposable
          // exploration tab can spend the shared visibility lease.
          if (target.source === "entry") return false;
          try {
            return FOREGROUND_BILLING_ROUTE.test(new URL(target.url).pathname);
          } catch {
            return false;
          }
        })
        : -1;
      // Settle order, not queue order. A wave is only as useful as its first
      // sufficient answer, and waiting out the siblings of a page that already
      // produced a structured invoice source spent seconds on results that
      // would be discarded.
      const probes = mapConcurrentInSettleOrder(scheduled, {
        limit: DEFAULT_SAFE_CONCURRENCY.routeProbes,
      }, async ({ target }, index) => {
        const remainingMs = explorationDeadline - Date.now();
        if (remainingMs <= 0) throw new Error("supplier exploration deadline exceeded");
        const baseOptions = target.source === "entry"
          ? entryProbeOptions(mode)
          : explorationProbeOptions(target, mode);
        const probeOptions: ProbeOptions = {
          ...capExplorationProbeOptions(baseOptions, remainingMs),
          allowForegroundRetry: index === foregroundCandidateIndex,
        };
        const probe = target.source === "entry"
          ? probeSupplierTab(tabId, expectedOrigin, probeOptions)
          : explorers[index].probe(target.url, probeOptions);
        return runWithinExplorationBudget(probe, remainingMs);
      });

      for await (const probe of probes) {
        const { target, page, pageStartedAt } = scheduled[probe.index];
        if (probe.status !== "fulfilled") {
          recordAttempt(diagnostic, page, target.source, undefined, "probe_failed", Date.now() - pageStartedAt, {
            route: target.url,
          });
          if (target.source === "entry") {
            enqueueTargets(queue, known, planExplorationTargets({
              origin: expectedOrigin,
              contextUrl: target.url,
              links: [],
              visited: known,
              nextDepth: 1,
              includeCommonRoutes: true,
              limit: budget.pages - diagnostic.pages.attempted,
              maxDepth: budget.depth,
            }), completedTargetKeys);
          }
          completedTargetKeys.add(explorationTargetKey(target));
          continue;
        }

        const evidence = probe.value;
        // Every page seen adds a vote. The provisional name is recomputed from
        // the whole set rather than fixed by whichever page answered first, and
        // the retained profiles are re-stamped once exploration ends.
        nameObservations.push({
          applicationName: evidence.applicationName,
          siteName: evidence.siteName,
          title: evidence.title,
        });
        display = deriveSupplierDisplayName({ origin: evidence.origin, observations: nameObservations });
        const resolvedPage = canonicalPageUrl(evidence.url, expectedOrigin);
        if (resolvedPage && resolvedPage !== target.url) {
          known.add(resolvedPage);
          for (let index = queue.length - 1; index >= 0; index -= 1) {
            if (queue[index].url === resolvedPage) queue.splice(index, 1);
          }
        }
        diagnostic.evidence.jsonResources += evidence.resources.length;
        diagnostic.evidence.observedRequests += evidence.resources.filter((resource) => resource.source === "observed").length;
        diagnostic.evidence.replayedRequests += evidence.resources.filter((resource) => resource.source === "replayed").length;
        diagnostic.evidence.documentLinks += evidence.stats.documentLinks;
        if (evidence.stats.structuredData > 0) diagnostic.evidence.structuredDataPages += 1;
        for (const host of evidence.crossOriginHosts) {
          if (diagnostic.evidence.crossOriginHosts.length >= 8) break;
          if (!diagnostic.evidence.crossOriginHosts.includes(host)) diagnostic.evidence.crossOriginHosts.push(host);
        }

        const entryUrl = safeEntryUrl(evidence.url);
        // The requested route, not the URL the application settled on, is what
        // reproduces this surface. Applications that rewrite the address bar
        // back to their shell would otherwise compile a recipe that reopens a
        // page the evidence never came from.
        const openUrl = requestedEntryUrl(target.url, entryUrl);
        // These four evidence families are inspected for every successfully
        // loaded route, so a large navigation graph cannot starve them.
        markCoverageFamilies(diagnostic, ["observed_network", "embedded_data", "document_provider", "semantic_download"]);
        const candidates = compileCandidates(evidence, entryUrl, display.name, openUrl);
        diagnostic.candidates.compiled += candidates.length;
        const routeEvidence = diagnosticEvidence(evidence);
        if (!candidates.length) recordAttempt(diagnostic, page, target.source, undefined, "no_candidate", Date.now() - pageStartedAt, {
          route: target.url,
          resolvedRoute: evidence.url,
          evidence: routeEvidence,
        });

        const evaluations = await mapConcurrentOrdered(candidates, {
          limit: DEFAULT_SAFE_CONCURRENCY.candidatePreviews,
        }, async (candidate) => {
          const candidateCount = candidate.previewCount ?? await (async () => {
            diagnostic.candidates.previewed += 1;
            return previewCandidate(candidate.recipe);
          })();
          return { candidate, candidateCount };
        });
        for (const evaluation of evaluations) {
          if (evaluation.status === "cancelled") continue;
          if (evaluation.status === "rejected") {
            const candidate = candidates[evaluation.index];
            recordAttempt(diagnostic, page, target.source, candidate.adapterId, previewResult(evaluation.error), Date.now() - pageStartedAt, {
              route: target.url,
              resolvedRoute: evidence.url,
              evidence: routeEvidence,
              admission: candidate.admission,
            });
            continue;
          }
          const { candidate, candidateCount } = evaluation.value;
          try {
            console.info(
              `[collector] discovery page ${page}/${budget.pages} (${target.source}) ${candidate.adapterId} -> ${candidate.previewCount ? "deferred-canary" : "previewed"}`,
            );
            retainCandidate(retained, {
              score: candidateScore(candidate.adapterId, candidateCount, target.score),
              profile: createDiscoveredSupplierProfile({
                primaryOrigin: evidence.origin,
                entryUrl: openUrl,
                displayName: display.name,
                nameSource: display.source,
                nameConfidence: display.confidence,
                adapterId: candidate.adapterId,
                candidateCount,
                recipe: candidate.recipe,
              }),
            });
            recordAttempt(diagnostic, page, target.source, candidate.adapterId, "candidate_compiled", Date.now() - pageStartedAt, {
              route: target.url,
              resolvedRoute: evidence.url,
              evidence: routeEvidence,
              admission: candidate.admission,
            });
          } catch {
            recordAttempt(diagnostic, page, target.source, candidate.adapterId, "policy_rejected", Date.now() - pageStartedAt, {
              route: target.url,
              resolvedRoute: evidence.url,
              evidence: routeEvidence,
              admission: candidate.admission,
            });
          }
        }

        if (target.depth < budget.depth) {
          const planned = planExplorationTargets({
            origin: expectedOrigin,
            contextUrl: evidence.url,
            links: evidence.navigationUrls,
            visited: known,
            nextDepth: target.depth + 1,
            includeCommonRoutes: target.source === "entry" || target.source === "entry_replay",
            limit: budget.pages - diagnostic.pages.attempted,
            maxDepth: budget.depth,
          });
          enqueueTargets(queue, known, planned, completedTargetKeys);
        }
        completedTargetKeys.add(explorationTargetKey(target));

        // Stop the wave only on evidence that nothing still running could
        // improve on. A structured invoice source ends the search either way,
        // so its siblings are already destined to be discarded — whereas a DOM
        // candidate can be beaten by a JSON one from the very probe that would
        // be abandoned, and those waves are still played out in full.
        if (structuredProofRetained(retained)) {
          console.info(`[collector] discovery stopped wave ${exploredWaves + 1} early on structured evidence`);
          break;
        }
      }
      await checkpoint();
      if (isEntryWave) entryExplored = true;
      else exploredWaves += 1;
      if (
        discoveryProofIsSufficient(retained, { entryExplored, exploredWaves }) ||
        (hasEnoughStrongCandidates(retained) && allEnabledFamiliesAttempted(diagnostic))
      ) break;
    }
  } finally {
    await disposeDiscoveryResources(explorers, pageObserver, [tabId]);
  }

  if (retained.length) {
    retained.sort((left, right) => right.score - left.score || left.profile.entryUrl.localeCompare(right.profile.entryUrl));
    diagnostic.timing.elapsedMs = Math.min(budget.durationMs, elapsedBefore + Math.max(0, Date.now() - startedAt));
    diagnostic.candidates.retained = retained.length;
    const coverageComplete = finalizeCoverage(diagnostic, queue.length === 0);
    diagnostic.termination = retained.length >= 2 || coverageComplete ? "candidate_set_complete" : "candidate_primary_found";
    diagnostic.result = "candidates_found";
    const existing = Object.values(await getDiscoveredSuppliers())
      .find((profile) => profile.primaryOrigin === new URL(expectedOrigin).origin);
    // Pages probed after the first candidate compiled still count as evidence
    // of the supplier's name, so the set is named from the finished run.
    const finalName = deriveSupplierDisplayName({ origin: expectedOrigin, observations: nameObservations });
    const profiles = retained.map((candidate) =>
      reuseDiscoveredSupplierIdentity(withSupplierDisplayName(candidate.profile, finalName), existing));
    return {
      candidates: createDiscoveredSupplierCandidateSet(profiles),
      diagnostic: parseDiscoveryDiagnostic(diagnostic),
    };
  }

  diagnostic.timing.elapsedMs = Math.min(budget.durationMs, elapsedBefore + Math.max(0, Date.now() - startedAt));
  const coverageComplete = finalizeCoverage(diagnostic, queue.length === 0);
  diagnostic.termination = queue.length && diagnostic.pages.attempted >= budget.pages
    ? "page_cap"
    : diagnostic.timing.elapsedMs >= budget.durationMs ? "time_cap"
      : coverageComplete ? "queue_exhausted" : "coverage_incomplete";
  diagnostic.result = diagnostic.termination === "queue_exhausted" ? "not_found" : "limit_reached";
  throw new SupplierDiscoveryError(parseDiscoveryDiagnostic(diagnostic));
}

export async function disposeDiscoveryResources(
  explorers: ReadonlyArray<{ dispose(): Promise<void> }>,
  observer: { dispose(tabIds: readonly number[]): Promise<void> },
  observedTabIds: readonly number[],
  warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error),
): Promise<void> {
  const explorerResults = await Promise.allSettled(explorers.map((explorer) => explorer.dispose()));
  // Observer cleanup is independent and must run even when closing a temporary
  // exploration tab fails. Cleanup errors are diagnostic, never a replacement
  // for the discovery result or its primary exception.
  const [observerResult] = await Promise.allSettled([observer.dispose(observedTabIds)]);
  for (const result of explorerResults) {
    if (result.status === "rejected") warn("[collector] exploration-tab cleanup failed", result.reason);
  }
  if (observerResult.status === "rejected") {
    warn("[collector] discovery-observer cleanup failed", observerResult.reason);
  }
}

export async function previewCandidate(recipe: VendorRecipe): Promise<number> {
  let run: ReturnType<typeof buildRunContext>;
  try {
    run = buildRunContext("discovery-preview", recipe);
  } catch {
    throw new CandidatePreviewError("policy_rejected");
  }
  const { ctx, dispose } = run;
  try {
    // A DOM candidate's list operation inspects the exact authenticated page
    // that produced the evidence. That is stronger than issuing a second page
    // GET, and avoids rejecting sites that allow navigation but block scripted
    // document fetches. Non-DOM candidates still require the explicit auth probe.
    if (recipe.invoices.strategy !== "dom") {
      try {
        // A token exchange is a claim until it is exercised. Minting first means
        // a candidate that only works with a bearer is proven end to end here,
        // and one whose inferred exchange is wrong fails now rather than during
        // the user's first collection.
        await resolveAuthToken(recipe, ctx);
        await assertAuthenticated(recipe, ctx);
      } catch (error) {
        if (error instanceof AuthExpired) throw new CandidatePreviewError("auth_expired");
        if (error instanceof AuthFailure) {
          const code = error.kind === "insufficient_scope"
            ? "auth_scope_denied"
            : error.kind === "transport_failed" ? "transport_failed" : "auth_blocked";
          throw new CandidatePreviewError(code);
        }
        throw new CandidatePreviewError("auth_failed");
      }
    }

    let scopes: Record<string, unknown>[];
    try {
      scopes = await resolvePreviewScopes(recipe, ctx);
    } catch {
      throw new CandidatePreviewError("scope_failed");
    }
    // Discovery verifies one source page only. Full pagination is deliberately
    // deferred until Connect & Collect so search stays fast and side effects
    // remain bounded to the user's collection action.
    const previewRecipe = recipeForPreview(recipe);
    const strategy = buildStrategies(previewRecipe)[previewRecipe.invoices.strategy];
    const refs: InvoiceRef[] = [];
    try {
      for (const scope of scopes.slice(0, 20)) {
        try {
          refs.push(...(await strategy.list(previewRecipe, { ...ctx.vars, ...scope }, ctx)).refs);
        } catch {
          throw new CandidatePreviewError("list_failed");
        }
        if (refs.length > 500) throw new CandidatePreviewError("too_many_documents");
      }
    } finally {
      await strategy.dispose?.();
    }
    const allowedOrigins = new Set(recipe.hosts.map((host) => new URL(host.slice(0, -2)).origin));
    const ids = new Set<string>();
    for (const ref of refs) {
      if (!ref.vendorInvoiceId || ref.vendorInvoiceId === "undefined" || ref.vendorInvoiceId === "null") {
        throw new CandidatePreviewError("invalid_identity");
      }
      if (ids.has(ref.vendorInvoiceId)) continue;
      ids.add(ref.vendorInvoiceId);
      if (
        !ref.documentUrl && !recipe.invoices.document.request &&
        ref.resolution?.kind !== "semantic_action"
      ) throw new CandidatePreviewError("invalid_document_path");
      if (ref.documentUrl) {
        let document: URL;
        try { document = new URL(ref.documentUrl); } catch { throw new CandidatePreviewError("invalid_document_path"); }
        if (document.protocol !== "https:" || document.username || document.password || !allowedOrigins.has(document.origin)) {
          throw new CandidatePreviewError("unapproved_document_origin");
        }
      }
    }
    if (!ids.size) throw new CandidatePreviewError("no_documents");
    return ids.size;
  } finally {
    await dispose();
  }
}

function recipeForPreview(recipe: VendorRecipe): VendorRecipe {
  const preview = structuredClone(recipe);
  if (preview.invoices.strategy === "network" && preview.invoices.list.paginate) {
    preview.invoices.list.paginate.maxPages = 1;
  }
  if (preview.invoices.strategy === "dom") delete preview.invoices.list.continuation;
  return preview;
}

/**
 * Compile every candidate supported by one page of evidence.
 *
 * `entryUrl` is the URL that actually served the inspected document and stays
 * the base for resolving its links. `openUrl` is the route discovery requested.
 * Single-page applications routinely rewrite the address bar back to their
 * shell while keeping the billing surface mounted, so only the requested route
 * can reopen a DOM candidate. Network and embedded strategies replay a response
 * we already hold, so they keep the served URL.
 */
export function compileCandidates(
  evidence: PageEvidence,
  entryUrl: string,
  displayName: string,
  openUrl: string = entryUrl,
): Candidate[] {
  const candidates: Candidate[] = [];
  const resourceEntries: CapturedEntry[] = evidence.resources.map((resource) => ({
    url: resource.url,
    method: resource.method ?? "GET",
    status: resource.status,
    contentType: resource.contentType,
    requestBody: resource.requestBody,
    requestHeaders: resource.requestHeaders,
    ...(resource.requestAuthScheme ? { requestAuth: { scheme: resource.requestAuthScheme } } : {}),
    ...(resource.credentialPaths?.length ? { redactedResponsePaths: resource.credentialPaths } : {}),
    responseBody: resource.body,
  }));
  const networkDraft = resourceEntries.length
    ? inferRecipe({ origin: evidence.origin, entries: resourceEntries })
    : null;
  if (
    networkDraft && networkDraft.identity.kind !== "date_fallback" &&
    (networkDraft.recipe.invoices as { strategy?: string })?.strategy === "network"
  ) {
    const list = (networkDraft.recipe.invoices as { list?: { request?: { url?: string }; paginate?: unknown } }).list;
    const matchingResource = evidence.resources.find((resource) => resource.url === list?.request?.url);
    if (matchingResource?.hasLinkNext && list && !list.paginate) list.paginate = { kind: "link-header" };
    const candidate = recipeFromDraft(networkDraft, evidence.origin, entryUrl, displayName);
    if (candidate) candidates.push({
      adapterId: "network-json",
      recipe: candidate,
      admission: ["structured_network"],
    });
  }

  const domEntry: CapturedEntry = {
    url: evidence.url,
    method: "DOM",
    status: 200,
    contentType: "text/html",
    responseBody: evidence.html,
  };
  const embeddedDraft = inferRecipe({ origin: evidence.origin, entries: [domEntry] });
  if (
    embeddedDraft && embeddedDraft.identity.kind !== "date_fallback" &&
    (embeddedDraft.recipe.invoices as { strategy?: string })?.strategy === "html"
  ) {
    const invoices = embeddedDraft.recipe.invoices as { list?: { embeddedJson?: boolean } };
    if (invoices.list?.embeddedJson) {
      const candidate = recipeFromDraft(embeddedDraft, evidence.origin, entryUrl, displayName);
      if (candidate) candidates.push({
        adapterId: "embedded-json",
        recipe: candidate,
        admission: ["embedded_invoice_data"],
      });
    }
  }

  const links = findLikelyDocumentLinks(evidence.html, entryUrl, evidence.title);
  const domCandidate = links.length ? directDomRecipe(evidence.origin, openUrl, displayName, links) : undefined;
  if (domCandidate) candidates.push({
    adapterId: "dom-links",
    recipe: domCandidate,
    previewCount: Math.min(500, links.length),
    admission: ["direct_document_link"],
  });
  const semanticEvidenceCount = evidence.stats.semanticControls + (evidence.stats.semanticSections ?? 0);
  const semanticCandidate = semanticEvidenceCount > 0
    ? semanticDomRecipe(evidence.origin, openUrl, displayName, evidence.crossOriginHosts)
    : undefined;
  if (semanticCandidate) {
    const admission: CandidateAdmissionSignal[] = [];
    if ((evidence.stats.semanticSections ?? 0) > 0) admission.push("independent_invoice_context");
    if (evidence.stats.semanticControls > 0) admission.push("semantic_document_control");
    candidates.push({
      adapterId: "dom-actions",
      recipe: semanticCandidate,
      // Discovery may reveal inert account/settings UI, but it never invokes a
      // download action. Documents are captured only during explicit collection.
      previewCount: Math.min(500, semanticEvidenceCount),
      admission,
    });
  }
  return candidates;
}

type ProbeOptions = {
  settleMs: number;
  maxResources: number;
  deadlineMs: number;
  allowForegroundRetry?: boolean;
};

export async function probeSupplierTab(
  tabId: number,
  expectedOrigin: string,
  options: ProbeOptions = { settleMs: 350, maxResources: 2, deadlineMs: 3_000 },
): Promise<PageEvidence> {
  const tab = await chrome.tabs.get(tabId);
  const currentUrl = tab.url ? new URL(tab.url) : undefined;
  if (!currentUrl || currentUrl.protocol !== "https:" || currentUrl.origin !== expectedOrigin) {
    throw new Error("the supplier tab changed before discovery started");
  }
  const controller = new DocumentActionController(new Set([expectedOrigin]), "discovery");
  const [injection] = await controller.runDiscoveryProbe(tabId, () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: collectPageEvidenceInPage,
      args: [options, { ...EXPLORATION_ROUTE_POLICY, documentSelector: DOM_LINK_SELECTOR }, DISCOVERY_DOM_POLICY],
    }));
  return parsePageEvidence(injection?.result, expectedOrigin, options);
}

export function parsePageEvidence(value: unknown, expectedOrigin: string, options: ProbeOptions): PageEvidence {
  const invalid = (): never => { throw new Error("supplier page evidence is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  if (typeof raw.origin !== "string" || raw.origin !== expectedOrigin || typeof raw.url !== "string" || raw.url.length > 2_048) return invalid();
  let page: URL;
  try { page = new URL(raw.url); } catch { return invalid(); }
  if (page.protocol !== "https:" || page.origin !== expectedOrigin || page.username || page.password) return invalid();
  const boundedText = (item: unknown, maximum: number): item is string | undefined => item === undefined || (typeof item === "string" && item.length <= maximum);
  if (!boundedText(raw.title, 160) || !boundedText(raw.applicationName, 160) || !boundedText(raw.siteName, 160)) return invalid();
  if (typeof raw.html !== "string" || raw.html.length > 750_000) return invalid();
  if (!Array.isArray(raw.resources) || raw.resources.length > options.maxResources) return invalid();
  const observedHosts = Array.isArray(raw.crossOriginHosts) ? raw.crossOriginHosts : [];
  const allowedResourceOrigins = new Set([expectedOrigin]);
  for (const item of observedHosts) {
    if (typeof item !== "string" || item.length > 253 || item.includes(":")) return invalid();
    try {
      exactOriginPattern(`https://${item}`);
      allowedResourceOrigins.add(`https://${item}`);
    } catch { return invalid(); }
  }
  const resources: ProbedResource[] = [];
  let totalBody = 0;
  for (const item of raw.resources) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid();
    const resource = item as Record<string, unknown>;
    if (
      typeof resource.url !== "string" || resource.url.length > 2_048 ||
      !Number.isInteger(resource.status) || Number(resource.status) < 0 || Number(resource.status) > 599 ||
      typeof resource.contentType !== "string" || resource.contentType.length > 256 ||
      typeof resource.body !== "string" || resource.body.length > 256_000 ||
      (resource.method !== undefined && resource.method !== "GET" && resource.method !== "POST") ||
      (resource.requestBody !== undefined && (typeof resource.requestBody !== "string" || resource.requestBody.length > 65_536)) ||
      (resource.requestHeaders !== undefined && !isSafeObservedRequestHeaders(resource.requestHeaders)) ||
      (resource.source !== undefined && resource.source !== "observed" && resource.source !== "replayed") ||
      (resource.hasLinkNext !== undefined && typeof resource.hasLinkNext !== "boolean") ||
      (resource.requestAuthScheme !== undefined && !isAuthScheme(resource.requestAuthScheme)) ||
      (resource.credentialPaths !== undefined && !isCredentialPathList(resource.credentialPaths))
    ) return invalid();
    let url: URL;
    try { url = new URL(resource.url); } catch { return invalid(); }
    if (url.protocol !== "https:" || !allowedResourceOrigins.has(url.origin) || url.username || url.password || url.hash) return invalid();
    totalBody += resource.body.length;
    if (totalBody > 768_000) return invalid();
    resources.push({
      url: url.toString(),
      status: Number(resource.status),
      contentType: resource.contentType,
      body: resource.body,
      ...(resource.method ? { method: resource.method } : {}),
      ...(typeof resource.requestBody === "string" ? { requestBody: resource.requestBody } : {}),
      ...(resource.requestHeaders ? { requestHeaders: resource.requestHeaders as Record<string, string> } : {}),
      ...(resource.source ? { source: resource.source } : {}),
      ...(isAuthScheme(resource.requestAuthScheme) ? { requestAuthScheme: resource.requestAuthScheme } : {}),
      ...(isCredentialPathList(resource.credentialPaths) ? { credentialPaths: resource.credentialPaths } : {}),
      hasLinkNext: resource.hasLinkNext === true,
    });
  }
  if (!Array.isArray(raw.navigationUrls) || raw.navigationUrls.length > 80) return invalid();
  const navigationUrls: (string | ExplorationLinkEvidence)[] = [];
  for (const item of raw.navigationUrls) {
    if (typeof item === "string") {
      if (item.length > 2_048) return invalid();
      const safe = safeExplorationUrl(item, expectedOrigin);
      if (!safe) return invalid();
      navigationUrls.push(safe);
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid();
    const evidence = item as Record<string, unknown>;
    if (
      typeof evidence.url !== "string" || evidence.url.length > 2_048 ||
      (evidence.label !== undefined && (typeof evidence.label !== "string" || evidence.label.length > 160)) ||
      (evidence.context !== undefined && (typeof evidence.context !== "string" || evidence.context.length > 240))
    ) return invalid();
    const label = typeof evidence.label === "string" ? evidence.label.replace(/\s+/g, " ").trim() : undefined;
    const context = typeof evidence.context === "string" ? evidence.context.replace(/\s+/g, " ").trim() : undefined;
    const semantic = `${label ?? ""} ${context ?? ""}`.trim();
    const safe = safeExplorationUrl(evidence.url, expectedOrigin, semantic, { allowBridgeIntent: true });
    if (!safe) return invalid();
    navigationUrls.push(label || context ? { url: safe, ...(label ? { label } : {}), ...(context ? { context } : {}) } : safe);
  }
  if (!Array.isArray(raw.crossOriginHosts) || raw.crossOriginHosts.length > 8) return invalid();
  const crossOriginHosts: string[] = [];
  for (const item of raw.crossOriginHosts) {
    if (typeof item !== "string" || item.length > 253 || item.includes(":")) return invalid();
    try { exactOriginPattern(`https://${item}`); } catch { return invalid(); }
    crossOriginHosts.push(item);
  }
  if (!raw.stats || typeof raw.stats !== "object" || Array.isArray(raw.stats)) return invalid();
  const stats = raw.stats as Record<string, unknown>;
  const boundedCount = (item: unknown) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 1_000;
  const boundedOptionalCount = (item: unknown) => item === undefined || boundedCount(item);
  if (
    !boundedCount(stats.documentLinks) || !boundedCount(stats.structuredData) ||
    !boundedCount(stats.semanticControls) || !boundedOptionalCount(stats.semanticSections) ||
    !boundedOptionalCount(stats.semanticControlsRejected) || !boundedOptionalCount(stats.semanticNavigationSteps)
  ) return invalid();
  return {
    url: page.toString(),
    origin: expectedOrigin,
    title: raw.title as string | undefined,
    applicationName: raw.applicationName as string | undefined,
    siteName: raw.siteName as string | undefined,
    html: raw.html,
    resources,
    navigationUrls,
    crossOriginHosts: [...new Set(crossOriginHosts)],
    stats: {
      documentLinks: Number(stats.documentLinks),
      structuredData: Number(stats.structuredData),
      semanticControls: Number(stats.semanticControls),
      semanticSections: Number(stats.semanticSections ?? 0),
      semanticControlsRejected: Number(stats.semanticControlsRejected ?? 0),
      semanticNavigationSteps: Number(stats.semanticNavigationSteps ?? 0),
    },
  };
}

function isAuthScheme(value: unknown): value is "bearer" | "basic" | "custom" {
  return value === "bearer" || value === "basic" || value === "custom";
}

/** Structural field paths only: no values, no separators that could smuggle one. */
function isCredentialPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 40 && value.every((item) =>
    typeof item === "string" && item.length > 0 && item.length <= 300 &&
    item.split(".").every((part) => /^[A-Za-z0-9_$-]+$/.test(part)));
}

function isSafeObservedRequestHeaders(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 1 && entries.every(([key, item]) => (
    key.toLowerCase() === "content-type" && typeof item === "string" && item.length <= 128 &&
    item.toLowerCase() === "application/json"
  ));
}

/**
 * Self-contained and bounded. It may reveal inert account/settings UI, but it
 * never invokes document, form, payment, or other mutating actions. No result
 * from this function is persisted.
 */
async function collectPageEvidenceInPage(
  options: ProbeOptions,
  routePolicy: typeof EXPLORATION_ROUTE_POLICY & { documentSelector: string },
  semanticPolicy: typeof DISCOVERY_DOM_POLICY,
): Promise<PageEvidence> {
  const MAX_HTML = 750_000;
  const MAX_BODY = 256_000;
  const MAX_TOTAL = 768_000;
  const MAX_RESOURCES = Math.max(1, Math.min(12, options.maxResources));
  const deadline = Date.now() + Math.max(1, Math.min(12_000, options.deadlineMs));
  const interesting = /invoice|billing|receipt|statement|transaction|charge|payment|subscription|plan|account|session|organization|workspace|team/i;
  const billingPath = new RegExp(routePolicy.intent, "i");
  const bridgePath = new RegExp(routePolicy.bridgeIntent, "i");
  const unsafePath = new RegExp(routePolicy.unsafe, "i");
  const unsafeSegment = new RegExp(routePolicy.unsafeSegment, "i");
  const directDocumentPath = new RegExp(routePolicy.directDocument, "i");
  const ignored = /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|woff2?|ttf|ico)(?:\?|$)/i;
  const explicitDownloadAction = new RegExp(semanticPolicy.explicitActionPattern, "i");
  const strongDocumentLabel = new RegExp(semanticPolicy.strongDocumentPattern, "i");
  const documentIcon = new RegExp(semanticPolicy.documentIconPattern, "i");
  const invoiceContext = new RegExp(semanticPolicy.invoiceContextPattern, "i");
  const invoiceRow = new RegExp(semanticPolicy.invoiceRowPattern, "i");
  const actionColumn = new RegExp(semanticPolicy.actionColumnPattern, "i");
  const unsafeLabel = new RegExp(semanticPolicy.unsafeLabelPattern, "i");
  const semanticNavigation = new RegExp(semanticPolicy.semanticNavigationPattern, "i");
  const invoiceSection = new RegExp(semanticPolicy.invoiceSectionPattern, "i");
  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      rect.width > 0 && rect.height > 0;
  };
  const semanticMaterial = (element: Element): string => {
    const icon = element.querySelector("svg,[icon],[name],[data-lucide]");
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("value"),
      element.getAttribute("data-test"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-lucide"),
      icon?.getAttribute("class"),
      icon?.getAttribute("data-lucide"),
      icon?.getAttribute("icon"),
      icon?.getAttribute("name"),
      icon?.getAttribute("aria-label"),
      icon?.getAttribute("title"),
      element.getAttribute("class"),
      element.textContent,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 320);
  };
  const rowContextOf = (element: Element): string => (
    element.closest(semanticPolicy.contextSelector)?.textContent || ""
  ).replace(/\s+/g, " ").trim().slice(0, 500);
  const columnContextOf = (element: Element): string => {
    const cell = element.closest('td,th,[role="cell"],[role="gridcell"],[role="columnheader"]');
    const row = cell?.closest('tr,[role="row"]');
    const table = row?.closest(semanticPolicy.tableSelector);
    if (!cell || !row || !table) return "";
    const cells = Array.from(row.querySelectorAll(':scope > td,:scope > th,:scope > [role="cell"],:scope > [role="gridcell"],:scope > [role="columnheader"]'));
    const index = cells.indexOf(cell);
    if (index < 0) return "";
    const headerRows = Array.from(table.querySelectorAll('thead tr,[role="row"]')).slice(0, 5);
    for (const headerRow of headerRows) {
      const headers = Array.from(headerRow.querySelectorAll(':scope > th,:scope > [role="columnheader"]'));
      const text = headers[index]?.textContent?.replace(/\s+/g, " ").trim().slice(0, 120);
      if (text) return text;
    }
    return "";
  };
  const tableContextOf = (element: Element): string => (
    Array.from(element.closest(semanticPolicy.tableSelector)?.querySelectorAll(
      'thead th,[role="columnheader"]',
    ) || [])
      .slice(0, 20)
      .map((header) => header.textContent)
      .join(" ")
  ).replace(/\s+/g, " ").trim().slice(0, 500);
  // The route is a search hypothesis and must never supply invoice evidence.
  // Use only independently rendered page state here.
  const pageContext = (): string => `${document.title} ${
    Array.from(document.querySelectorAll("h1,h2,h3,caption"))
      .slice(0, 12)
      .map((element) => element.textContent)
      .join(" ")
  }`.replace(/\s+/g, " ").trim().slice(0, 240);
  const semanticControls = (): Element[] => Array.from(document.querySelectorAll(
    semanticPolicy.controlSelector,
  )).filter((element) => {
    if (
      !visible(element) || element.closest("form") ||
      element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true"
    ) return false;
    const label = semanticMaterial(element);
    if (!label || unsafeLabel.test(label)) return false;
    const row = rowContextOf(element);
    const table = tableContextOf(element);
    const page = pageContext();
    const explicit = explicitDownloadAction.test(label) &&
      (strongDocumentLabel.test(label) || invoiceContext.test(`${row} ${table} ${page}`));
    const contextualIcon = documentIcon.test(label) &&
      actionColumn.test(columnContextOf(element)) &&
      (invoiceRow.test(row) || invoiceContext.test(table)) &&
      invoiceContext.test(`${table} ${page}`);
    return explicit || contextualIcon;
  });
  const semanticSections = (): Element[] => Array.from(document.querySelectorAll(
    semanticPolicy.sectionSelector,
  )).filter((element) => {
    if (!visible(element) || element.closest("form")) return false;
    const label = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.textContent,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
    return Boolean(label && invoiceSection.test(label) && !unsafeLabel.test(label));
  });
  let semanticNavigationSteps = 0;
  // The navigation pattern is anchored, so each label source is matched on its
  // own. Joining them turns an accessible name plus its visible text into one
  // string that no anchored pattern can ever match.
  const semanticNavigationLabelsOf = (element: Element): string[] => [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.textContent,
  ].map((value) => (value || "").replace(/\s+/g, " ").trim().slice(0, 120)).filter(Boolean);
  const semanticNavigationControl = (tier: RegExp): HTMLElement | undefined => Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="button"],[role="menuitem"],[role="tab"],a:not([href])'),
  ).find((element) => {
    const labels = semanticNavigationLabelsOf(element);
    return Boolean(
      labels.length && !labels.some((label) => unsafeLabel.test(label)) &&
      labels.some((label) => semanticNavigation.test(label) && tier.test(label)) &&
      !element.closest("form") && visible(element) &&
      !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true"
    );
  });
  const billingSurfaceObserved = (): boolean => Boolean(
    document.querySelector(routePolicy.documentSelector) ||
    semanticControls().length ||
    semanticSections().length
  );
  const revealSemanticNavigation = async (): Promise<void> => {
    if (billingSurfaceObserved()) return;
    const tiers = [
      /(?:open\s+)?profile\s+menu$|account\s+menu$/i,
      /^(?:settings|preferences)$/i,
      /^(?:account|billing|subscriptions?|invoice\s+history|receipt\s+history|billing\s+history|past\s+invoices?)$/i,
    ];
    // A tier is worth waiting for only while something can still mount it: the
    // application's own startup for the first tier, or the previous click. A
    // single mutation fires on the first unrelated attribute change, long
    // before the revealed menu exists, so poll for the control itself. Tiers
    // that nothing is mounting are checked once, which keeps pages without any
    // account UI from spending their whole evidence budget here.
    //
    // Revealing shares this page's budget with observed-network and embedded
    // evidence, so it may claim at most half of what remains.
    const revealDeadline = Math.min(deadline, Date.now() + Math.max(500, Math.floor((deadline - Date.now()) / 2)));
    let mounting = true;
    for (const tier of tiers) {
      if (Date.now() >= revealDeadline || semanticNavigationSteps >= 3) break;
      const tierDeadline = mounting ? Math.min(revealDeadline, Date.now() + 1_500) : 0;
      let control = semanticNavigationControl(tier);
      while (!control && Date.now() < tierDeadline) {
        if (billingSurfaceObserved()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
        control = semanticNavigationControl(tier);
      }
      mounting = Boolean(control);
      if (!control) continue;
      control.click();
      semanticNavigationSteps += 1;
      if (billingSurfaceObserved()) break;
    }
  };

  let observedSnapshot: CapturedEntry[] = [];
  let observedHighSignal = false;
  const snapshotObserver = async (): Promise<CapturedEntry[]> => {
    try {
      const pageObserver = (window as Window & {
        __ratatoskDiscoveryObserverV1?: { snapshot?: () => Promise<CapturedEntry[]> };
      }).__ratatoskDiscoveryObserverV1;
      if (typeof pageObserver?.snapshot !== "function") return [];
      const snapshot = await Promise.race([
        Promise.resolve(pageObserver.snapshot()),
        new Promise<CapturedEntry[]>((resolve) =>
          setTimeout(() => resolve([]), Math.min(500, Math.max(50, deadline - Date.now())))),
      ]);
      return Array.isArray(snapshot) ? snapshot.filter((entry) => entry && typeof entry === "object").slice(0, MAX_RESOURCES) : [];
    } catch {
      return [];
    }
  };
  const waitForObservedEvidenceQuiescence = async (): Promise<void> => {
    const settleDeadline = Math.min(deadline, Date.now() + Math.max(0, Math.min(5_000, options.settleMs)));
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < settleDeadline) {
      const snapshot = await snapshotObserver();
      if (snapshot.length) observedSnapshot = snapshot;
      const semanticCount = semanticControls().length + semanticSections().length;
      const signature = `${snapshot.map((entry) =>
        `${entry.method}|${entry.status}|${entry.url}|${entry.responseBody?.length ?? 0}`).join("\n")
      }|semantic:${semanticCount}`;
      if (signature !== previous) {
        previous = signature;
        stableSince = Date.now();
      }
      const highSignal = snapshot.some((entry) =>
        interesting.test(`${entry.url} ${entry.responseBody?.slice(0, 4_000) ?? ""}`));
      if (highSignal) observedHighSignal = true;
      if ((highSignal || semanticCount > 0) && Date.now() - stableSince >= semanticPolicy.stableMs) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const finalSnapshot = await snapshotObserver();
    if (finalSnapshot.length) {
      observedSnapshot = finalSnapshot;
      if (finalSnapshot.some((entry) =>
        interesting.test(`${entry.url} ${entry.responseBody?.slice(0, 4_000) ?? ""}`))) {
        observedHighSignal = true;
      }
    }
  };
  await revealSemanticNavigation();
  await waitForObservedEvidenceQuiescence();

  const usefulEvidencePresent = () => Boolean(
    document.querySelector(routePolicy.documentSelector) ||
    document.querySelector('script[type="application/json"],script[type="application/ld+json"]') ||
    semanticControls().length ||
    semanticSections().length,
  );
  const durableEvidencePresent = () => Boolean(
    document.querySelector(routePolicy.documentSelector) || observedHighSignal,
  );
  if (!durableEvidencePresent() && options.settleMs > 0) {
    await new Promise<void>((resolve) => {
      let settled = false;
      let semanticQuietTimer: ReturnType<typeof setTimeout> | undefined;
      let lastSemanticControlCount = -1;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (semanticQuietTimer) clearTimeout(semanticQuietTimer);
        observer.disconnect();
        resolve();
      };
      const considerEvidence = () => {
        if (durableEvidencePresent()) {
          finish();
          return;
        }
        const count = semanticControls().length;
        if (count <= 0 || count === lastSemanticControlCount) return;
        lastSemanticControlCount = count;
        if (semanticQuietTimer) clearTimeout(semanticQuietTimer);
        semanticQuietTimer = setTimeout(finish, Math.min(400, Math.max(150, Math.trunc(options.settleMs / 4))));
      };
      const observer = new MutationObserver(considerEvidence);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(finish, Math.max(0, Math.min(5_000, options.settleMs)));
      considerEvidence();
    });
  }
  if (
    !usefulEvidencePresent() && options.settleMs > 0 &&
    document.documentElement.scrollHeight > window.innerHeight + 20
  ) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      };
      const observer = new MutationObserver(() => {
        if (usefulEvidencePresent()) finish();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(finish, Math.max(250, Math.min(2_000, Math.ceil(options.settleMs / 2))));
    });
  }
  const structuredData = document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]').length;
  const documentLinks = document.querySelectorAll(routePolicy.documentSelector).length;
  const semanticControlCount = semanticControls().length;
  const semanticControlsRejected = Math.max(
    0,
    Math.min(1_000, document.querySelectorAll(semanticPolicy.controlSelector).length) - semanticControlCount,
  );
  const semanticSectionCount = semanticSections().length;
  const urls = new Set<string>();
  const crossOriginHosts = new Set<string>();
  for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    try {
      const url = new URL(entry.name);
      if (url.origin === location.origin && url.protocol === "https:" && interesting.test(`${url.pathname}${url.search}`) && !ignored.test(url.pathname)) {
        urls.add(url.toString());
      } else if (url.origin !== location.origin && url.protocol === "https:" && interesting.test(`${url.pathname}${url.search}`)) {
        if (crossOriginHosts.size < 8) crossOriginHosts.add(url.hostname);
      }
    } catch {
      // Ignore browser-internal or malformed performance entries.
    }
  }

  const resourceScore = (value: string): number =>
    (/invoice|receipt|statement/i.test(value) ? 100 : 0) +
    (/billing|transaction|charge/i.test(value) ? 50 : 0) +
    (/payment|subscription|plan/i.test(value) ? 25 : 0) +
    (/account|session|organization|workspace|team/i.test(value) ? 5 : 0);
  const resources: ProbedResource[] = [];
  let total = 0;
  try {
    const pageObserver = (window as Window & {
      __ratatoskDiscoveryObserverV1?: { snapshot?: () => Promise<CapturedEntry[]> };
    }).__ratatoskDiscoveryObserverV1;
    if (typeof pageObserver?.snapshot === "function") {
      const observed = observedSnapshot.length ? observedSnapshot : await Promise.race([
        Promise.resolve(pageObserver.snapshot()),
        new Promise<CapturedEntry[]>((resolve) => setTimeout(() => resolve([]), Math.min(1_000, Math.max(100, deadline - Date.now())))),
      ]);
      const ranked = Array.isArray(observed) ? observed
        .filter((entry) => entry && typeof entry === "object")
        .sort((left, right) => resourceScore(`${right.url} ${right.responseBody?.slice(0, 4_000) ?? ""}`) -
          resourceScore(`${left.url} ${left.responseBody?.slice(0, 4_000) ?? ""}`))
        .slice(0, MAX_RESOURCES) : [];
      for (const entry of ranked) {
        if (
          (entry.method !== "GET" && entry.method !== "POST") ||
          typeof entry.url !== "string" || entry.url.length > 2_048 ||
          !Number.isInteger(entry.status) || entry.status < 0 || entry.status > 599 ||
          typeof entry.contentType !== "string" || entry.contentType.length > 256 ||
          typeof entry.responseBody !== "string" || entry.responseBody.length > MAX_BODY ||
          (entry.requestBody !== undefined && entry.requestBody.length > 65_536)
        ) continue;
        let resourceUrl: URL;
        try { resourceUrl = new URL(entry.url); } catch { continue; }
        if (resourceUrl.protocol !== "https:" || resourceUrl.username || resourceUrl.password || resourceUrl.hash) continue;
        if (resourceUrl.origin !== location.origin && crossOriginHosts.size < 8) crossOriginHosts.add(resourceUrl.hostname);
        if (total + entry.responseBody.length > MAX_TOTAL) break;
        const contentType = entry.requestHeaders?.["content-type"];
        resources.push({
          url: resourceUrl.toString(),
          method: entry.method,
          status: entry.status,
          contentType: entry.contentType,
          body: entry.responseBody,
          ...(entry.requestBody !== undefined ? { requestBody: entry.requestBody } : {}),
          ...(contentType === "application/json" ? { requestHeaders: { "content-type": contentType } } : {}),
          ...(entry.requestAuth && entry.requestAuth.scheme !== "none" ? { requestAuthScheme: entry.requestAuth.scheme } : {}),
          ...(entry.redactedResponsePaths?.length ? { credentialPaths: entry.redactedResponsePaths.slice(0, 40) } : {}),
          source: "observed",
        });
        total += entry.responseBody.length;
      }
    }
  } catch {
    // The observer is an optional source. Legacy DOM and safe GET evidence still run.
  }
  const preferred = [...urls]
    .sort((left, right) => resourceScore(right) - resourceScore(left) || left.localeCompare(right))
    .filter((url) => !resources.some((resource) => resource.url === url && (resource.method ?? "GET") === "GET"))
    .slice(0, Math.max(0, MAX_RESOURCES - resources.length));
  for (const url of preferred) {
    if (Date.now() >= deadline || total >= MAX_TOTAL) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(3_000, Math.max(250, deadline - Date.now())));
    try {
      const response = await fetch(url, { method: "GET", credentials: "include", signal: controller.signal });
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("json")) continue;
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY) continue;
      const reader = response.body?.getReader();
      if (!reader) continue;
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > MAX_BODY || total + length > MAX_TOTAL) {
          await reader.cancel();
          length = 0;
          break;
        }
        chunks.push(next.value);
      }
      if (!length) continue;
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      total += length;
      resources.push({
        url,
        status: response.status,
        contentType,
        body: new TextDecoder().decode(bytes),
        hasLinkNext: /(?:^|;)\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|'[^']*\bnext\b[^']*'|next)(?:\s*;|\s*,|\s*$)/i
          .test(`;${(response.headers.get("link") ?? "").slice(0, 4_096)}`),
        source: "replayed",
      });
    } catch {
      // A failed optional clue must not abort the other adapters.
    } finally {
      clearTimeout(timer);
    }
  }

  const navigationUrls = new Map<string, { url: string; label?: string; context?: string }>();
  const routeElements = document.querySelectorAll(
    "a[href],area[href],[role=link][href],[data-href],[data-url],[data-route],[routerlink],[ng-reflect-router-link],iframe[src]",
  );
  const routeAttributes = ["href", "data-href", "data-url", "data-route", "routerlink", "ng-reflect-router-link", "src"];
  let inspectedRoutes = 0;
  for (const element of routeElements) {
    if (inspectedRoutes >= 1_500 || navigationUrls.size >= 80) break;
    inspectedRoutes += 1;
    for (const attribute of routeAttributes) {
      const raw = element.getAttribute(attribute);
      if (!raw) continue;
      try {
        const url = new URL(raw, location.href);
        if (url.protocol !== "https:" || url.origin !== location.origin || url.username || url.password) continue;
        const label = (
          element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || ""
        ).replace(/\s+/g, " ").trim().slice(0, 160);
        const contextElement = element.closest('li,[role="menuitem"],[role="option"]') || element.parentElement;
        const context = (contextElement?.textContent || "")
          .replace(/\s+/g, " ").trim().slice(0, 240);
        const semantic = `${label} ${context}`.trim();
        if (
          (!billingPath.test(url.pathname) && !billingPath.test(semantic) && !bridgePath.test(`${url.pathname} ${semantic}`)) ||
          unsafePath.test(url.pathname) || unsafeSegment.test(url.pathname) || unsafePath.test(semantic) || unsafeSegment.test(semantic) ||
          directDocumentPath.test(url.pathname) || url.pathname.length > 320
        ) continue;
        for (const [key, queryValue] of [...url.searchParams.entries()]) {
          if (!/^(?:page|p|offset|start|per_page|limit)$/i.test(key) || !/^\d{1,6}$/.test(queryValue)) {
            url.searchParams.delete(key);
          }
        }
        url.searchParams.sort();
        url.hash = "";
        const canonical = url.toString();
        const current = navigationUrls.get(canonical);
        if (!current || label.length + context.length > (current.label?.length ?? 0) + (current.context?.length ?? 0)) {
          navigationUrls.set(canonical, {
            url: canonical,
            ...(label ? { label } : {}),
            ...(context && context !== label ? { context } : {}),
          });
        }
      } catch {
        // Ignore malformed or non-web routes.
      }
    }
  }

  return {
    url: `${location.origin}${location.pathname}`,
    origin: location.origin,
    title: document.title.slice(0, 160),
    applicationName: document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content.slice(0, 160),
    siteName: document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content.slice(0, 160),
    html: boundedEvidenceHtml(MAX_HTML),
    resources,
    navigationUrls: [...navigationUrls.values()],
    crossOriginHosts: [...crossOriginHosts],
    stats: {
      documentLinks: Math.min(1_000, documentLinks),
      structuredData: Math.min(1_000, structuredData),
      semanticControls: Math.min(1_000, semanticControlCount),
      semanticSections: Math.min(1_000, semanticSectionCount),
      semanticControlsRejected,
      semanticNavigationSteps: Math.min(3, semanticNavigationSteps),
    },
  };

  function boundedEvidenceHtml(limit: number): string {
    const full = document.documentElement.outerHTML;
    if (full.length <= limit) return full;
    const structured = Array.from(document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]'))
      .map((element) => element.outerHTML)
      .join("")
      .slice(0, Math.floor(limit * 0.72));
    const links = Array.from(document.querySelectorAll(
      'a[href$=".pdf" i],a[href*="/invoice" i],a[href*="/receipt" i],a[href*="/statement" i],a[href*="/download" i],a[download]',
    ))
      .slice(0, 500)
      .map((element) => element.outerHTML)
      .join("");
    const controls = semanticControls().slice(0, 100).map((element) => element.outerHTML).join("");
    return `<html><head>${structured}</head><body>${links}${controls}</body></html>`.slice(0, limit);
  }
}

class DiscoveryPageObserverRegistration {
  private registered = false;

  constructor(private readonly expectedOrigin: string) {}

  async start(): Promise<boolean> {
    try {
      // A fixed id makes a prior worker crash self-healing on the next search.
      await removeStaleDiscoveryObserverRegistration();
      await chrome.scripting.registerContentScripts([{
        id: DISCOVERY_OBSERVER_REGISTRATION_ID,
        matches: [exactOriginPattern(this.expectedOrigin)],
        js: [discoveryPageObserverScript],
        runAt: "document_start",
        world: "MAIN",
        allFrames: false,
        persistAcrossSessions: false,
      }]);
      this.registered = true;
      return true;
    } catch (error) {
      console.warn("[collector] early network observation unavailable; continuing with rendered-page discovery", error);
      return false;
    }
  }

  /**
   * Install the observer into a document that was already open.
   *
   * A registered content script only runs on the *next* navigation, so the tab
   * the person is looking at never receives one. Every discovery probe now runs
   * inside the document-action scope, and that scope is taken by asking the page
   * observer for it — so without this the entry snapshot, the one probe that
   * inspects the page the person actually chose, could not run at all.
   *
   * Injecting late means the application's boot requests are already gone; this
   * still sees anything it issues afterwards, and the exact-entry replay in a
   * fresh tab remains the probe that watches a cold start.
   */
  async adopt(tabId: number): Promise<boolean> {
    if (!this.registered) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: [discoveryPageObserverScript],
      });
      return true;
    } catch (error) {
      console.warn("[collector] the active tab could not be observed; its snapshot is skipped", error);
      return false;
    }
  }

  async dispose(possiblyObservedTabs: readonly number[]): Promise<void> {
    if (!this.registered) return;
    this.registered = false;
    await removeStaleDiscoveryObserverRegistration();
    await Promise.all(possiblyObservedTabs.map(async (tabId) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const observer = (window as Window & {
            __ratatoskDiscoveryObserverV1?: { stop?: () => void };
          }).__ratatoskDiscoveryObserverV1;
          if (typeof observer?.stop === "function") observer.stop();
        },
      }).catch(() => undefined);
    }));
  }
}

export async function removeStaleDiscoveryObserverRegistration(): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [DISCOVERY_OBSERVER_REGISTRATION_ID] }).catch(() => undefined);
}

type ForegroundProbeEvidence = {
  stats: Pick<PageEvidence["stats"], "documentLinks" | "semanticControls" | "semanticSections">;
};

const FOREGROUND_BILLING_ROUTE = /(?:^|\/)(?:billing|invoices?|receipts?|statements?|subscriptions?)(?:\/|$)/i;

export function shouldRetryProbeInForeground(
  url: string,
  evidence: ForegroundProbeEvidence,
): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return FOREGROUND_BILLING_ROUTE.test(pathname) &&
    evidence.stats.documentLinks === 0 &&
    evidence.stats.semanticControls === 0 &&
    (evidence.stats.semanticSections ?? 0) === 0;
}

class BackgroundExplorationTab {
  private tabId: number | undefined;

  constructor(
    private readonly expectedOrigin: string,
    private readonly foregroundProbeBudget: { remaining: number },
  ) {}

  async probe(url: string, options: ProbeOptions): Promise<PageEvidence> {
    const startedAt = Date.now();
    const target = canonicalPageUrl(url, this.expectedOrigin);
    if (!target) throw new Error("exploration target left the approved origin");
    if (this.tabId === undefined) {
      const tab = await chrome.tabs.create({ url: target, active: false });
      if (tab.id === undefined) throw new Error("could not open a bounded exploration tab");
      this.tabId = tab.id;
      if (tab.status !== "complete") await waitForTabComplete(tab.id, Math.min(8_000, Math.max(1, options.deadlineMs)));
    } else {
      const tab = await chrome.tabs.update(this.tabId, { url: target, active: false });
      if (tab.status !== "complete") {
        await waitForTabComplete(this.tabId, Math.min(8_000, Math.max(1, options.deadlineMs - (Date.now() - startedAt))));
      }
    }
    const remainingMs = () => options.deadlineMs - (Date.now() - startedAt);
    const leaseAvailable = options.allowForegroundRetry === true && this.foregroundProbeBudget.remaining > 0;

    // Spend an inactive pass first: bringing a tab forward is visible to the
    // person, so it stays a repair for the minority of applications that defer
    // billing hydration until their tab is visible — never the default cost of a
    // scan. The inactive pass is held to most of the route's budget rather than
    // a fixed fraction of it, so the reserve is enough for the retry to render
    // without starving the pass that usually succeeds on its own.
    const inactiveOptions = leaseAvailable && FOREGROUND_BILLING_ROUTE.test(new URL(target).pathname)
      ? { ...options, deadlineMs: Math.trunc(options.deadlineMs * 0.6) }
      : options;
    const evidence = await probeSupplierTab(
      this.tabId,
      this.expectedOrigin,
      capExplorationProbeOptions(inactiveOptions, Math.min(inactiveOptions.deadlineMs, remainingMs())),
    );
    if (
      !shouldRetryProbeInForeground(target, evidence) ||
      this.foregroundProbeBudget.remaining <= 0 ||
      options.allowForegroundRetry !== true ||
      remainingMs() < 500
    ) return evidence;

    const retryMs = remainingMs();
    this.foregroundProbeBudget.remaining -= 1;
    try {
      return await withForegroundTabVisibility(this.tabId, () => probeSupplierTab(
        this.tabId!,
        this.expectedOrigin,
        capExplorationProbeOptions(options, retryMs),
      ));
    } catch {
      console.warn("[collector] foreground billing hydration unavailable; keeping inactive evidence");
      return evidence;
    }
  }

  async dispose(): Promise<void> {
    if (this.tabId !== undefined) await chrome.tabs.remove(this.tabId).catch(() => undefined);
    this.tabId = undefined;
  }
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => done(new Error("supplier exploration page load timed out")), timeoutMs);
    const onUpdated = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedId === tabId && info.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") done();
    }).catch(() => undefined);
  });
}

function canonicalPageUrl(value: string, expectedOrigin: string): string | undefined {
  try {
    exactOriginPattern(expectedOrigin);
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== expectedOrigin || url.username || url.password || url.pathname.length > 320) return undefined;
    const exploration = safeExplorationUrl(url.toString(), expectedOrigin);
    if (exploration) return exploration;
    // Reopening the page the person already has open is not persistence, so it
    // keeps its own route. Everything a candidate stores is reduced separately.
    return safeReplayUrl(url.toString(), expectedOrigin);
  } catch {
    return undefined;
  }
}

function emptyDiagnostic(origin: string, mode: ExplorationMode): DiscoveryDiagnosticV1 {
  const site = new URL(origin).hostname;
  const budget = explorationBudget(mode);
  return {
    schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
    site,
    runtime: {
      collectorVersion: COLLECTOR_RUNTIME_IDENTITY.collectorVersion,
      discoveryEngine: COLLECTOR_RUNTIME_IDENTITY.discoveryEngine,
    },
    limits: { pages: budget.pages, depth: budget.depth, durationMs: budget.durationMs },
    timing: { elapsedMs: 0 },
    pages: { attempted: 0, linked: 0, commonRoutes: 0 },
    evidence: { jsonResources: 0, observedRequests: 0, replayedRequests: 0, documentLinks: 0, structuredDataPages: 0, crossOriginHosts: [] },
    candidates: { compiled: 0, previewed: 0, retained: 0 },
    coverage: { mode, attemptedFamilies: [], exhaustedFamilies: [], unavailableFamilies: [], slicesCompleted: 0 },
    attempts: [],
    termination: "queue_exhausted",
    result: "not_found",
  };
}

function recordAttempt(
  diagnostic: DiscoveryDiagnosticV1,
  page: number,
  source: ExplorationPageSource,
  adapter: DiscoveryAdapterId | undefined,
  result: DiscoveryAttemptResult,
  durationMs: number,
  details: {
    route: string;
    resolvedRoute?: string;
    evidence?: DiscoveryAttemptEvidence;
    admission?: CandidateAdmissionSignal[];
  },
): void {
  if (diagnostic.attempts.length < 80) {
    const route = toDiagnosticRoute(details.route);
    const resolvedRoute = details.resolvedRoute ? toDiagnosticRoute(details.resolvedRoute) : undefined;
    diagnostic.attempts.push({
      page,
      source,
      route,
      ...(resolvedRoute && resolvedRoute !== route ? { resolvedRoute } : {}),
      adapter,
      result,
      durationMs: Math.min(60_000, Math.max(0, Math.trunc(durationMs))),
      ...(details.evidence ? { evidence: details.evidence } : {}),
      ...(details.admission?.length ? { admission: details.admission } : {}),
    });
  }
  console.info(`[collector] discovery page ${page}/${diagnostic.limits.pages} (${source} ${toDiagnosticRoute(details.route)})${adapter ? ` ${adapter}` : ""} -> ${result} (${Math.trunc(durationMs)}ms)`);
}

function diagnosticEvidence(evidence: PageEvidence): DiscoveryAttemptEvidence {
  return {
    jsonResources: evidence.resources.length,
    observedRequests: evidence.resources.filter((resource) => resource.source === "observed").length,
    replayedRequests: evidence.resources.filter((resource) => resource.source === "replayed").length,
    documentLinks: evidence.stats.documentLinks,
    structuredData: evidence.stats.structuredData,
    semanticControls: evidence.stats.semanticControls,
    semanticControlsRejected: evidence.stats.semanticControlsRejected ?? 0,
    semanticNavigationSteps: evidence.stats.semanticNavigationSteps ?? 0,
  };
}

function markCoverageFamily(diagnostic: DiscoveryDiagnosticV1, family: ExplorationFamily): void {
  if (!diagnostic.coverage!.attemptedFamilies.includes(family)) diagnostic.coverage!.attemptedFamilies.push(family);
}

function markCoverageFamilies(diagnostic: DiscoveryDiagnosticV1, families: readonly ExplorationFamily[]): void {
  for (const family of families) markCoverageFamily(diagnostic, family);
}

function allEnabledFamiliesAttempted(diagnostic: DiscoveryDiagnosticV1): boolean {
  return ENABLED_EXPLORATION_FAMILIES.every((family) => diagnostic.coverage!.attemptedFamilies.includes(family));
}

function finalizeCoverage(diagnostic: DiscoveryDiagnosticV1, frontierExhausted: boolean): boolean {
  if (!frontierExhausted) {
    diagnostic.coverage!.exhaustedFamilies = [];
    diagnostic.coverage!.unavailableFamilies = [];
    return false;
  }
  diagnostic.coverage!.exhaustedFamilies = ENABLED_EXPLORATION_FAMILIES.filter((family) =>
    diagnostic.coverage!.attemptedFamilies.includes(family));
  diagnostic.coverage!.unavailableFamilies = ENABLED_EXPLORATION_FAMILIES.filter((family) =>
    !diagnostic.coverage!.attemptedFamilies.includes(family));
  return true;
}

function previewResult(error: unknown): DiscoveryAttemptResult {
  return error instanceof CandidatePreviewError ? error.code : "policy_rejected";
}

function candidateScore(adapter: DiscoveryAdapterId, count: number, routeScore: number): number {
  const proof = adapter === "network-json" ? 300 : adapter === "embedded-json" ? 200 : adapter === "dom-links" ? 100 : 80;
  const boundedRouteScore = Number.isFinite(routeScore) ? Math.max(0, Math.min(40, routeScore)) : 40;
  return proof + boundedRouteScore + Math.min(25, Math.max(0, count));
}

/**
 * A full fallback set is only an early-stop signal when every retained plan is
 * backed by structured network or embedded data. Three DOM-shaped guesses are
 * still weaker than a structured source that may exist on the next billing
 * route, so the bounded frontier must keep exploring in that case.
 */
export function hasEnoughStrongCandidates(retained: readonly { score: number }[]): boolean {
  const STRUCTURED_EVIDENCE_SCORE = 200;
  return retained.length >= MAX_DISCOVERY_CANDIDATES &&
    retained.every((candidate) => candidate.score >= STRUCTURED_EVIDENCE_SCORE);
}

/**
 * Stop as soon as the search has proof, not when its budget runs out.
 *
 * A `network-json` or `embedded-json` candidate only reaches `retained` after
 * `previewCandidate` has authenticated, listed real invoice references, and
 * checked that every document URL is an approved HTTPS origin. That is the same
 * proof the run would hold after exhausting the frontier, so the remaining pages
 * can only cost the person time.
 *
 * A `dom-links` plan is proof of documents too — invoice-context links the page
 * actually renders — but it carries no field mapping, so it waits until the two
 * places a structured source is most likely to appear have been read: the page
 * the person opened, and its cold replay.
 *
 * A `dom-actions` plan is the weakest evidence, so it keeps the frontier moving
 * for one wave of billing-intent routes before it settles for itself.
 *
 * Requiring all four adapter families to have been *attempted* — the old
 * condition, which structured evidence alone could never satisfy — meant a
 * portal that answered on its first page still paid the entire budget.
 */
/**
 * Whether a retained candidate is backed by structured data.
 *
 * This is the one condition `discoveryProofIsSufficient` accepts without regard
 * to how much of the site has been explored — which is exactly what makes it
 * safe to act on mid-wave, before the rest of the site has been seen.
 */
export function structuredProofRetained(
  retained: readonly { profile: { adapter: { id: DiscoveryAdapterId } } }[],
): boolean {
  return retained.some(({ profile }) =>
    profile.adapter.id === "network-json" || profile.adapter.id === "embedded-json");
}

export function discoveryProofIsSufficient(
  retained: readonly { profile: { adapter: { id: DiscoveryAdapterId } } }[],
  progress: { entryExplored: boolean; exploredWaves: number },
): boolean {
  const adapters = retained.map((candidate) => candidate.profile.adapter.id);
  if (structuredProofRetained(retained)) return true;
  if (!progress.entryExplored) return false;
  if (adapters.includes("dom-links")) return true;
  return adapters.length > 0 && progress.exploredWaves >= 1;
}

/**
 * Targets that may share a wave with the user's active tab.
 *
 * The entry snapshot, its cold replay, and a remembered route. The last two run
 * in disposable tabs of their own, so none of the three can interfere with
 * another — and a remembered route only earns its keep by running here. Held
 * back to the following wave it merely joins probes that were going to happen
 * anyway, costing a page and saving no time at all.
 */
const ENTRY_WAVE_SOURCES: ReadonlySet<ExplorationPageSource> = new Set(["entry", "entry_replay", "remembered"]);

function entryWave(queue: readonly ExplorationTarget[]): boolean {
  return queue[0] !== undefined && ENTRY_WAVE_SOURCES.has(queue[0].source);
}

function entryWaveWidth(queue: readonly ExplorationTarget[]): number {
  let width = 0;
  while (width < queue.length && width < ENTRY_WAVE_SOURCES.size && ENTRY_WAVE_SOURCES.has(queue[width].source)) {
    width += 1;
  }
  return Math.max(1, width);
}

function retainCandidate(
  retained: Array<{ profile: DiscoveredSupplierProfileV1; score: number }>,
  candidate: { profile: DiscoveredSupplierProfileV1; score: number },
): void {
  const invoices = candidate.profile.recipe.invoices;
  const listIdentity = invoices.strategy === "dom" ? invoices.list.open : invoices.list.request.url;
  const key = `${candidate.profile.adapter.id}|${invoices.strategy}|${listIdentity}`;
  const existing = retained.findIndex(({ profile }) => {
    const current = profile.recipe.invoices;
    const currentList = current.strategy === "dom" ? current.list.open : current.list.request.url;
    return `${profile.adapter.id}|${current.strategy}|${currentList}` === key;
  });
  if (existing >= 0) {
    if (candidate.score > retained[existing].score) retained[existing] = candidate;
  } else {
    retained.push(candidate);
  }
  retained.sort((left, right) => right.score - left.score || left.profile.entryUrl.localeCompare(right.profile.entryUrl));
  if (retained.length > MAX_DISCOVERY_CANDIDATES) retained.length = MAX_DISCOVERY_CANDIDATES;
}

function enqueueTargets(
  queue: ExplorationTarget[],
  known: Set<string>,
  planned: readonly ExplorationTarget[],
  completedTargetKeys: ReadonlySet<string> = new Set(),
): void {
  for (const next of planned) {
    if (known.has(next.url) || completedTargetKeys.has(explorationTargetKey(next))) continue;
    known.add(next.url);
    queue.push(next);
  }
  queue.splice(0, queue.length, ...rankExplorationQueue(queue));
}

function recipeFromDraft(
  draft: DraftRecipe,
  origin: string,
  entryUrl: string,
  displayName: string,
): VendorRecipe | undefined {
  try {
    const raw = structuredClone(draft.recipe) as Record<string, unknown>;
    const invoices = raw.invoices as {
      strategy?: string;
      list?: { request?: { url?: string }; map?: { total?: unknown; documentUrl?: unknown } };
    } | undefined;
    if (invoices?.strategy === "html" && invoices.list?.request) invoices.list.request.url = entryUrl;
    // Generic inference cannot prove whether integer amounts are minor or major
    // units. Omitting the total is safer than uploading plausible wrong data.
    if (invoices?.list?.map) delete invoices.list.map.total;
    if (invoices?.list?.map?.documentUrl && draft.notes.some((note) => note.includes("Stripe HOSTED invoice page"))) {
      const current = invoices.list.map.documentUrl;
      const extractor = typeof current === "string"
        ? { path: current, transforms: [] as unknown[] }
        : structuredClone(current as { path: string; transforms?: unknown[] });
      extractor.transforms = [
        ...(extractor.transforms ?? []),
        { kind: "replace", pattern: "^https://invoice\\.stripe\\.com/i/([^/?#]+)/([^/?#]+)(\\?.*)?$", with: "https://pay.stripe.com/invoice/$1/$2/pdf$3" },
      ];
      invoices.list.map.documentUrl = extractor;
      raw.hosts = [
        ...(Array.isArray(raw.hosts) ? raw.hosts : []).filter((host) => host !== "https://invoice.stripe.com/*"),
        ...STRIPE_KNOWN_DOCUMENT_HOSTS,
      ];
    }
    const auth = raw.auth as { check?: { request?: { url?: string } }; loginUrl?: string } | undefined;
    if (auth?.check?.request?.url && new URL(auth.check.request.url).origin === origin && auth.check.request.url.startsWith(`${origin}/`)) {
      if (new URL(auth.check.request.url).pathname === new URL(entryUrl).pathname) auth.check.request.url = entryUrl;
    }
    if (auth) auth.loginUrl = origin;
    return validateRecipe({
      ...raw,
      id: "discovered-candidate",
      name: displayName,
      homepage: origin,
      hosts: normalizeHosts(raw.hosts, origin),
      category: "discovered",
      icon: undefined,
      fetchContext: "page",
      notes: "Locally discovered candidate.",
    });
  } catch {
    return undefined;
  }
}

function findLikelyDocumentLinks(html: string, baseUrl: string, pageTitle?: string): string[] {
  const links = new Set<string>();
  const invoiceContext = /invoice|receipt|billing|statement|transaction|faktura|kvitto|rechnung|beleg|facture|reçu|factura|recibo|fattura|ricevuta/i;
  // The route is a search hypothesis. A guessed /invoices path must never make
  // a site-wide "Download" link look like invoice evidence, so page context
  // comes only from independently rendered title and heading text.
  const headings = [...html.matchAll(/<(?:h1|h2|h3|caption)\b[^>]*>([\s\S]{0,400}?)<\/(?:h1|h2|h3|caption)>/gi)]
    .slice(0, 12)
    .map((match) => match[1].replace(/<[^>]*>/g, " "))
    .join(" ")
    .slice(0, 2_000);
  const pageHasInvoiceContext = invoiceContext.test(`${pageTitle ?? ""} ${headings}`);
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = match[1];
    const href = /\bhref="([^"]+)"/i.exec(attributes)?.[1];
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      const path = url.pathname.toLowerCase();
      // Only the standalone download attribute counts, matching a[download].
      // A data-download hook is not re-findable by the compiled recipe.
      const explicitDownload =
        /(?:^|\s)download(?=[\s=>]|$)/i.test(attributes) ||
        /\b(?:aria-label|title)="[^"]*download[^"]*"/i.test(attributes);
      const providerDocument = Boolean(documentProviderForUrl(url));
      const directDocument =
        path.endsWith(".pdf") || /(?:^|\/)download(?:\/|$)/i.test(path) ||
        /(?:^|\/)pdf(?:\/|$)/i.test(path) || /^\/account\/receipt\//i.test(path) ||
        providerDocument;
      const knownInvoiceDocument = /^\/account\/receipt\//i.test(path) ||
        (url.hostname === "invoice.stripe.com" && /^\/i\/[^/]+\/[^/]+$/.test(path));
      const linkHasInvoiceContext = invoiceContext.test(`${path} ${attributes}`);
      if (knownInvoiceDocument || ((explicitDownload || directDocument) && (pageHasInvoiceContext || linkHasInvoiceContext))) {
        links.add(url.toString());
      }
      if (links.size >= 100) break;
    } catch {
      // Malformed page links are not document evidence.
    }
  }
  return [...links];
}

function directDomRecipe(origin: string, entryUrl: string, displayName: string, links: string[]): VendorRecipe | undefined {
  try {
    const hosts = new Set([exactOriginPattern(origin)]);
    for (const href of links) {
      const url = normalizedDocumentUrl(new URL(href, entryUrl));
      if (url.protocol === "https:") {
        hosts.add(exactOriginPattern(url.origin));
        if (documentProviderForUrl(url)?.id === "stripe") {
          for (const host of STRIPE_KNOWN_DOCUMENT_HOSTS) hosts.add(host);
        }
      }
    }
    return validateRecipe({
      id: "discovered-candidate",
      name: displayName,
      homepage: origin,
      hosts: [...hosts].sort(),
      category: "discovered",
      fetchContext: "page",
      notes: "Locally discovered candidate.",
      auth: {
        check: { request: { url: authProbeUrl(entryUrl) }, expect: { statusIn: [200] } },
        loginUrl: origin,
      },
      invoices: {
        strategy: "dom",
        list: {
          open: entryUrl,
          steps: [
            { action: "waitFor", selector: DOM_LINK_SELECTOR, timeoutMs: 8_000 },
            { action: "extractAll", selector: DOM_LINK_SELECTOR, attr: "href", as: "documents" },
          ],
          continuation: {
            mode: "auto",
            maxActions: 8,
            maxDocuments: 500,
            timeoutMs: 30_000,
            allowScroll: true,
          },
          hrefsFrom: "documents",
        },
        document: { contentType: "application/pdf" },
      },
    });
  } catch {
    return undefined;
  }
}

function semanticDomRecipe(
  origin: string,
  entryUrl: string,
  displayName: string,
  observedCrossOriginHosts: readonly string[],
): VendorRecipe | undefined {
  try {
    return validateRecipe({
      id: "discovered-candidate",
      name: displayName,
      homepage: origin,
      // Exact HTTPS origins observed while the billing page loaded are the
      // only cross-origin action results allowed through the DOM boundary.
      hosts: normalizeHosts(
        observedCrossOriginHosts.slice(0, 8).map((host) => `https://${host}`),
        origin,
      ),
      category: "discovered",
      fetchContext: "page",
      notes: "Locally discovered semantic download candidate.",
      auth: {
        check: { request: { url: authProbeUrl(entryUrl) }, expect: { statusIn: [200] } },
        loginUrl: origin,
      },
      invoices: {
        strategy: "dom",
        list: {
          open: entryUrl,
          steps: [{ action: "extractSemanticDownloads", as: "documents", maxActions: 12 }],
          continuation: {
            mode: "auto",
            maxActions: 12,
            maxDocuments: 100,
            timeoutMs: 60_000,
            allowScroll: true,
          },
          hrefsFrom: "documents",
        },
        document: { contentType: "application/pdf" },
      },
    });
  } catch {
    return undefined;
  }
}

/**
 * The route discovery asked for, when it is a usable supplier entry.
 *
 * A route that cannot survive entry normalization is not a better entry than
 * the URL that actually served the document, so the served URL remains the
 * fallback.
 */
function requestedEntryUrl(requestedUrl: string, servedEntryUrl: string): string {
  try {
    const requested = safeEntryUrl(requestedUrl);
    return new URL(requested).origin === new URL(servedEntryUrl).origin ? requested : servedEntryUrl;
  } catch {
    return servedEntryUrl;
  }
}

function authProbeUrl(entryUrl: string): string {
  const url = new URL(entryUrl);
  url.hash = "";
  return url.toString();
}

function normalizedDocumentUrl(url: URL): URL {
  return new URL(canonicalDocumentProviderUrl(url));
}

function normalizeHosts(value: unknown, origin: string): string[] {
  const hosts = new Set<string>([exactOriginPattern(origin)]);
  if (Array.isArray(value)) {
    for (const candidate of value.slice(0, 8)) {
      if (typeof candidate !== "string") continue;
      try {
        const parsed = new URL(candidate.endsWith("/*") ? candidate.slice(0, -2) : candidate);
        if (parsed.protocol === "https:" && !parsed.hostname.includes("*")) hosts.add(exactOriginPattern(parsed.origin));
      } catch {
        // Invalid inferred origins are discarded before policy validation.
      }
    }
  }
  return [...hosts].sort();
}

async function resolvePreviewScopes(
  recipe: VendorRecipe,
  ctx: ReturnType<typeof buildRunContext>["ctx"],
): Promise<Record<string, unknown>[]> {
  let scopes: Record<string, unknown>[] = [{}];
  for (const option of recipe.config ?? []) {
    const response = await ctx.fetch(option.discover.request, ctx.vars);
    if (!response.ok) throw new Error("supplier scope discovery failed");
    const root = await response.json();
    const raw = option.discover.items
      ? getArray(root, option.discover.items).map((item) => extract(item, option.discover.value))
      : [extract(root, option.discover.value)];
    const values = raw.filter((value) => value !== undefined && value !== null && value !== "").slice(0, 20);
    if (!values.length) throw new Error("supplier scope discovery returned no reusable value");
    scopes = scopes.flatMap((scope) => values.map((value) => ({ ...scope, [option.id]: value }))).slice(0, 20);
  }
  return scopes;
}
