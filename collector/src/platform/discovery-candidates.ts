import type { DiscoveredSupplierCandidateSetV1, DiscoveredSupplierProfileV1 } from "../../../src/core/discovery";
import type { OperationalOutcomeCode } from "../../../src/core/errors";
import type { VendorRunSummary } from "./collector";
import type { CandidateVerificationAttempt, CandidateVerificationResult } from "./discovery-diagnostic";

export type CandidateCollectionResult =
  | { kind: "success"; profile: DiscoveredSupplierProfileV1; summary: VendorRunSummary; attempted: number; outcomes: CandidateVerificationAttempt[] }
  | { kind: "exhausted"; summary?: VendorRunSummary; attempted: number; outcomes: CandidateVerificationAttempt[] }
  | { kind: "fatal"; summary: VendorRunSummary; attempted: number; outcomes: CandidateVerificationAttempt[] };

/**
 * Try proof-ranked candidates in order. Only recipe-local failures fall through;
 * authentication, rate limiting, permission/persistence, and destination errors
 * are supplier-wide and stop immediately.
 */
export async function collectFirstWorkingCandidate(
  set: DiscoveredSupplierCandidateSetV1,
  run: (profile: DiscoveredSupplierProfileV1, index: number) => Promise<VendorRunSummary>,
): Promise<CandidateCollectionResult> {
  let last: VendorRunSummary | undefined;
  const outcomes: CandidateVerificationAttempt[] = [];
  for (const [index, profile] of set.candidates.entries()) {
    const summary = await run(profile, index);
    last = summary;
    outcomes.push({
      candidate: index + 1,
      adapter: profile.adapter.id,
      result: verificationResult(summary),
      ...(summary.failure ? {
        failure: {
          stage: summary.failure.stage,
          cause: summary.failure.cause,
          ...(summary.failure.httpStatus !== undefined ? { httpStatus: summary.failure.httpStatus } : {}),
          ...(summary.failure.responseType ? { responseType: summary.failure.responseType } : {}),
        },
      } : {}),
      ...(summary.retrievalProof ? {
        retrieval: {
          termination: summary.retrievalProof.termination,
          pagesVisited: summary.retrievalProof.pagesVisited,
          observedItems: summary.retrievalProof.observedItems,
          resolvedItems: summary.retrievalProof.resolvedItems,
          unresolvedItems: summary.retrievalProof.unresolvedItems,
        },
      } : {}),
    });
    if (isProvenDelivery(summary)) {
      return { kind: "success", profile, summary, attempted: index + 1, outcomes };
    }
    if (!isCandidateLocalFailure(summary)) {
      return { kind: "fatal", summary, attempted: index + 1, outcomes };
    }
  }
  return { kind: "exhausted", summary: last, attempted: set.candidates.length, outcomes };
}

function verificationResult(summary: VendorRunSummary): CandidateVerificationResult {
  if (isProvenDelivery(summary)) return "collected";
  if (summary.code) return summary.code;
  if ((summary.status === "ok" || summary.status === "partial") && verifiedDocuments(summary) === 0) return "no_documents";
  return "unknown";
}

function isProvenDelivery(summary: VendorRunSummary): boolean {
  return (summary.status === "ok" || summary.status === "partial") && verifiedDocuments(summary) > 0 &&
    summary.retrieval !== "partial" && summary.code !== "retrieval_incomplete";
}

function isCandidateLocalFailure(summary: VendorRunSummary): boolean {
  if (summary.status === "auth_expired" || summary.status === "rate_limited" || summary.status === "skipped") return false;
  if (summary.code && !candidateLocalCode(summary.code)) return false;
  if ((summary.status === "ok" || summary.status === "partial") && verifiedDocuments(summary) === 0) return true;
  return candidateLocalCode(summary.code);
}

function verifiedDocuments(summary: VendorRunSummary): number {
  return summary.verifiedCount ?? summary.count;
}

function candidateLocalCode(code: OperationalOutcomeCode | undefined): boolean {
  // Known supplier-wide failures are typed before they reach this boundary.
  // An unclassified failure belongs to the candidate that produced it; letting
  // it abort the whole set defeats the proof-ranked fallbacks retained during
  // discovery and was the reason a GitHub page-fetch failure stopped at 1/3.
  return code === undefined || code === "document_invalid" || code === "retrieval_incomplete" || code === "recipe_incompatible" || code === "unknown";
}
