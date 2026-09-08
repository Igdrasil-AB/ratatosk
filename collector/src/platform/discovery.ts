import {
  createDiscoveredSupplierCandidateSet,
  createDiscoveredSupplierProfile,
  deriveSupplierDisplayName,
  exactOriginPattern,
  isBoundedTenantIdentifierSegment,
  isSafeReadOnlyGraphqlRequest,
  MAX_DISCOVERY_CANDIDATES,
  safeEntryUrl,
  reuseDiscoveredSupplierIdentity,
  replayPlanKindForRecipe,
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
import type {
  InvoiceRef,
  ReplayPlanKind,
  ReplayTrace,
  RequestSpec,
  VendorRecipe,
} from "../../../src/core/types";
import { DEFAULT_SAFE_CONCURRENCY, mapConcurrentInSettleOrder, mapConcurrentOrdered } from "../../../src/core/concurrency";
import {
  emptyReplayTrace as emptyReplay,
  replayFailureTrace as replayFailure,
  replayTraceWithComplete as withReplayComplete,
  replayTraceWithPhase as withReplayFailure,
  replayTraceWithPlanKind as withReplayPlanKind,
} from "../../../src/core/replay-trace";
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
  type DiscoveryProbeCause,
} from "./discovery-diagnostic";
import {
  entryProbeOptions,
  EXPLORATION_ROUTE_POLICY,
  capExplorationProbeOptions,
  checkpointFrontierItem,
  createExplorationCheckpoint,
  ENABLED_EXPLORATION_FAMILIES,
  explorationBudget,
  explorationFamilyForTarget,
  explorationProbeOptions,
  explorationProbeTiming,
  explorationTargetKey,
  planExplorationTargets,
  rankExplorationQueue,
  restoreExplorationTargets,
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
import { DocumentActionController, ReplayPhaseFailed } from "./document-action-controller";

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
    semanticNavigationStatus?: "disabled" | "complete" | "time_cap" | "action_cap" | "mutation_blocked";
    evidenceDropped?: number;
  };
}

type Candidate = {
  adapterId: DiscoveryAdapterId;
  recipe: VendorRecipe;
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
  constructor(readonly code: DiscoveryAttemptResult, readonly replay?: ReplayTrace) {
    super(code);
    this.name = "CandidatePreviewError";
  }
}

export function discoveryProbeFailureCode(error: unknown): DiscoveryProbeCause {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (/supplier exploration deadline exceeded/i.test(message)) return "outer_deadline";
  if (/supplier exploration page load timed out/i.test(message)) return "navigation_deadline";
  if (name === "SecurityError" || /mutating request/i.test(message)) return "mutation_guard";
  if (name === "DocumentActionFailed" || /document.action/i.test(message)) return "action_scope";
  const evidence = /supplier page evidence is invalid:([a-z_]+)/.exec(message)?.[1];
  if (evidence === "page_mutation_guard") return "mutation_guard";
  if (evidence === "main_result") return "main_result_missing";
  if (evidence === "page_type_error" || evidence === "page_range_error" || evidence === "page_exception") return "page_exception";
  if (/supplier page evidence is invalid/i.test(message)) return "evidence_invalid";
  if (/supplier tab changed/i.test(message)) return "tab_changed";
  return "other";
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
    hintSource: "active_entry",
    score: Number.MAX_SAFE_INTEGER,
  }];
  if (observerReady) {
    targets.push({
      url: entryUrl,
      depth: 0,
      source: "entry_replay",
      family: "exact_entry",
      hintSource: "cold_replay",
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
      hintSource: "remembered",
      score: REMEMBERED_ROUTE_SCORE,
    });
  }
  return targets;
}

/** Above the curated billing paths (which top out near 68) and every observed
 * link, but far below the entry page. */
const REMEMBERED_ROUTE_SCORE = 5_000;
const WEAK_SEMANTIC_PREVIEW_MS = 2_500;

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
  // A resumed frontier has already completed the active-entry lane. Reinjecting
  // into that live SPA adds no evidence and can hang forever while Chrome waits
  // on a navigating or unresponsive frame — exactly when Search Deeper must
  // remain able to finish from its saved disposable-route frontier.
  if (observerReady && !resumed) await pageObserver.adopt(tabId);
  // Resuming a checkpoint already carries its own frontier, so the shortcut is
  // only seeded when a search actually starts.
  const remembered = resumed ? undefined : (await getRememberedRoute(expectedOrigin))?.entryUrl;
  if (remembered) console.info(`[collector] discovery will try the remembered route ${toDiagnosticRoute(remembered)} first`);
  const restored = resumed ? restoreExplorationTargets(resumed, expectedOrigin) : [];
  // A checkpoint with no replayable frontier is terminal progress, not license
  // to start the same search again with its old budget already consumed.
  const queue = restored.length
    ? restored
    : resumed ? [] : createInitialExplorationTargets(firstUrl, observerReady, remembered);
  const known = new Set([firstUrl, ...queue.map((target) => target.url)]);
  const incompleteTargets: ExplorationTarget[] = [];
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
  /** Whether the entry probe has settled, so its title can no longer be lost. */
  let entryObserved = false;
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
      frontier: [...queue, ...incompleteTargets].map(checkpointFrontierItem),
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
        const timing = explorationProbeTiming(baseOptions, remainingMs);
        const probeOptions: ProbeOptions = {
          ...timing.probeOptions,
          allowForegroundRetry: index === foregroundCandidateIndex,
          // The page the person chose is observational only. Menu exploration
          // and scrolling belong to the disposable cold replay/background tabs.
          allowSemanticNavigation: target.source !== "entry",
          allowScroll: target.source !== "entry",
        };
        const probe = target.source === "entry"
          ? probeSupplierTab(tabId, expectedOrigin, probeOptions)
          : explorers[index].probe(target.url, probeOptions);
        return runWithinExplorationBudget(probe, timing.watchdogMs);
      });

      for await (const probe of probes) {
        const { target, page, pageStartedAt } = scheduled[probe.index];
        // Settled either way: whatever this probe was going to contribute to
        // the supplier's name, it has contributed.
        if (target.source === "entry") entryObserved = true;
        if (probe.status !== "fulfilled") {
          const failureCode = probe.status === "rejected" ? discoveryProbeFailureCode(probe.error) : "cancelled";
          recordAttempt(diagnostic, page, target.source, undefined, "probe_failed", Date.now() - pageStartedAt, {
            route: target.url,
            probeCause: failureCode,
          });
          if (target.source === "entry") {
            enqueueTargets(queue, known, planExplorationTargets({
              origin: expectedOrigin,
              links: [],
              visited: known,
              nextDepth: 1,
              limit: budget.pages - diagnostic.pages.attempted,
              maxDepth: budget.depth,
            }), completedTargetKeys);
          }
          completedTargetKeys.add(explorationTargetKey(target));
          continue;
        }

        const evidence = probe.value;
        const semanticLaneIncomplete = evidence.stats.semanticNavigationStatus === "time_cap";
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
        const observedSemanticRoutes = evidence.navigationUrls.flatMap((item) =>
          typeof item === "object" && item.hintSource === "semantic_navigation" ? [item.url] : []);
        const candidateRoute = (evidence.stats.semanticNavigationSteps ?? 0) > 0
          ? observedSemanticRoutes.at(-1) ?? resolvedPage ?? target.url
          : target.url;
        const openUrl = requestedEntryUrl(candidateRoute, entryUrl);
        const domOpen = replayableDomOpen(candidateRoute, evidence);
        // These four evidence families are inspected for every successfully
        // loaded route, so a large navigation graph cannot starve them.
        markCoverageFamilies(diagnostic, ["observed_network", "embedded_data", "document_provider", "semantic_download"]);
        const candidates = compileCandidates(evidence, entryUrl, display.name, openUrl, domOpen);
        diagnostic.candidates.compiled += candidates.length;
        const routeEvidence = diagnosticEvidence(evidence);
        if (!candidates.length) recordAttempt(diagnostic, page, target.source, undefined,
          domOpen === null && (evidence.stats.documentLinks > 0 || evidence.stats.semanticControls > 0 || (evidence.stats.semanticSections ?? 0) > 0)
            ? "route_not_replayable"
            : "no_candidate",
          Date.now() - pageStartedAt, {
          route: target.url,
          resolvedRoute: evidence.url,
          evidence: routeEvidence,
        });

        let candidatePreviewIncomplete = false;
        const evaluations = await mapConcurrentOrdered(candidates, {
          limit: DEFAULT_SAFE_CONCURRENCY.candidatePreviews,
        }, async (candidate) => {
          diagnostic.candidates.previewed += 1;
          const remainingMs = explorationDeadline - Date.now();
          const planKind = candidateReplayPlanKind(candidate);
          if (remainingMs <= 0) throw new CandidatePreviewError(
            "limit_reached", replayFailure(planKind, "document_enumeration", "time_cap"),
          );
          // A lone document-shaped link on an ordinary application page is
          // useful enough to verify, but too weak to monopolize the interactive
          // search. Give that semantic fallback a short causal replay lease so
          // observed billing routes still receive most of the global budget.
          const weakSemanticLink = candidate.adapterId === "dom-actions" &&
            candidate.admission.length === 1 && candidate.admission[0] === "direct_document_link";
          const candidateDeadline = weakSemanticLink
            ? Math.min(explorationDeadline, Date.now() + WEAK_SEMANTIC_PREVIEW_MS)
            : explorationDeadline;
          const candidateRemainingMs = Math.max(1, candidateDeadline - Date.now());
          const preview = await runWithinExplorationBudget(
            previewCandidate(candidate.recipe, candidateDeadline, planKind),
            candidateRemainingMs,
          ).catch((error) => {
            if (discoveryProbeFailureCode(error) === "outer_deadline") {
              throw new CandidatePreviewError(
                "limit_reached", replayFailure(planKind, "document_enumeration", "time_cap"),
              );
            }
            throw error;
          });
          return { candidate, candidateCount: preview.count, replay: preview.replay };
        });
        for (const evaluation of evaluations) {
          if (evaluation.status === "cancelled") continue;
          if (evaluation.status === "rejected") {
            const candidate = candidates[evaluation.index];
            if (previewResult(evaluation.error) === "limit_reached") candidatePreviewIncomplete = true;
            recordAttempt(diagnostic, page, target.source, candidate.adapterId, previewResult(evaluation.error), Date.now() - pageStartedAt, {
              route: target.url,
              resolvedRoute: evidence.url,
              evidence: routeEvidence,
              admission: candidate.admission,
              replay: evaluation.error instanceof CandidatePreviewError ? evaluation.error.replay : undefined,
            });
            continue;
          }
          const { candidate, candidateCount, replay } = evaluation.value;
          try {
            console.info(
              `[collector] discovery page ${page}/${budget.pages} (${target.source}) ${candidate.adapterId} -> previewed`,
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
              replay,
            });
          } catch {
            recordAttempt(diagnostic, page, target.source, candidate.adapterId, "policy_rejected", Date.now() - pageStartedAt, {
              route: target.url,
              resolvedRoute: evidence.url,
              evidence: routeEvidence,
              admission: candidate.admission,
              replay,
            });
          }
        }

        if (target.depth < budget.depth) {
          const planned = planExplorationTargets({
            origin: expectedOrigin,
            links: evidence.navigationUrls,
            visited: known,
            nextDepth: target.depth + 1,
            limit: budget.pages - diagnostic.pages.attempted,
            maxDepth: budget.depth,
          });
          enqueueTargets(queue, known, planned, completedTargetKeys);
        }
        if (semanticLaneIncomplete || candidatePreviewIncomplete) {
          if (!incompleteTargets.some((item) => explorationTargetKey(item) === explorationTargetKey(target))) {
            incompleteTargets.push(target);
          }
        } else {
          completedTargetKeys.add(explorationTargetKey(target));
        }

        // Stop the wave only on evidence that nothing still running could
        // improve on. A structured invoice source ends the search either way,
        // so its siblings are already destined to be discarded — whereas a DOM
        // candidate can be beaten by a JSON one from the very probe that would
        // be abandoned, and those waves are still played out in full.
        //
        // An abandoned probe's page title is abandoned with it, and naming reads
        // every page seen. The entry page is the one whose title matters most
        // and the cheapest to wait for — it is the tab already in front of the
        // person — so it is never the page a shortcut skips.
        if (structuredProofRetained(retained) && entryObserved) {
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
    diagnostic.timing.elapsedMs = Math.min(300_000, elapsedBefore + Math.max(0, Date.now() - startedAt));
    diagnostic.candidates.retained = retained.length;
    const coverageComplete = finalizeCoverage(diagnostic, queue.length === 0 && incompleteTargets.length === 0);
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

  diagnostic.timing.elapsedMs = Math.min(300_000, elapsedBefore + Math.max(0, Date.now() - startedAt));
  const coverageComplete = finalizeCoverage(diagnostic, queue.length === 0 && incompleteTargets.length === 0);
  diagnostic.termination = incompleteTargets.length > 0
    ? "time_cap"
    : queue.length && diagnostic.pages.attempted >= budget.pages ? "page_cap"
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

export async function previewCandidate(
  recipe: VendorRecipe,
  expiresAt?: number,
  planKind: ReplayPlanKind = replayPlanKindForRecipe(recipe),
): Promise<{ count: number; replay?: ReplayTrace }> {
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
    const strategy = buildStrategies(previewRecipe, { expiresAt })[previewRecipe.invoices.strategy];
    const refs: InvoiceRef[] = [];
    let replay: ReplayTrace | undefined;
    try {
      for (const scope of scopes.slice(0, 20)) {
        try {
          const listed = await strategy.list(previewRecipe, { ...ctx.vars, ...scope }, ctx);
          refs.push(...listed.refs);
          if (listed.replay) replay = withReplayPlanKind(listed.replay, planKind);
        } catch (error) {
          if (error instanceof ReplayPhaseFailed) {
            throw new CandidatePreviewError("list_failed", withReplayPlanKind(error.replay, planKind));
          }
          throw new CandidatePreviewError("list_failed", replay);
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
        throw new CandidatePreviewError("invalid_identity", withReplayFailure(
          replay ?? emptyReplay(planKind), "identity_validation", "ambiguous",
        ));
      }
      if (ids.has(ref.vendorInvoiceId)) continue;
      ids.add(ref.vendorInvoiceId);
      if (
        !ref.documentUrl && !recipe.invoices.document.request &&
        ref.resolution?.kind !== "semantic_action"
      ) throw new CandidatePreviewError("invalid_document_path", withReplayFailure(
        replay ?? emptyReplay(planKind), "identity_validation", "ambiguous",
      ));
      if (ref.documentUrl) {
        let document: URL;
        try { document = new URL(ref.documentUrl); } catch {
          throw new CandidatePreviewError("invalid_document_path", withReplayFailure(
            replay ?? emptyReplay(planKind), "identity_validation", "ambiguous",
          ));
        }
        if (document.protocol !== "https:" || document.username || document.password || !allowedOrigins.has(document.origin)) {
          throw new CandidatePreviewError("unapproved_document_origin", withReplayFailure(
            replay ?? emptyReplay(planKind), "identity_validation", "page_left_origin",
          ));
        }
      }
    }
    if (!ids.size) throw new CandidatePreviewError("no_documents", replay ?? replayFailure(
      planKind, "document_enumeration", "not_present",
    ));
    replay = withReplayComplete(replay ?? emptyReplay(planKind), "identity_validation");
    return { count: ids.size, replay };
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
  domOpen: { url: string; config?: VendorRecipe["config"] } | null = { url: openUrl },
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

  const links = findLikelyDocumentLinks(evidence.html, evidence.url, evidence.title);
  const domCandidate = links.length && domOpen
    ? directDomRecipe(evidence.origin, entryUrl, domOpen.url, displayName, links, domOpen.config)
    : undefined;
  if (domCandidate) candidates.push({
    adapterId: "dom-links",
    recipe: domCandidate,
    admission: ["direct_document_link"],
  });
  const semanticEvidenceCount = evidence.stats.semanticControls + (evidence.stats.semanticSections ?? 0) +
    (!domCandidate && evidence.stats.documentLinks > 0 && (
      (evidence.stats.semanticNavigationSteps ?? 0) > 0 || evidence.stats.semanticNavigationStatus === "disabled"
    ) ? evidence.stats.documentLinks : 0);
  const semanticOpen: { url: string; config?: VendorRecipe["config"] } | null = domOpen ?? (() => {
    const replayProved = evidence.stats.semanticNavigationStatus === "complete" &&
      (evidence.stats.semanticNavigationSteps ?? 0) > 0;
    const userOpenedInvoiceSurface = evidence.stats.semanticNavigationStatus === "disabled" &&
      (evidence.stats.documentLinks > 0 || evidence.stats.semanticControls > 0 || (evidence.stats.semanticSections ?? 0) > 0);
    if (!replayProved && !userOpenedInvoiceSurface) return null;
    try {
      return safeEntryUrl(openUrl) === openUrl && new URL(openUrl).origin === evidence.origin
        ? { url: openUrl }
        : null;
    } catch {
      return null;
    }
  })();
  const semanticCandidate = !domCandidate && semanticEvidenceCount > 0 && semanticOpen
    ? semanticDomRecipe(
        evidence.origin,
        entryUrl,
        semanticOpen.url,
        displayName,
        evidence.crossOriginHosts,
        semanticOpen.config,
      )
    : undefined;
  if (semanticCandidate) {
    const admission: CandidateAdmissionSignal[] = [];
    if (
      evidence.stats.documentLinks > 0 && evidence.stats.semanticControls === 0 &&
      (evidence.stats.semanticSections ?? 0) === 0
    ) admission.push("direct_document_link");
    if ((evidence.stats.semanticSections ?? 0) > 0) admission.push("independent_invoice_context");
    if (evidence.stats.semanticControls > 0) admission.push("semantic_document_control");
    candidates.push({
      adapterId: "dom-actions",
      recipe: semanticCandidate,
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
  allowSemanticNavigation?: boolean;
  allowScroll?: boolean;
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
  const mainProbe = async () => ({
      kind: "main" as const,
      injections: await controller.runDiscoveryProbe(tabId, () => chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: collectPageEvidenceInPage,
        args: [options, { ...EXPLORATION_ROUTE_POLICY, documentSelector: DOM_LINK_SELECTOR }, DISCOVERY_DOM_POLICY],
      }), { blockMutations: options.allowSemanticNavigation === true }),
    });
  const frameProbe = async () => ({
      kind: "frames" as const,
      injections: await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: collectFrameNetworkEvidenceInPage,
        args: [options],
      }).catch(() => [] as chrome.scripting.InjectionResult<PageEvidence | null>[]),
    });
  type ParallelPageProbe = Awaited<ReturnType<typeof mainProbe>> | Awaited<ReturnType<typeof frameProbe>>;
  const probeTasks: Array<() => Promise<ParallelPageProbe>> = [mainProbe, frameProbe];
  const probes = await mapConcurrentOrdered(
    probeTasks,
    { limit: DEFAULT_SAFE_CONCURRENCY.frameProbes },
    (probe) => probe(),
  );
  const mainOutcome = probes.find((probe) => probe.status === "fulfilled" && probe.value.kind === "main");
  if (!mainOutcome || mainOutcome.status !== "fulfilled") {
    const failure = probes[0];
    throw failure?.status === "rejected" ? failure.error : new Error("supplier page evidence is unavailable");
  }
  const framesResult = probes.find((probe) => probe.status === "fulfilled" && probe.value.kind === "frames");
  const injections = mainOutcome.value.injections;
  const frameInjections = framesResult?.status === "fulfilled" ? framesResult.value.injections : [];
  const mainResult = mainFrameInjectionResult(injections);
  if (mainResult === undefined) throw new Error("supplier page evidence is invalid:main_result");
  const main = parsePageEvidence(mainResult, expectedOrigin, options);
  const frames = frameInjections.filter((injection) => injection.frameId !== 0).flatMap((injection) => {
    if (!injection.result) return [];
    try { return [parsePageEvidence(injection.result, expectedOrigin, options)]; } catch { return []; }
  });
  return mergeFrameNetworkEvidence(main, frames, options.maxResources);
}

export function mainFrameInjectionResult<T>(
  injections: readonly Pick<chrome.scripting.InjectionResult<T>, "frameId" | "result">[],
): T | undefined {
  const main = injections.find((injection) => injection.frameId === 0);
  if (main) return main.result;
  // Older Chrome test doubles predate frameId on InjectionResult. Only retain
  // their legacy single-frame behavior when no item claims any frame identity.
  return injections.every((injection) => !Number.isInteger(injection.frameId))
    ? injections[0]?.result
    : undefined;
}

/** Same-origin subframes contribute only the observer's already-sanitized
 * request evidence. Avoid running the top-level DOM, navigation, scroll, and
 * ResourceTiming probe in frames whose DOM can never become a recipe. */
export async function collectFrameNetworkEvidenceInPage(
  options: Pick<ProbeOptions, "maxResources" | "deadlineMs">,
): Promise<PageEvidence | null> {
  if (window.top === window) return null;
  const maximum = Math.max(1, Math.min(12, options.maxResources));
  const timeoutMs = Math.max(25, Math.min(1_200, options.deadlineMs));
  const deadline = Date.now() + timeoutMs;
  let snapshot: CapturedEntry[] = [];
  try {
    const observer = (window as Window & {
      __ratatoskDiscoveryObserverV1?: { snapshot?: () => Promise<CapturedEntry[]> };
    }).__ratatoskDiscoveryObserverV1;
    if (typeof observer?.snapshot === "function") {
      const value = await Promise.race([
        Promise.resolve(observer.snapshot()),
        new Promise<CapturedEntry[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
      ]);
      if (Array.isArray(value)) snapshot = value.slice(0, maximum);
    }
  } catch {
    snapshot = [];
  }
  const resources: ProbedResource[] = [];
  const crossOriginHosts = new Set<string>();
  let total = 0;
  for (const entry of snapshot) {
    if (
      !entry || (entry.method !== "GET" && entry.method !== "POST") ||
      typeof entry.url !== "string" || entry.url.length > 2_048 ||
      !Number.isInteger(entry.status) || entry.status < 0 || entry.status > 599 ||
      typeof entry.contentType !== "string" || entry.contentType.length > 256 ||
      typeof entry.responseBody !== "string" || entry.responseBody.length > 256_000 ||
      total + entry.responseBody.length > 768_000
    ) continue;
    let url: URL;
    try { url = new URL(entry.url); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
    if (url.origin !== location.origin && crossOriginHosts.size < 8) crossOriginHosts.add(url.hostname);
    const contentType = entry.requestHeaders?.["content-type"];
    resources.push({
      url: url.toString(),
      method: entry.method,
      status: entry.status,
      contentType: entry.contentType,
      body: entry.responseBody,
      ...(entry.requestBody !== undefined && entry.requestBody.length <= 65_536 ? { requestBody: entry.requestBody } : {}),
      ...(contentType === "application/json" ? { requestHeaders: { "content-type": contentType } } : {}),
      ...(entry.requestAuth && entry.requestAuth.scheme !== "none" ? { requestAuthScheme: entry.requestAuth.scheme } : {}),
      ...(entry.redactedResponsePaths?.length ? { credentialPaths: entry.redactedResponsePaths.slice(0, 40) } : {}),
      source: "observed",
      hasLinkNext: false,
    });
    total += entry.responseBody.length;
  }
  const observedKeys = new Set(resources.map((resource) => resource.url));
  const timingUrls = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .flatMap((entry) => {
      try {
        const url = new URL(entry.name);
        return url.protocol === "https:" && url.origin === location.origin &&
          /invoice|receipt|statement|billing|transaction|charge|payment|subscription/i.test(`${url.pathname}${url.search}`) &&
          !/\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|woff2?|ttf|ico)(?:\?|$)/i.test(url.pathname)
          ? [url.toString()]
          : [];
      } catch {
        return [];
      }
    });
  for (const url of [...new Set(timingUrls)]) {
    if (resources.length >= maximum || observedKeys.has(url) || Date.now() >= deadline) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      const response = await fetch(url, { method: "GET", credentials: "include", signal: controller.signal });
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (!contentType.includes("json") || declared > 256_000 || !response.body) continue;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 256_000 || total + length > 768_000) {
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
      resources.push({
        url,
        method: "GET",
        status: response.status,
        contentType,
        body: new TextDecoder().decode(bytes),
        source: "replayed",
        hasLinkNext: false,
      });
      total += length;
    } catch {
      // A frame timing hint is optional; keep observed evidence from other lanes.
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    url: `${location.origin}${location.pathname}`,
    origin: location.origin,
    html: "",
    resources,
    navigationUrls: [],
    crossOriginHosts: [...crossOriginHosts],
    stats: {
      documentLinks: 0,
      structuredData: 0,
      semanticControls: 0,
      semanticSections: 0,
      semanticControlsRejected: 0,
      semanticNavigationSteps: 0,
      semanticNavigationStatus: "disabled",
      evidenceDropped: 0,
    },
  };
}

/** Same-origin frames contribute passive request evidence only. Their DOM,
 * controls, and routes are not replayable by the top-level DOM strategy. */
export function mergeFrameNetworkEvidence(
  main: PageEvidence,
  frames: readonly PageEvidence[],
  maxResources: number,
): PageEvidence {
  const resources = new Map<string, ProbedResource>();
  for (const resource of [main, ...frames].flatMap((evidence) => evidence.resources)) {
    const key = `${resource.method ?? "GET"}|${resource.url}|${resource.requestBody ?? ""}`;
    if (!resources.has(key)) resources.set(key, resource);
  }
  const ranked = [...resources.values()].sort((left, right) =>
    frameResourceScore(right) - frameResourceScore(left) || left.url.localeCompare(right.url));
  return {
    ...main,
    resources: ranked.slice(0, Math.max(1, Math.min(12, maxResources))),
    crossOriginHosts: [...new Set([main, ...frames].flatMap((evidence) => evidence.crossOriginHosts))].slice(0, 8),
  };
}

function frameResourceScore(resource: ProbedResource): number {
  const value = `${resource.url} ${resource.body.slice(0, 4_000)}`;
  return (/invoice|receipt|statement/i.test(value) ? 100 : 0) +
    (/billing|transaction|charge/i.test(value) ? 50 : 0) +
    (/payment|subscription|plan/i.test(value) ? 25 : 0);
}

export function parsePageEvidence(value: unknown, expectedOrigin: string, options: ProbeOptions): PageEvidence {
  const invalid = (code: string): never => { throw new Error(`supplier page evidence is invalid:${code}`); };
  if (value && typeof value === "object" && !Array.isArray(value) && "__ratatoskProbeError" in value) {
    const code = (value as { __ratatoskProbeError?: unknown }).__ratatoskProbeError;
    if (code === "mutation_guard" || code === "type_error" || code === "range_error" || code === "page_exception") {
      return invalid(`page_${code}`);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("root");
  const raw = value as Record<string, unknown>;
  if (typeof raw.origin !== "string" || raw.origin !== expectedOrigin || typeof raw.url !== "string" || raw.url.length > 2_048) return invalid("page");
  let page: URL;
  try { page = new URL(raw.url); } catch { return invalid("page"); }
  if (page.protocol !== "https:" || page.origin !== expectedOrigin || page.username || page.password) return invalid("page");
  let evidenceDropped = 0;
  const dropped = <T>(fallback: T): T => {
    evidenceDropped += 1;
    return fallback;
  };
  const boundedText = (item: unknown, maximum: number): item is string | undefined => item === undefined || (typeof item === "string" && item.length <= maximum);
  const title = boundedText(raw.title, 160) ? raw.title : dropped(undefined);
  const applicationName = boundedText(raw.applicationName, 160) ? raw.applicationName : dropped(undefined);
  const siteName = boundedText(raw.siteName, 160) ? raw.siteName : dropped(undefined);
  const html = typeof raw.html === "string" && raw.html.length <= 750_000 ? raw.html : dropped("");
  const observedHosts = Array.isArray(raw.crossOriginHosts) ? raw.crossOriginHosts.slice(0, 8) : dropped<unknown[]>([]);
  if (Array.isArray(raw.crossOriginHosts) && raw.crossOriginHosts.length > 8) {
    evidenceDropped += raw.crossOriginHosts.length - 8;
  }
  const allowedResourceOrigins = new Set([expectedOrigin]);
  const crossOriginHosts: string[] = [];
  for (const item of observedHosts) {
    if (typeof item !== "string" || item.length > 253 || item.includes(":")) {
      evidenceDropped += 1;
      continue;
    }
    try {
      exactOriginPattern(`https://${item}`);
      allowedResourceOrigins.add(`https://${item}`);
      if (!crossOriginHosts.includes(item)) crossOriginHosts.push(item);
    } catch { evidenceDropped += 1; }
  }
  const resources: ProbedResource[] = [];
  let totalBody = 0;
  const rawResources = Array.isArray(raw.resources) ? raw.resources.slice(0, options.maxResources) : dropped<unknown[]>([]);
  if (Array.isArray(raw.resources) && raw.resources.length > options.maxResources) {
    evidenceDropped += raw.resources.length - options.maxResources;
  }
  for (const item of rawResources) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      evidenceDropped += 1;
      continue;
    }
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
    ) {
      evidenceDropped += 1;
      continue;
    }
    let url: URL;
    try { url = new URL(resource.url); } catch {
      evidenceDropped += 1;
      continue;
    }
    if (url.protocol !== "https:" || !allowedResourceOrigins.has(url.origin) || url.username || url.password || url.hash) {
      evidenceDropped += 1;
      continue;
    }
    totalBody += resource.body.length;
    if (totalBody > 768_000) {
      totalBody -= resource.body.length;
      evidenceDropped += 1;
      continue;
    }
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
  const rawNavigationUrls = Array.isArray(raw.navigationUrls) ? raw.navigationUrls.slice(0, 80) : dropped<unknown[]>([]);
  if (Array.isArray(raw.navigationUrls) && raw.navigationUrls.length > 80) {
    evidenceDropped += raw.navigationUrls.length - 80;
  }
  const navigationUrls: (string | ExplorationLinkEvidence)[] = [];
  for (const item of rawNavigationUrls) {
    if (typeof item === "string") {
      if (item.length > 2_048) {
        evidenceDropped += 1;
        continue;
      }
      const safe = safeExplorationUrl(item, expectedOrigin);
      if (!safe) {
        evidenceDropped += 1;
        continue;
      }
      navigationUrls.push(safe);
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      evidenceDropped += 1;
      continue;
    }
    const evidence = item as Record<string, unknown>;
    if (
      typeof evidence.url !== "string" || evidence.url.length > 2_048 ||
      (evidence.label !== undefined && (typeof evidence.label !== "string" || evidence.label.length > 160)) ||
      (evidence.context !== undefined && (typeof evidence.context !== "string" || evidence.context.length > 240))
    ) {
      evidenceDropped += 1;
      continue;
    }
    const label = typeof evidence.label === "string" ? evidence.label.replace(/\s+/g, " ").trim() : undefined;
    const context = typeof evidence.context === "string" ? evidence.context.replace(/\s+/g, " ").trim() : undefined;
    const semantic = `${label ?? ""} ${context ?? ""}`.trim();
    const hintSource = isExplorationHintSource(evidence.hintSource) ? evidence.hintSource : undefined;
    const safe = hintSource === "semantic_navigation"
      ? safeReplayUrl(evidence.url, expectedOrigin)
      : safeExplorationUrl(evidence.url, expectedOrigin, semantic, { allowBridgeIntent: true });
    if (!safe) {
      evidenceDropped += 1;
      continue;
    }
    navigationUrls.push(label || context || hintSource
      ? { url: safe, ...(label ? { label } : {}), ...(context ? { context } : {}), ...(hintSource ? { hintSource } : {}) }
      : safe);
  }
  const stats = raw.stats && typeof raw.stats === "object" && !Array.isArray(raw.stats)
    ? raw.stats as Record<string, unknown>
    : dropped({} as Record<string, unknown>);
  const boundedCount = (item: unknown) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 1_000;
  const count = (item: unknown): number => boundedCount(item) ? Number(item) : dropped(0);
  const semanticNavigationStatus = stats.semanticNavigationStatus === "disabled" || stats.semanticNavigationStatus === "complete" ||
    stats.semanticNavigationStatus === "time_cap" || stats.semanticNavigationStatus === "action_cap" ||
    stats.semanticNavigationStatus === "mutation_blocked"
    ? stats.semanticNavigationStatus
    : stats.semanticNavigationStatus === undefined ? undefined : dropped(undefined);
  return {
    url: page.toString(),
    origin: expectedOrigin,
    title,
    applicationName,
    siteName,
    html,
    resources,
    navigationUrls,
    crossOriginHosts,
    stats: {
      documentLinks: count(stats.documentLinks),
      structuredData: count(stats.structuredData),
      semanticControls: count(stats.semanticControls),
      semanticSections: stats.semanticSections === undefined ? 0 : count(stats.semanticSections),
      semanticControlsRejected: stats.semanticControlsRejected === undefined ? 0 : count(stats.semanticControlsRejected),
      semanticNavigationSteps: stats.semanticNavigationSteps === undefined ? 0 : count(stats.semanticNavigationSteps),
      ...(semanticNavigationStatus ? { semanticNavigationStatus } : {}),
      evidenceDropped,
    },
  };
}

function isAuthScheme(value: unknown): value is "bearer" | "basic" | "custom" {
  return value === "bearer" || value === "basic" || value === "custom";
}

function isExplorationHintSource(value: unknown): value is NonNullable<ExplorationLinkEvidence["hintSource"]> {
  return value === "dom_link" || value === "semantic_navigation" ||
    value === "resource_timing" || value === "observed_request" || value === "structured_data";
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
export async function collectPageEvidenceInPage(
  options: ProbeOptions,
  routePolicy: typeof EXPLORATION_ROUTE_POLICY & { documentSelector: string },
  semanticPolicy: typeof DISCOVERY_DOM_POLICY,
): Promise<PageEvidence | { __ratatoskProbeError: "mutation_guard" | "type_error" | "range_error" | "page_exception" }> {
  try {
  const MAX_HTML = 750_000;
  const MAX_BODY = 256_000;
  const MAX_TOTAL = 768_000;
  const MAX_RESOURCES = Math.max(1, Math.min(12, options.maxResources));
  const topLevelFrame = window.top === window;
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
  const semanticNavigationTrigger = new RegExp(semanticPolicy.semanticNavigationTriggerPattern, "i");
  const settingsNavigation = new RegExp(semanticPolicy.settingsNavigationPattern, "i");
  const billingNavigation = new RegExp(semanticPolicy.billingNavigationPattern, "i");
  const invoiceSection = new RegExp(semanticPolicy.invoiceSectionPattern, "i");
  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      rect.width > 0 && rect.height > 0;
  };
  const accessibleLabelSources = (element: Element, maximum = 160): string[] => {
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/).filter(Boolean).slice(0, 4)
      .map((id) => document.getElementById(id)?.textContent)
      .filter((value): value is string => Boolean(value));
    const associated = [
      element.closest("label")?.textContent,
      ...(element.id
        ? Array.from(document.querySelectorAll<HTMLLabelElement>("label[for]"))
          .filter((label) => label.htmlFor === element.id).slice(0, 4).map((label) => label.textContent)
        : []),
    ].filter((value): value is string => Boolean(value));
    const sources: Record<(typeof semanticPolicy.accessibleNameOrder)[number], string | null | undefined> = {
      "aria-labelledby": labelledBy.join(" "),
      "aria-label": element.getAttribute("aria-label"),
      "associated-label": associated.join(" "),
      title: element.getAttribute("title"),
      alt: element.getAttribute("alt"),
      value: element.getAttribute("value"),
      "visible-text": element.textContent,
    };
    return semanticPolicy.accessibleNameOrder
      .map((source) => (sources[source] || "").replace(/\s+/g, " ").trim().slice(0, maximum))
      .filter(Boolean);
  };
  const semanticMaterial = (element: Element): string => {
    const icon = element.querySelector("svg,[icon],[name],[data-lucide]");
    return [
      ...accessibleLabelSources(element, 320),
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
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 320);
  };
  const rowOf = (element: Element): Element | null => element.closest(semanticPolicy.rowSelector);
  const contextRootOf = (row: Element): Element | null => {
    const table = row.closest(semanticPolicy.tableSelector);
    if (table) return table;
    let root = row.parentElement;
    for (let depth = 0; root && depth < 5; depth += 1, root = root.parentElement) {
      if (root.querySelector(semanticPolicy.headerRowSelector)) return root;
    }
    return null;
  };
  const rowContextOf = (element: Element): string => (
    rowOf(element)?.textContent || element.closest(semanticPolicy.contextSelector)?.textContent || ""
  ).replace(/\s+/g, " ").trim().slice(0, 500);
  const columnContextOf = (element: Element): string => {
    const cell = element.closest(semanticPolicy.cellSelector);
    const row = rowOf(element);
    const table = row ? contextRootOf(row) : null;
    if (!cell || !row || !table) return "";
    const cells = Array.from(row.querySelectorAll(semanticPolicy.cellSelector));
    const index = cells.indexOf(cell);
    if (index < 0) return "";
    const headerRows = Array.from(table.querySelectorAll(semanticPolicy.headerRowSelector)).slice(0, 5);
    for (const headerRow of headerRows) {
      const headers = Array.from(headerRow.querySelectorAll(semanticPolicy.headerCellSelector));
      const text = headers[index]?.textContent?.replace(/\s+/g, " ").trim().slice(0, 120);
      if (text) return text;
    }
    return "";
  };
  const tableContextOf = (element: Element): string => (
    Array.from((rowOf(element) ? contextRootOf(rowOf(element)!) : element.closest(semanticPolicy.tableSelector))
      ?.querySelectorAll(semanticPolicy.headerRowSelector) || [])
      .slice(0, 20)
      .flatMap((row) => Array.from(row.querySelectorAll(semanticPolicy.headerCellSelector)))
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
    const label = accessibleLabelSources(element, 120).join(" ");
    return Boolean(label && invoiceSection.test(label) && !unsafeLabel.test(label));
  });
  let semanticNavigationSteps = 0;
  // The navigation pattern is anchored, so each label source is matched on its
  // own. Joining them turns an accessible name plus its visible text into one
  // string that no anchored pattern can ever match.
  const semanticNavigationLabelsOf = (element: Element): string[] => accessibleLabelSources(element, 120);
  const structuralNavigationMaterialOf = (element: Element): string => [
    element.getAttribute("data-test"),
    element.getAttribute("data-testid"),
    element.getAttribute("id"),
    element.getAttribute("class"),
    element.getAttribute("name"),
    element.getAttribute("aria-controls"),
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 320);
  const safeNavigationHref = (element: HTMLElement): boolean => {
    const raw = element.getAttribute("href");
    if (!raw) return true;
    try {
      const url = new URL(raw, location.href);
      return url.protocol === "https:" && url.origin === location.origin && !url.username && !url.password &&
        !unsafePath.test(url.pathname) && !unsafeSegment.test(url.pathname) && !directDocumentPath.test(url.pathname);
    } catch {
      return false;
    }
  };
  const semanticNavigationControl = (tier: RegExp, root: ParentNode = document): HTMLElement | undefined => Array.from(
    root.querySelectorAll<HTMLElement>('button,[role="button"],[role="menuitem"],[role="tab"],a'),
  ).find((element) => {
    const labels = semanticNavigationLabelsOf(element);
    return Boolean(
      labels.length && !labels.some((label) => unsafeLabel.test(label)) &&
      labels.some((label) => semanticNavigation.test(label) && tier.test(label)) && safeNavigationHref(element) &&
      !element.closest("form") && visible(element) &&
      !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true"
    );
  });
  const semanticMenuTriggers = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(
    'button,[role="button"],[aria-haspopup="menu"],[aria-haspopup="true"]',
  )).filter((element) => {
    const labels = semanticNavigationLabelsOf(element);
    const declaredMenu = element.getAttribute("aria-haspopup") === "menu" || element.getAttribute("aria-haspopup") === "true";
    const semanticTrigger = semanticNavigationTrigger.test(structuralNavigationMaterialOf(element));
    return (declaredMenu || semanticTrigger) && !labels.some((label) => unsafeLabel.test(label)) && !element.closest("form,[role=menu]") &&
      visible(element) && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
  }).sort((left, right) => {
    const score = (element: HTMLElement): number => {
      const material = structuralNavigationMaterialOf(element);
      return (semanticNavigationTrigger.test(material) ? 100 : 0) +
        (/(?:workspace|organization|company|team)/i.test(material) ? 50 : 0) +
        (element.closest('nav,header,[role="navigation"]') ? 20 : 0) +
        (element.hasAttribute("aria-controls") ? 5 : 0);
    };
    return score(right) - score(left);
  }).slice(0, 4);
  const settingsControlAfterMenu = (trigger: HTMLElement): HTMLElement | undefined => {
    const controlledId = trigger.getAttribute("aria-controls");
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    const roots = controlled && visible(controlled)
      ? [controlled]
      : Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).filter(visible);
    for (const root of roots.slice(0, 4)) {
      const settings = semanticNavigationControl(settingsNavigation, root);
      if (settings) return settings;
    }
    return undefined;
  };
  const billingSurfaceObserved = (): boolean => Boolean(
    document.querySelector(routePolicy.documentSelector) ||
    semanticControls().length ||
    semanticSections().length
  );
  const revealSemanticNavigation = async (
    mutationAttempted: () => boolean = () => false,
    runNavigationAction: (action: () => void) => void = (action) => action(),
  ): Promise<"complete" | "time_cap" | "action_cap"> => {
    if (billingSurfaceObserved()) return "complete";
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
    let settingsControl: HTMLElement | undefined;
    let triggers = semanticMenuTriggers();
    const triggerDeadline = Math.min(revealDeadline, Date.now() + semanticPolicy.navigationTriggerMountMs);
    while (!triggers.length && Date.now() < triggerDeadline) {
      if (billingSurfaceObserved()) return "complete";
      await new Promise((resolve) => setTimeout(resolve, 100));
      triggers = semanticMenuTriggers();
    }
    let inspectedTriggers = 0;
    for (const trigger of triggers) {
      if (Date.now() >= revealDeadline || semanticNavigationSteps >= 4) break;
      inspectedTriggers += 1;
      runNavigationAction(() => trigger.click());
      semanticNavigationSteps += 1;
      if (mutationAttempted()) return "complete";
      const menuDeadline = Math.min(revealDeadline, Date.now() + 600);
      let emptyMenuObservedAt: number | undefined;
      while (Date.now() < menuDeadline && !mutationAttempted() && !settingsControlAfterMenu(trigger)) {
        const visibleMenu = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).some(visible);
        if (visibleMenu) emptyMenuObservedAt ??= Date.now();
        if (emptyMenuObservedAt !== undefined && Date.now() - emptyMenuObservedAt >= 100) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (mutationAttempted()) return "complete";
      settingsControl = settingsControlAfterMenu(trigger);
      if (settingsControl) break;
      (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    if (settingsControl && semanticNavigationSteps < 6) {
      runNavigationAction(() => settingsControl.click());
      semanticNavigationSteps += 1;
      if (mutationAttempted()) return "complete";
      const billingDeadline = Math.min(revealDeadline, Date.now() + 1_500);
      let billingControl = semanticNavigationControl(billingNavigation);
      while (!billingControl && Date.now() < billingDeadline) {
        if (billingSurfaceObserved()) return "complete";
        await new Promise((resolve) => setTimeout(resolve, 100));
        billingControl = semanticNavigationControl(billingNavigation);
      }
      if (billingControl && semanticNavigationSteps < 6) {
        runNavigationAction(() => billingControl.click());
        semanticNavigationSteps += 1;
      }
    }
    if (billingSurfaceObserved()) return "complete";
    if (semanticNavigationSteps >= 6) return "action_cap";
    return Date.now() >= revealDeadline && (inspectedTriggers < triggers.length || Boolean(settingsControl))
      ? "time_cap"
      : "complete";
  };

  const withDiscoveryMutationGuard = async (
    operation: (
      mutationAttempted: () => boolean,
      runNavigationAction: (action: () => void) => void,
    ) => Promise<void>,
  ): Promise<boolean> => {
    let navigationMutationAttempts = 0;
    let navigationActionActive = false;
    const blocked = (): DOMException => {
      if (navigationActionActive) navigationMutationAttempts += 1;
      return new DOMException("pre-connect navigation attempted a mutating request", "SecurityError");
    };
    const runNavigationAction = (action: () => void): void => {
      navigationActionActive = true;
      try { action(); } finally { navigationActionActive = false; }
    };
    const readOnlyGraphqlBody = (body: unknown): boolean => {
      if (typeof body !== "string" || body.length > 65_536) return false;
      try {
        const value = JSON.parse(body) as Record<string, unknown>;
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        if (Object.keys(value).some((key) => !["query", "variables", "operationName"].includes(key))) return false;
        return typeof value.query === "string" && /^\s*query(?:\s|\{|$)/i.test(value.query) &&
          !/\b(?:mutation|subscription)\b/i.test(value.query);
      } catch {
        return false;
      }
    };
    const safeMethod = (method: string, body?: unknown): boolean => {
      const normalized = method.toUpperCase();
      return normalized === "GET" || normalized === "HEAD" ||
        (normalized === "POST" && readOnlyGraphqlBody(body));
    };
    const safeNavigation = (raw: string | URL | null | undefined): boolean => {
      if (raw === undefined || raw === null || raw === "") return true;
      try {
        const url = new URL(String(raw), location.href);
        return url.protocol === "https:" && url.origin === location.origin && !url.username && !url.password &&
          !unsafePath.test(url.pathname) && !unsafeSegment.test(url.pathname) && !directDocumentPath.test(url.pathname);
      } catch {
        return false;
      }
    };

    const originalFetch = window.fetch;
    const guardedFetch: typeof window.fetch = function(this: Window, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
      const method = init?.method ?? request?.method ?? "GET";
      const body = init?.body ?? (request && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD" ? undefined : null);
      if (!safeMethod(method, body)) return Promise.reject(blocked());
      return Reflect.apply(originalFetch, this, [input, init]) as Promise<Response>;
    };

    const xhr = typeof XMLHttpRequest === "undefined" ? undefined : XMLHttpRequest.prototype;
    const originalXhrOpen = xhr?.open;
    const originalXhrSend = xhr?.send;
    const xhrMethods = new WeakMap<XMLHttpRequest, string>();
    const guardedXhrOpen: typeof XMLHttpRequest.prototype.open = function(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async = true,
      username?: string | null,
      password?: string | null,
    ): void {
      xhrMethods.set(this, method);
      return Reflect.apply(originalXhrOpen!, this, [method, url, async, username, password]);
    } as typeof XMLHttpRequest.prototype.open;
    const guardedXhrSend: typeof XMLHttpRequest.prototype.send = function(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      if (!safeMethod(xhrMethods.get(this) ?? "GET", body)) throw blocked();
      return Reflect.apply(originalXhrSend!, this, [body]);
    };

    const pageNavigator = typeof navigator === "undefined" ? undefined : navigator;
    const originalBeacon = pageNavigator?.sendBeacon;
    const guardedBeacon: typeof navigator.sendBeacon = () => {
      blocked();
      return false;
    };
    const originalWindowOpen = window.open;
    const guardedWindowOpen: typeof window.open = () => {
      blocked();
      return null;
    };
    const form = typeof HTMLFormElement === "undefined" ? undefined : HTMLFormElement.prototype;
    const originalFormSubmit = form?.submit;
    const originalFormRequestSubmit = form?.requestSubmit;
    const guardedFormSubmit: typeof HTMLFormElement.prototype.submit = function(): void { throw blocked(); };
    const guardedFormRequestSubmit: typeof HTMLFormElement.prototype.requestSubmit = function(): void { throw blocked(); };
    const pageHistory = typeof history === "undefined" ? undefined : history;
    const originalPushState = pageHistory?.pushState;
    const originalReplaceState = pageHistory?.replaceState;
    const guardedPushState: typeof history.pushState = function(this: History, data, unused, url) {
      if (!safeNavigation(url)) throw blocked();
      return Reflect.apply(originalPushState!, this, [data, unused, url]) as void;
    };
    const guardedReplaceState: typeof history.replaceState = function(this: History, data, unused, url) {
      if (!safeNavigation(url)) throw blocked();
      return Reflect.apply(originalReplaceState!, this, [data, unused, url]) as void;
    };
    const pageNavigation = (window as Window & { navigation?: EventTarget }).navigation;
    const preventUnsafeNavigation: EventListener = (rawEvent) => {
      const event = rawEvent as Event & { destination?: { url?: string } };
      if (safeNavigation(event.destination?.url)) return;
      blocked();
      if (rawEvent.cancelable) rawEvent.preventDefault();
    };

    window.fetch = guardedFetch;
    window.open = guardedWindowOpen;
    if (xhr && originalXhrOpen && originalXhrSend) {
      xhr.open = guardedXhrOpen;
      xhr.send = guardedXhrSend;
    }
    if (pageNavigator && originalBeacon) pageNavigator.sendBeacon = guardedBeacon;
    if (form && originalFormSubmit && originalFormRequestSubmit) {
      form.submit = guardedFormSubmit;
      form.requestSubmit = guardedFormRequestSubmit;
    }
    if (pageHistory && originalPushState && originalReplaceState) {
      pageHistory.pushState = guardedPushState;
      pageHistory.replaceState = guardedReplaceState;
    }
    pageNavigation?.addEventListener("navigate", preventUnsafeNavigation);
    try {
      await operation(() => navigationMutationAttempts > 0, runNavigationAction);
    } catch (error) {
      if (navigationMutationAttempts === 0) throw error;
    } finally {
      if (window.fetch === guardedFetch) window.fetch = originalFetch;
      if (window.open === guardedWindowOpen) window.open = originalWindowOpen;
      if (xhr?.open === guardedXhrOpen) xhr.open = originalXhrOpen!;
      if (xhr?.send === guardedXhrSend) xhr.send = originalXhrSend!;
      if (pageNavigator?.sendBeacon === guardedBeacon) pageNavigator.sendBeacon = originalBeacon!;
      if (form?.submit === guardedFormSubmit) form.submit = originalFormSubmit!;
      if (form?.requestSubmit === guardedFormRequestSubmit) form.requestSubmit = originalFormRequestSubmit!;
      if (pageHistory?.pushState === guardedPushState) pageHistory.pushState = originalPushState!;
      if (pageHistory?.replaceState === guardedReplaceState) pageHistory.replaceState = originalReplaceState!;
      pageNavigation?.removeEventListener("navigate", preventUnsafeNavigation);
    }
    return navigationMutationAttempts > 0;
  };

  let observedSnapshot: CapturedEntry[] = [];
  let observedHighSignal = false;
  const snapshotNavigationRoutes = async (): Promise<string[]> => {
    try {
      const pageObserver = (window as Window & {
        __ratatoskDiscoveryObserverV1?: { snapshotRoutes?: () => Promise<string[]> };
      }).__ratatoskDiscoveryObserverV1;
      if (typeof pageObserver?.snapshotRoutes !== "function") return [];
      const routes = await Promise.race([
        Promise.resolve(pageObserver.snapshotRoutes()),
        new Promise<string[]>((resolve) => setTimeout(() => resolve([]), Math.min(500, Math.max(50, deadline - Date.now())))),
      ]);
      return Array.isArray(routes) ? routes.filter((route) => typeof route === "string").slice(0, 80) : [];
    } catch {
      return [];
    }
  };
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
  const navigationRoutesBeforeReveal = await snapshotNavigationRoutes();
  let semanticNavigationStatus: NonNullable<PageEvidence["stats"]["semanticNavigationStatus"]> =
    topLevelFrame && options.allowSemanticNavigation !== false ? "complete" : "disabled";
  if (semanticNavigationStatus !== "disabled") {
    let revealStatus: "complete" | "time_cap" | "action_cap" = "complete";
    const mutationBlocked = await withDiscoveryMutationGuard(async (mutationAttempted, runNavigationAction) => {
      revealStatus = await revealSemanticNavigation(mutationAttempted, runNavigationAction);
      if (!mutationAttempted()) await waitForObservedEvidenceQuiescence();
    });
    semanticNavigationStatus = mutationBlocked ? "mutation_blocked" : revealStatus;
  } else {
    await waitForObservedEvidenceQuiescence();
  }
  const navigationRoutesAfterReveal = await snapshotNavigationRoutes();
  const routesBeforeReveal = new Set(navigationRoutesBeforeReveal);
  const observedNavigationRoutes = navigationRoutesAfterReveal.filter((route) => !routesBeforeReveal.has(route));

  const usefulEvidencePresent = () => Boolean(
    document.querySelector(routePolicy.documentSelector) ||
    document.querySelector('script[type="application/json"],script[type="application/ld+json"]') ||
    semanticControls().length ||
    semanticSections().length,
  );
  const durableEvidencePresent = () => Boolean(
    document.querySelector(routePolicy.documentSelector) || observedHighSignal,
  );
  if (!durableEvidencePresent() && options.settleMs > 0 && Date.now() < deadline) {
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
      const timer = setTimeout(finish, Math.max(0, Math.min(5_000, options.settleMs, deadline - Date.now())));
      considerEvidence();
    });
  }
  if (
    topLevelFrame && options.allowScroll !== false && !usefulEvidencePresent() && options.settleMs > 0 && Date.now() < deadline &&
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
      const timer = setTimeout(finish, Math.max(0, Math.min(2_000, Math.ceil(options.settleMs / 2), deadline - Date.now())));
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

  const navigationUrls = new Map<string, ExplorationLinkEvidence>();
  const safeObservedNavigationRoute = (raw: string): string | undefined => {
    if (raw.length > 2_048) return undefined;
    try {
      const url = new URL(raw, location.href);
      if (
        url.protocol !== "https:" || url.origin !== location.origin || url.username || url.password ||
        unsafePath.test(url.pathname) || unsafeSegment.test(url.pathname) || directDocumentPath.test(url.pathname) ||
        url.pathname.length > 320
      ) return undefined;
      for (const [key, value] of [...url.searchParams.entries()]) {
        if (!/^(?:page|p|offset|start|per_page|limit)$/i.test(key) || !/^\d{1,6}$/.test(value)) {
          url.searchParams.delete(key);
        }
      }
      url.searchParams.sort();
      url.hash = "";
      return url.toString();
    } catch {
      return undefined;
    }
  };
  const keepNavigationRoute = (
    raw: string,
    hintSource: "resource_timing" | "observed_request" | "structured_data",
    context = "",
  ): void => {
    if (navigationUrls.size >= 80 || raw.length > 2_048) return;
    try {
      const url = new URL(raw, location.href);
      if (
        url.protocol !== "https:" || url.origin !== location.origin || url.username || url.password ||
        unsafePath.test(url.pathname) || unsafeSegment.test(url.pathname) || directDocumentPath.test(url.pathname) ||
        url.pathname.length > 320
      ) return;
      if (
        hintSource !== "structured_data" &&
        !billingPath.test(`${url.pathname}${url.search}`) &&
        !bridgePath.test(`${url.pathname}${url.search}`)
      ) return;
      for (const [key, value] of [...url.searchParams.entries()]) {
        if (!/^(?:page|p|offset|start|per_page|limit)$/i.test(key) || !/^\d{1,6}$/.test(value)) {
          url.searchParams.delete(key);
        }
      }
      url.searchParams.sort();
      url.hash = "";
      const value = url.toString();
      if (!navigationUrls.has(value)) {
        navigationUrls.set(value, { url: value, hintSource, ...(context ? { context } : {}) });
      }
    } catch {
      // Malformed inert evidence is not a route hint.
    }
  };
  for (const raw of observedNavigationRoutes) {
    const url = safeObservedNavigationRoute(raw);
    if (!url || navigationUrls.size >= 80) continue;
    navigationUrls.set(url, { url, hintSource: "semantic_navigation" });
  }
  for (const url of urls) keepNavigationRoute(url, "resource_timing");
  for (const resource of resources) {
    if (resource.source === "observed" && interesting.test(resource.url)) {
      keepNavigationRoute(resource.url, "observed_request");
    }
  }
  const structuredRouteKey = /(?:invoice|receipt|statement|billing|document|download|pdf|url|href|route)/i;
  for (const script of Array.from(document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]')).slice(0, 20)) {
    const text = script.textContent ?? "";
    if (!text || text.length > 256_000) continue;
    let root: unknown;
    try { root = JSON.parse(text); } catch { continue; }
    const pending: Array<{ value: unknown; path: string; depth: number; typed: boolean }> = [
      { value: root, path: "", depth: 0, typed: false },
    ];
    let visited = 0;
    while (pending.length && visited < 2_000 && navigationUrls.size < 80) {
      const node = pending.shift()!;
      visited += 1;
      if (node.depth > 8) continue;
      if (typeof node.value === "string") {
        if ((node.typed || structuredRouteKey.test(node.path)) && node.value.length <= 2_048) {
          keepNavigationRoute(node.value, "structured_data", "invoice route");
        }
        continue;
      }
      if (Array.isArray(node.value)) {
        for (const item of node.value.slice(0, 200)) {
          pending.push({ value: item, path: node.path, depth: node.depth + 1, typed: node.typed });
        }
        continue;
      }
      if (!node.value || typeof node.value !== "object") continue;
      const record = node.value as Record<string, unknown>;
      const typed = node.typed || (typeof record["@type"] === "string" && structuredRouteKey.test(record["@type"]));
      for (const [key, value] of Object.entries(record).slice(0, 200)) {
        pending.push({
          value,
          path: `${node.path}.${key}`.slice(-320),
          depth: node.depth + 1,
          typed,
        });
      }
    }
  }
  const routeElements = document.querySelectorAll(
    "a[href],area[href],[role=link][href],[data-href],[data-url],[data-route],[routerlink],[ng-reflect-router-link]",
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
        const label = accessibleLabelSources(element, 160)[0] ?? "";
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
            hintSource: current?.hintSource ?? "dom_link",
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
      semanticNavigationStatus,
      evidenceDropped: 0,
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
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      __ratatoskProbeError: name === "SecurityError"
        ? "mutation_guard"
        : name === "TypeError" ? "type_error"
          : name === "RangeError" ? "range_error" : "page_exception",
    };
  }
}

export class DiscoveryPageObserverRegistration {
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
        allFrames: true,
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
        target: { tabId, allFrames: true },
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
        target: { tabId, allFrames: true },
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
      this.tabId!,
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
    probeCause?: DiscoveryProbeCause;
    replay?: ReplayTrace;
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
      ...(details.probeCause ? { probeCause: details.probeCause } : {}),
      ...(details.replay ? { replay: details.replay } : {}),
      durationMs: Math.min(60_000, Math.max(0, Math.trunc(durationMs))),
      ...(details.evidence ? { evidence: details.evidence } : {}),
      ...(details.admission?.length ? { admission: details.admission } : {}),
    });
  }
  const replayFailure = details.replay?.firstFailure;
  console.info(`[collector] discovery page ${page}/${diagnostic.limits.pages} (${source} ${toDiagnosticRoute(details.route)})${adapter ? ` ${adapter}` : ""} -> ${result}${details.probeCause ? `/${details.probeCause}` : ""}${replayFailure ? `@${replayFailure.phase}/${replayFailure.result}` : ""} (${Math.trunc(durationMs)}ms)`);
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
    semanticNavigationStatus: evidence.stats.semanticNavigationStatus,
    evidenceDropped: evidence.stats.evidenceDropped ?? 0,
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

function candidateReplayPlanKind(candidate: Candidate): ReplayPlanKind {
  if (candidate.adapterId === "network-json") return "network";
  if (candidate.adapterId === "embedded-json") return "embedded";
  return replayPlanKindForRecipe(candidate.recipe);
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
  const renderedHtml = withoutRawTextElements(html);
  const invoiceContext = /invoice|receipt|billing|statement|transaction|faktura|kvitto|rechnung|beleg|facture|reçu|factura|recibo|fattura|ricevuta/i;
  // The route is a search hypothesis. A guessed /invoices path must never make
  // a site-wide "Download" link look like invoice evidence, so page context
  // comes only from independently rendered title and heading text.
  const headings = [...renderedHtml.matchAll(/<(?:h1|h2|h3|caption)\b[^>]*>([\s\S]{0,400}?)<\/(?:h1|h2|h3|caption)>/gi)]
    .slice(0, 12)
    .map((match) => match[1].replace(/<[^>]*>/g, " "))
    .join(" ")
    .slice(0, 2_000);
  const pageHasInvoiceContext = invoiceContext.test(`${pageTitle ?? ""} ${headings}`);
  for (const match of renderedHtml.matchAll(/<a\b([^>]*)>/gi)) {
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
        /(?:^|\/)pdf(?:\/|$)/i.test(path) ||
        providerDocument;
      const knownInvoiceDocument = url.hostname === "invoice.stripe.com" && /^\/i\/[^/]+\/[^/]+$/.test(path);
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

/** Remove script/style regions before structural link inference. This output is
 * never rendered; a scanner is used because regex-based HTML filtering misses
 * legal whitespace and quoted `>` characters in raw-text element tags. */
function withoutRawTextElements(html: string): string {
  const lower = html.toLowerCase();
  let cursor = 0;
  let rendered = "";
  while (cursor < html.length) {
    const script = rawTextTagStart(lower, "script", cursor);
    const style = rawTextTagStart(lower, "style", cursor);
    const start = script < 0 ? style : style < 0 ? script : Math.min(script, style);
    if (start < 0) return rendered + html.slice(cursor);
    rendered += html.slice(cursor, start);
    const tag = start === script ? "script" : "style";
    const openEnd = htmlTagEnd(html, start + tag.length + 1);
    if (openEnd < 0) return rendered;
    const close = rawTextTagStart(lower, `/${tag}`, openEnd + 1);
    if (close < 0) return rendered;
    const closeEnd = htmlTagEnd(html, close + tag.length + 2);
    if (closeEnd < 0) return rendered;
    cursor = closeEnd + 1;
  }
  return rendered;
}

function rawTextTagStart(lowerHtml: string, tag: string, from: number): number {
  const needle = `<${tag}`;
  let index = from;
  while ((index = lowerHtml.indexOf(needle, index)) >= 0) {
    const boundary = lowerHtml[index + needle.length];
    if (boundary === undefined || boundary === ">" || boundary === "/" || /\s/.test(boundary)) return index;
    index += needle.length;
  }
  return -1;
}

function htmlTagEnd(html: string, from: number): number {
  let quote = "";
  for (let index = from; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function directDomRecipe(
  origin: string,
  authEntryUrl: string,
  openUrl: string,
  displayName: string,
  links: string[],
  config?: VendorRecipe["config"],
): VendorRecipe | undefined {
  try {
    const hosts = new Set([exactOriginPattern(origin)]);
    for (const href of links) {
      const url = normalizedDocumentUrl(new URL(href, openUrl));
      if (url.protocol === "https:") {
        hosts.add(exactOriginPattern(url.origin));
        if (documentProviderForUrl(url)?.id === "stripe") {
          for (const host of STRIPE_KNOWN_DOCUMENT_HOSTS) hosts.add(host);
        }
      }
    }
    for (const option of config ?? []) {
      hosts.add(exactOriginPattern(new URL(option.discover.request.url).origin));
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
        check: { request: { url: authProbeUrl(authEntryUrl) }, expect: { statusIn: [200] } },
        loginUrl: origin,
      },
      invoices: {
        strategy: "dom",
        list: {
          open: openUrl,
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
      ...(config?.length ? { config } : {}),
    });
  } catch {
    return undefined;
  }
}

function semanticDomRecipe(
  origin: string,
  authEntryUrl: string,
  openUrl: string,
  displayName: string,
  observedCrossOriginHosts: readonly string[],
  config?: VendorRecipe["config"],
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
        check: { request: { url: authProbeUrl(authEntryUrl) }, expect: { statusIn: [200] } },
        loginUrl: origin,
      },
      invoices: {
        strategy: "dom",
        list: {
          open: openUrl,
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
      ...(config?.length ? { config } : {}),
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

/**
 * A DOM candidate must reopen its proved page. Ordinary routes are persisted
 * unchanged; one opaque tenant segment may become a template only when this
 * same evidence set exposes that exact value from a typed first-party scope.
 */
function replayableDomOpen(
  requestedUrl: string,
  evidence: PageEvidence,
): { url: string; config?: VendorRecipe["config"] } | null {
  let requested: URL;
  try { requested = new URL(requestedUrl); } catch { return null; }
  if (requested.origin !== evidence.origin || requested.search || requested.hash) return null;
  try {
    if (safeEntryUrl(requested.toString()) === requested.toString()) return { url: requested.toString() };
  } catch {
    return null;
  }
  const segments = requested.pathname.split("/").filter(Boolean);
  const tenantIndexes = segments.flatMap((segment, index) => {
    try { return isBoundedTenantIdentifierSegment(decodeURIComponent(segment)) ? [index] : []; } catch { return []; }
  });
  if (tenantIndexes.length !== 1) return null;
  const tenantIndex = tenantIndexes[0];
  let tenant: string;
  try { tenant = decodeURIComponent(segments[tenantIndex]); } catch { return null; }
  const allowedResourceOrigins = new Set([
    evidence.origin,
    ...evidence.crossOriginHosts.map((host) => `https://${host}`),
  ]);
  for (const resource of evidence.resources) {
    let source: URL;
    try { source = new URL(resource.url); } catch { continue; }
    if (!allowedResourceOrigins.has(source.origin) || source.hash || source.toString().includes("REDACTED")) continue;
    let sourceMaterial: string;
    try { sourceMaterial = decodeURIComponent(`${source.pathname}${source.search}`); } catch { continue; }
    if (sourceMaterial.includes(tenant)) continue;
    const method = resource.method ?? "GET";
    let request: RequestSpec;
    if (method === "GET") {
      if (resource.requestBody || (resource.requestHeaders && Object.keys(resource.requestHeaders).length > 0)) continue;
      request = { url: source.toString() };
    } else {
      request = {
        url: source.toString(),
        method: "POST",
        ...(resource.requestHeaders ? { headers: resource.requestHeaders } : {}),
        ...(resource.requestBody ? { body: resource.requestBody } : {}),
      };
      if (!isSafeReadOnlyGraphqlRequest(request) || request.body?.includes(tenant)) continue;
    }
    let binding: { id: string; path: string } | undefined;
    try { binding = findTypedTenantBinding(JSON.parse(resource.body), tenant); } catch { continue; }
    if (!binding) continue;
    const template = new URL(requested.toString());
    const templateSegments = [...segments];
    templateSegments[tenantIndex] = `{${binding.id}}`;
    template.pathname = `/${templateSegments.join("/")}`;
    const openUrl = decodeURIComponent(template.toString());
    return {
      url: openUrl,
      config: [{
        id: binding.id,
        discover: { request, value: binding.path },
      }],
    };
  }
  return null;
}

function findTypedTenantBinding(value: unknown, expected: string): { id: string; path: string } | undefined {
  const pending: Array<{ value: unknown; path: string; parentKey?: string; depth: number }> = [
    { value, path: "", depth: 0 },
  ];
  let visited = 0;
  while (pending.length && visited < 2_000) {
    const current = pending.shift()!;
    visited += 1;
    if (current.depth > 8 || !current.value || typeof current.value !== "object" || Array.isArray(current.value)) continue;
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>).slice(0, 200)) {
      const path = current.path ? `${current.path}.${key}` : key;
      const scopeId = typedTenantScopeId(key, current.parentKey);
      if (scopeId && (typeof child === "string" || typeof child === "number") && String(child) === expected) {
        return { id: scopeId, path };
      }
      pending.push({ value: child, path, parentKey: key, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function typedTenantScopeId(key: string, parentKey: string | undefined): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) return undefined;
  if (isTypedTenantScopeName(key)) return key;
  return key === "id" && parentKey && isTypedTenantScopeName(parentKey) ? parentKey : undefined;
}

function isTypedTenantScopeName(value: string): boolean {
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
  return /^(?:workspace|organization|org|team|project|tenant|account|customer)s?(?:_?id)?$/.test(normalized);
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
