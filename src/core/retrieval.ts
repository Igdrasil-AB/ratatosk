import type {
  InvoiceListResult,
  InvoiceRef,
  RetrievalProof,
  RetrievalTermination,
} from "./types";

const COMPLETE_TERMINATIONS = new Set<RetrievalTermination>(["explicit_end", "stable_end"]);

export interface RetrievalMetrics {
  termination: RetrievalTermination;
  pagesVisited: number;
  observedItems: number;
  resolvedItems: number;
  unresolvedItems: number;
}

/** Build a closed, bounded traversal proof. Counts describe retrieval
 * opportunities, not an assumed minimum number of invoices. */
export function createRetrievalProof(metrics: RetrievalMetrics): RetrievalProof {
  // Validate the source metrics before diagnostic capping. Otherwise a missing
  // item (10,001 observed / 10,000 resolved) can disappear when both displayed
  // values clamp to 10,000 and incorrectly admit a partial traversal.
  const sourceCountsValid = [metrics.observedItems, metrics.resolvedItems, metrics.unresolvedItems]
    .every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000);
  const sourceCountsConsistent = sourceCountsValid &&
    metrics.resolvedItems + metrics.unresolvedItems === metrics.observedItems;
  const pagesVisited = boundedCount(metrics.pagesVisited, 1, 100);
  const observedItems = boundedCount(metrics.observedItems, 0, 10_000);
  const requestedResolvedItems = boundedCount(metrics.resolvedItems, 0, 10_000);
  const requestedUnresolvedItems = boundedCount(metrics.unresolvedItems, 0, 10_000);
  // A proof must be internally consistent before it can admit a discovered
  // supplier. Clamp impossible counts for diagnostics and count every omitted
  // observed opportunity as unresolved rather than claiming a complete run.
  const countsContradict = !sourceCountsConsistent || requestedResolvedItems > observedItems ||
    requestedUnresolvedItems > observedItems ||
    requestedResolvedItems + requestedUnresolvedItems > observedItems;
  // Contradictory input cannot support any positive resolution claim. Preserve
  // a coherent partition for diagnostics by treating every bounded observation
  // as unresolved; completeness remains partial even when observed is zero.
  const resolvedItems = countsContradict ? 0 : requestedResolvedItems;
  const unresolvedItems = countsContradict ? observedItems : requestedUnresolvedItems;
  return {
    completeness: COMPLETE_TERMINATIONS.has(metrics.termination) && !countsContradict && unresolvedItems === 0
      ? "complete"
      : "partial",
    termination: metrics.termination,
    pagesVisited,
    observedItems,
    resolvedItems,
    unresolvedItems,
  };
}

export function createInvoiceListResult(
  refs: InvoiceRef[],
  metrics: RetrievalMetrics,
): InvoiceListResult {
  return { refs, retrieval: createRetrievalProof(metrics) };
}

function boundedCount(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
