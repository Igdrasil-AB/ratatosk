import type { DiscoveryAdapterId } from "../../../src/core/discovery";
import type { RetrievalProof } from "../../../src/core/types";
import {
  COLLECTION_FAILURE_CAUSES,
  COLLECTION_FAILURE_STAGES,
  COLLECTION_RESPONSE_TYPES,
  OPERATIONAL_OUTCOME_CODES,
  type CollectionFailureEvidence,
  type OperationalOutcomeCode,
} from "../../../src/core/errors";
import type { ExplorationFamily, ExplorationMode, ExplorationPageSource } from "./discovery-explorer";

export const DISCOVERY_DIAGNOSTIC_SCHEMA = "ratatosk.discovery-diagnostic.v10" as const;
const LEGACY_DISCOVERY_DIAGNOSTIC_SCHEMAS = new Set([
  "ratatosk.discovery-diagnostic.v4",
  "ratatosk.discovery-diagnostic.v5",
  "ratatosk.discovery-diagnostic.v6",
  "ratatosk.discovery-diagnostic.v7",
  "ratatosk.discovery-diagnostic.v8",
]);

export const CANDIDATE_ADMISSION_SIGNALS = [
  "structured_network",
  "embedded_invoice_data",
  "direct_document_link",
  "independent_invoice_context",
  "semantic_document_control",
] as const;
export type CandidateAdmissionSignal = typeof CANDIDATE_ADMISSION_SIGNALS[number];

export type DiscoveryAttemptResult =
  | "candidate_compiled"
  | "no_candidate"
  | "probe_failed"
  | "auth_failed"
  | "auth_expired"
  | "auth_blocked"
  | "auth_scope_denied"
  | "transport_failed"
  | "scope_failed"
  | "list_failed"
  | "too_many_documents"
  | "invalid_identity"
  | "invalid_document_path"
  | "unapproved_document_origin"
  | "no_documents"
  | "policy_rejected"
  | "route_not_replayable"
  | "limit_reached";

export type DiscoveryTermination = "page_cap" | "time_cap" | "queue_exhausted" | "coverage_incomplete" | "candidate_primary_found" | "candidate_set_complete";
export type CandidateVerificationResult = OperationalOutcomeCode | "no_documents" | "collected";

export interface CandidateVerificationAttempt {
  candidate: number;
  adapter: DiscoveryAdapterId;
  result: CandidateVerificationResult;
  failure?: Omit<CollectionFailureEvidence, "retrieval">;
  retrieval?: Omit<RetrievalProof, "completeness">;
  verifiedDocuments?: number;
}

const DIAGNOSTIC_ROUTE_WORD = /^(?:app|v|t|home|dashboard|manage|admin|account|accounts|organization|organizations|org|workspace|workspaces|team|teams|settings|preferences|billing|billings|invoice|invoices|receipt|receipts|payment|payments|subscription|subscriptions|statement|statements|transaction|transactions|history|plans|login)$/i;
const DIAGNOSTIC_ID = /^(?:\d{4,}|[0-9a-f]{12,}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|(?:inv|invoice|receipt|rcpt|team|workspace|account)[_-][a-z0-9_-]{4,})$/i;

/** Route-only support evidence. Queries, fragments, origins, and opaque values
 * are dropped; tenant/document identifiers become typed placeholders. */
export function toDiagnosticRoute(value: string): string {
  try {
    const url = new URL(value, "https://diagnostic.invalid/");
    const segments = url.pathname.split("/").filter(Boolean).slice(0, 12).map((raw) => {
      let segment: string;
      try { segment = decodeURIComponent(raw); } catch { return ":segment"; }
      if (DIAGNOSTIC_ROUTE_WORD.test(segment)) return segment.toLowerCase();
      return DIAGNOSTIC_ID.test(segment) ? ":id" : ":segment";
    });
    const route = `/${segments.join("/")}`;
    return route.length <= 160 ? route : "/:segment";
  } catch {
    return "/:segment";
  }
}

export interface DiscoveryAttemptEvidence {
  jsonResources: number;
  observedRequests: number;
  replayedRequests: number;
  documentLinks: number;
  structuredData: number;
  semanticControls: number;
  semanticControlsRejected?: number;
  semanticNavigationSteps?: number;
}

export interface DiscoveryDiagnosticV6 {
  schema: typeof DISCOVERY_DIAGNOSTIC_SCHEMA;
  site: string;
  runtime: { collectorVersion: string; discoveryEngine: number };
  limits: { pages: number; depth: number; durationMs: number };
  timing: { elapsedMs: number };
  pages: { attempted: number; linked: number; commonRoutes: number };
  evidence: {
    jsonResources: number;
    observedRequests: number;
    replayedRequests: number;
    documentLinks: number;
    structuredDataPages: number;
    crossOriginHosts: string[];
  };
  candidates: { compiled: number; previewed: number; retained: number };
  /** Structural coverage only: no URL, tenant, query, or response values. */
  coverage?: {
    mode: ExplorationMode;
    attemptedFamilies: ExplorationFamily[];
    exhaustedFamilies: ExplorationFamily[];
    unavailableFamilies: ExplorationFamily[];
    slicesCompleted: number;
  };
  attempts: Array<{
    page: number;
    source: ExplorationPageSource;
    route: string;
    resolvedRoute?: string;
    adapter?: DiscoveryAdapterId;
    result: DiscoveryAttemptResult;
    durationMs: number;
    evidence?: DiscoveryAttemptEvidence;
    admission?: CandidateAdmissionSignal[];
  }>;
  verification?: {
    attempted: number;
    outcomes: CandidateVerificationAttempt[];
  };
  termination: DiscoveryTermination;
  result: "not_found" | "limit_reached" | "candidates_found";
}

/** Internal source-compatibility alias for callers created before v6. */
export type DiscoveryDiagnosticV1 = DiscoveryDiagnosticV6;

export function parseDiscoveryDiagnostic(value: unknown): DiscoveryDiagnosticV6 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid discovery diagnostic");
  const raw = value as Partial<DiscoveryDiagnosticV6> & { schema?: unknown };
  if (
    raw.schema !== DISCOVERY_DIAGNOSTIC_SCHEMA && !LEGACY_DISCOVERY_DIAGNOSTIC_SCHEMAS.has(String(raw.schema)) ||
    typeof raw.site !== "string" || !isSafeHostname(raw.site)
  ) {
    throw new Error("invalid discovery diagnostic identity");
  }
  if (
    !raw.runtime || typeof raw.runtime.collectorVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.runtime.collectorVersion) ||
    !boundedInt(raw.runtime.discoveryEngine, 1, 100)
  ) throw new Error("invalid discovery diagnostic runtime");
  if (!raw.limits || !boundedInt(raw.limits.pages, 1, 80) || !boundedInt(raw.limits.depth, 0, 5) || !boundedInt(raw.limits.durationMs, 1_000, 300_000)) {
    throw new Error("invalid discovery diagnostic limits");
  }
  if (!raw.timing || !boundedInt(raw.timing.elapsedMs, 0, 300_000)) throw new Error("invalid discovery diagnostic timing");
  if (!raw.pages || !boundedInt(raw.pages.attempted, 0, 80) || !boundedInt(raw.pages.linked, 0, 80) || !boundedInt(raw.pages.commonRoutes, 0, 80)) {
    throw new Error("invalid discovery diagnostic page counts");
  }
  if (
    raw.pages.attempted > raw.limits.pages ||
    raw.pages.linked + raw.pages.commonRoutes > raw.pages.attempted
  ) throw new Error("inconsistent discovery diagnostic page counts");
  if (
    !raw.evidence || !boundedInt(raw.evidence.jsonResources, 0, 1_000) ||
    !boundedOptionalInt(raw.evidence.observedRequests, 0, 1_000) ||
    !boundedOptionalInt(raw.evidence.replayedRequests, 0, 1_000) ||
    !boundedInt(raw.evidence.documentLinks, 0, 20_000) || !boundedInt(raw.evidence.structuredDataPages, 0, 20)
  ) {
    throw new Error("invalid discovery diagnostic evidence counts");
  }
  const crossOriginHosts = Array.isArray(raw.evidence.crossOriginHosts)
    ? [...new Set(raw.evidence.crossOriginHosts.filter((host): host is string => typeof host === "string" && isSafeHostname(host)))].slice(0, 8)
    : [];
  if (
    !raw.candidates || !boundedInt(raw.candidates.compiled, 0, 100) ||
    !boundedInt(raw.candidates.previewed, 0, 100) || !boundedInt(raw.candidates.retained, 0, 3)
  ) {
    throw new Error("invalid discovery diagnostic candidate counts");
  }
  if (
    raw.candidates.previewed > raw.candidates.compiled ||
    raw.candidates.retained > raw.candidates.compiled
  ) throw new Error("inconsistent discovery diagnostic candidate counts");
  const result = raw.result === "limit_reached" || raw.result === "not_found" || raw.result === "candidates_found"
    ? raw.result
    : undefined;
  const termination = isTermination(raw.termination) ? raw.termination : undefined;
  if (!result || !termination || !Array.isArray(raw.attempts) || raw.attempts.length > 80) {
    throw new Error("invalid discovery diagnostic attempts");
  }
  if (
    (result === "candidates_found") !== (termination === "candidate_set_complete" || termination === "candidate_primary_found") ||
    (result === "candidates_found") !== (raw.candidates.retained > 0) ||
    (result === "not_found") !== (termination === "queue_exhausted")
  ) throw new Error("inconsistent discovery termination");
  const currentSchema = raw.schema === DISCOVERY_DIAGNOSTIC_SCHEMA;
  const attempts = raw.attempts.map((attempt) => {
    if (
      !attempt || !boundedInt(attempt.page, 1, raw.limits!.pages) || !isPageSource(attempt.source) || !isAttemptResult(attempt.result) ||
      !isSafeRouteTemplate(attempt.route) ||
      (attempt.resolvedRoute !== undefined && !isSafeRouteTemplate(attempt.resolvedRoute)) ||
      !boundedInt(attempt.durationMs, 0, 60_000)
    ) throw new Error("invalid discovery diagnostic attempt");
    if (attempt.adapter !== undefined && !["network-json", "embedded-json", "dom-links", "dom-actions"].includes(attempt.adapter)) {
      throw new Error("invalid discovery diagnostic adapter");
    }
    const evidence = attempt.evidence === undefined ? undefined : parseAttemptEvidence(attempt.evidence);
    const admission = attempt.admission === undefined ? undefined : parseAdmissionSignals(attempt.admission);
    if (currentSchema && attempt.result === "candidate_compiled" && !admission?.length) {
      throw new Error("missing candidate admission evidence");
    }
    return {
      page: attempt.page,
      source: attempt.source,
      route: attempt.route,
      resolvedRoute: attempt.resolvedRoute,
      adapter: attempt.adapter,
      result: attempt.result,
      durationMs: attempt.durationMs,
      ...(evidence ? { evidence } : {}),
      ...(admission?.length ? { admission } : {}),
    };
  });
  if (attempts.some((attempt) => attempt.page > raw.pages!.attempted)) {
    throw new Error("discovery diagnostic attempt exceeds attempted pages");
  }
  const verification = parseVerification(raw.verification, raw.candidates.retained, result, currentSchema);
  const coverage = parseCoverage(raw.coverage);
  return {
    schema: DISCOVERY_DIAGNOSTIC_SCHEMA,
    site: raw.site,
    runtime: { collectorVersion: raw.runtime.collectorVersion, discoveryEngine: raw.runtime.discoveryEngine },
    limits: { pages: raw.limits.pages, depth: raw.limits.depth, durationMs: raw.limits.durationMs },
    timing: { elapsedMs: raw.timing.elapsedMs },
    pages: { attempted: raw.pages.attempted, linked: raw.pages.linked, commonRoutes: raw.pages.commonRoutes },
    evidence: {
      jsonResources: raw.evidence.jsonResources,
      observedRequests: raw.evidence.observedRequests ?? 0,
      replayedRequests: raw.evidence.replayedRequests ?? 0,
      documentLinks: raw.evidence.documentLinks,
      structuredDataPages: raw.evidence.structuredDataPages,
      crossOriginHosts,
    },
    candidates: {
      compiled: raw.candidates.compiled,
      previewed: raw.candidates.previewed,
      retained: raw.candidates.retained,
    },
    ...(coverage ? { coverage } : {}),
    attempts,
    ...(verification ? { verification } : {}),
    termination,
    result,
  };
}

function parseCoverage(value: DiscoveryDiagnosticV6["coverage"] | undefined): DiscoveryDiagnosticV6["coverage"] | undefined {
  if (value === undefined) return undefined;
  if (!value || (value.mode !== "fast" && value.mode !== "deep" && value.mode !== "self_heal") ||
    !Array.isArray(value.attemptedFamilies) || !Array.isArray(value.exhaustedFamilies) ||
    (value.unavailableFamilies !== undefined && !Array.isArray(value.unavailableFamilies)) ||
    !boundedInt(value.slicesCompleted, 0, 5)) {
    throw new Error("invalid discovery coverage");
  }
  const attemptedFamilies = parseFamilies(value.attemptedFamilies);
  const exhaustedFamilies = parseFamilies(value.exhaustedFamilies);
  const unavailableFamilies = parseFamilies(value.unavailableFamilies ?? []);
  if (attemptedFamilies.length !== value.attemptedFamilies.length || exhaustedFamilies.length !== value.exhaustedFamilies.length ||
    unavailableFamilies.length !== (value.unavailableFamilies?.length ?? 0) ||
    exhaustedFamilies.some((family) => !attemptedFamilies.includes(family)) ||
    unavailableFamilies.some((family) => attemptedFamilies.includes(family) || exhaustedFamilies.includes(family))) {
    throw new Error("invalid discovery coverage families");
  }
  return { mode: value.mode, attemptedFamilies, exhaustedFamilies, unavailableFamilies, slicesCompleted: value.slicesCompleted };
}

function parseFamilies(value: readonly unknown[]): ExplorationFamily[] {
  const safe: ExplorationFamily[] = [];
  for (const item of value) {
    if ((
      item === "exact_entry" || item === "observed_navigation" || item === "tenant_contextual_route" || item === "common_billing_route" ||
      item === "observed_network" || item === "embedded_data" || item === "document_provider" || item === "semantic_download"
    ) && !safe.includes(item)) safe.push(item);
  }
  return safe;
}

export function withCandidateVerification(
  diagnostic: DiscoveryDiagnosticV6,
  outcomes: readonly CandidateVerificationAttempt[],
): DiscoveryDiagnosticV6 {
  return parseDiscoveryDiagnostic({
    ...diagnostic,
    verification: { attempted: outcomes.length, outcomes },
  });
}

function parseVerification(
  value: DiscoveryDiagnosticV6["verification"] | undefined,
  retained: number,
  result: DiscoveryDiagnosticV6["result"],
  requireVerifiedDocumentCount: boolean,
): DiscoveryDiagnosticV6["verification"] | undefined {
  if (value === undefined) return undefined;
  if (result !== "candidates_found" || !boundedInt(value.attempted, 1, retained) || !Array.isArray(value.outcomes) || value.outcomes.length !== value.attempted) {
    throw new Error("invalid discovery verification");
  }
  const outcomes = value.outcomes.map((outcome, index) => {
    if (
      !outcome || outcome.candidate !== index + 1 ||
      !["network-json", "embedded-json", "dom-links", "dom-actions"].includes(outcome.adapter) ||
      !isVerificationResult(outcome.result)
    ) throw new Error("invalid discovery verification outcome");
    const failure = outcome.failure === undefined ? undefined : parseVerificationFailure(outcome.failure);
    if (failure && (outcome.result === "collected" || outcome.result === "no_documents")) {
      throw new Error("inconsistent discovery verification failure");
    }
    const retrieval = outcome.retrieval === undefined ? undefined : parseVerificationRetrieval(outcome.retrieval);
    if (
      (requireVerifiedDocumentCount && outcome.verifiedDocuments === undefined) ||
      (outcome.verifiedDocuments !== undefined && !boundedInt(outcome.verifiedDocuments, 0, 10_000)) ||
      (outcome.result === "collected" && (outcome.verifiedDocuments ?? 0) < 1)
    ) {
      throw new Error("invalid verified document count");
    }
    return {
      candidate: outcome.candidate,
      adapter: outcome.adapter,
      result: outcome.result,
      ...(failure ? { failure } : {}),
      ...(retrieval ? { retrieval } : {}),
      ...(outcome.verifiedDocuments !== undefined ? { verifiedDocuments: outcome.verifiedDocuments } : {}),
    };
  });
  return { attempted: value.attempted, outcomes };
}

function parseVerificationFailure(
  value: Omit<CollectionFailureEvidence, "retrieval">,
): Omit<CollectionFailureEvidence, "retrieval"> {
  if (
    !value ||
    !COLLECTION_FAILURE_STAGES.includes(value.stage) ||
    !COLLECTION_FAILURE_CAUSES.includes(value.cause) ||
    (value.httpStatus !== undefined && !boundedInt(value.httpStatus, 0, 599)) ||
    (value.responseType !== undefined && !COLLECTION_RESPONSE_TYPES.includes(value.responseType))
  ) throw new Error("invalid discovery verification failure");
  return {
    stage: value.stage,
    cause: value.cause,
    ...(value.httpStatus !== undefined ? { httpStatus: value.httpStatus } : {}),
    ...(value.responseType !== undefined ? { responseType: value.responseType } : {}),
  };
}

function parseVerificationRetrieval(
  value: Omit<RetrievalProof, "completeness">,
): Omit<RetrievalProof, "completeness"> {
  if (
    !value || !isRetrievalTermination(value.termination) ||
    !boundedInt(value.pagesVisited, 1, 100) ||
    !boundedInt(value.observedItems, 0, 10_000) ||
    !boundedInt(value.resolvedItems, 0, 10_000) ||
    !boundedInt(value.unresolvedItems, 0, 10_000) ||
    value.resolvedItems > value.observedItems + 500
  ) throw new Error("invalid discovery verification retrieval evidence");
  return {
    termination: value.termination,
    pagesVisited: value.pagesVisited,
    observedItems: value.observedItems,
    resolvedItems: value.resolvedItems,
    unresolvedItems: value.unresolvedItems,
  };
}

function boundedInt(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function boundedOptionalInt(value: unknown, minimum: number, maximum: number): value is number | undefined {
  return value === undefined || boundedInt(value, minimum, maximum);
}

function parseAttemptEvidence(value: DiscoveryAttemptEvidence): DiscoveryAttemptEvidence {
  if (
    !value || !boundedInt(value.jsonResources, 0, 1_000) || !boundedInt(value.documentLinks, 0, 1_000) ||
    !boundedOptionalInt(value.observedRequests, 0, 1_000) || !boundedOptionalInt(value.replayedRequests, 0, 1_000) ||
    !boundedInt(value.structuredData, 0, 1_000) || !boundedInt(value.semanticControls, 0, 1_000) ||
    !boundedOptionalInt(value.semanticControlsRejected, 0, 1_000) ||
    !boundedOptionalInt(value.semanticNavigationSteps, 0, 3)
  ) throw new Error("invalid discovery diagnostic attempt evidence");
  return {
    jsonResources: value.jsonResources,
    observedRequests: value.observedRequests ?? 0,
    replayedRequests: value.replayedRequests ?? 0,
    documentLinks: value.documentLinks,
    structuredData: value.structuredData,
    semanticControls: value.semanticControls,
    semanticControlsRejected: value.semanticControlsRejected ?? 0,
    semanticNavigationSteps: value.semanticNavigationSteps ?? 0,
  };
}

function parseAdmissionSignals(value: readonly unknown[]): CandidateAdmissionSignal[] {
  if (!Array.isArray(value) || value.length > CANDIDATE_ADMISSION_SIGNALS.length) {
    throw new Error("invalid candidate admission evidence");
  }
  const safe = [...new Set(value.filter((item): item is CandidateAdmissionSignal =>
    CANDIDATE_ADMISSION_SIGNALS.includes(item as CandidateAdmissionSignal)))];
  if (safe.length !== value.length) throw new Error("invalid candidate admission evidence");
  return safe;
}

function isSafeRouteTemplate(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 160 &&
    (value === "/" || /^\/(?:[a-z0-9._~-]+|:(?:id|segment))(?:\/(?:[a-z0-9._~-]+|:(?:id|segment)))*\/?$/i.test(value)) &&
    !value.includes("..") && !value.includes("?") && !value.includes("#");
}

function isSafeHostname(value: string): boolean {
  if (value.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)) return false;
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPageSource(value: unknown): value is ExplorationPageSource {
  return value === "entry" || value === "entry_replay" || value === "linked" ||
    value === "common_route" || value === "remembered";
}

function isTermination(value: unknown): value is DiscoveryTermination {
  return value === "page_cap" || value === "time_cap" || value === "queue_exhausted" || value === "coverage_incomplete" ||
    value === "candidate_primary_found" || value === "candidate_set_complete";
}

function isVerificationResult(value: unknown): value is CandidateVerificationResult {
  return value === "no_documents" || value === "collected" || OPERATIONAL_OUTCOME_CODES.includes(value as OperationalOutcomeCode);
}

function isRetrievalTermination(value: unknown): value is RetrievalProof["termination"] {
  return value === "explicit_end" || value === "stable_end" || value === "continuation_failed" || value === "repeated_state" ||
    value === "page_cap" || value === "action_cap" || value === "document_cap" || value === "time_cap";
}

function isAttemptResult(value: unknown): value is DiscoveryAttemptResult {
  return [
    "candidate_compiled", "no_candidate", "probe_failed", "auth_failed", "auth_expired", "auth_blocked", "auth_scope_denied", "transport_failed",
    "scope_failed", "list_failed", "too_many_documents", "invalid_identity", "invalid_document_path",
    "unapproved_document_origin", "no_documents", "policy_rejected", "route_not_replayable", "limit_reached",
  ].includes(String(value));
}
