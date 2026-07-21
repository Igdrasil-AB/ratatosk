import type { DiscoveryAdapterId } from "../../../src/core/discovery";
import type { RetrievalProof } from "../../../src/core/types";
import { OPERATIONAL_OUTCOME_CODES, type OperationalOutcomeCode } from "../../../src/core/errors";
import type { ExplorationPageSource } from "./discovery-explorer";

export const DISCOVERY_DIAGNOSTIC_SCHEMA = "ratatosk.discovery-diagnostic.v6" as const;
const LEGACY_DISCOVERY_DIAGNOSTIC_SCHEMAS = new Set([
  "ratatosk.discovery-diagnostic.v4",
  "ratatosk.discovery-diagnostic.v5",
]);

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
  | "limit_reached";

export type DiscoveryTermination = "page_cap" | "time_cap" | "queue_exhausted" | "candidate_set_complete";
export type CandidateVerificationResult = OperationalOutcomeCode | "no_documents" | "collected";

export interface CandidateVerificationAttempt {
  candidate: number;
  adapter: DiscoveryAdapterId;
  result: CandidateVerificationResult;
  retrieval?: Omit<RetrievalProof, "completeness">;
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
  attempts: Array<{
    page: number;
    source: ExplorationPageSource;
    route: string;
    resolvedRoute?: string;
    adapter?: DiscoveryAdapterId;
    result: DiscoveryAttemptResult;
    durationMs: number;
    evidence?: DiscoveryAttemptEvidence;
  }>;
  verification?: {
    attempted: number;
    outcomes: CandidateVerificationAttempt[];
  };
  termination: DiscoveryTermination;
  result: "not_found" | "limit_reached" | "candidates_found";
}

/** Internal source-compatibility aliases for callers created before v6. */
export type DiscoveryDiagnosticV5 = DiscoveryDiagnosticV6;
export type DiscoveryDiagnosticV4 = DiscoveryDiagnosticV6;
export type DiscoveryDiagnosticV2 = DiscoveryDiagnosticV6;
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
  if (!raw.limits || !boundedInt(raw.limits.pages, 1, 20) || !boundedInt(raw.limits.depth, 0, 5) || !boundedInt(raw.limits.durationMs, 1_000, 60_000)) {
    throw new Error("invalid discovery diagnostic limits");
  }
  if (!raw.timing || !boundedInt(raw.timing.elapsedMs, 0, 120_000)) throw new Error("invalid discovery diagnostic timing");
  if (!raw.pages || !boundedInt(raw.pages.attempted, 0, 20) || !boundedInt(raw.pages.linked, 0, 20) || !boundedInt(raw.pages.commonRoutes, 0, 20)) {
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
  if (!result || !termination || !Array.isArray(raw.attempts) || raw.attempts.length > 40) {
    throw new Error("invalid discovery diagnostic attempts");
  }
  if (
    (result === "candidates_found") !== (termination === "candidate_set_complete") ||
    (result === "candidates_found") !== (raw.candidates.retained > 0) ||
    (result === "not_found") !== (termination === "queue_exhausted")
  ) throw new Error("inconsistent discovery termination");
  const attempts = raw.attempts.map((attempt) => {
    if (
      !attempt || !boundedInt(attempt.page, 1, 20) || !isPageSource(attempt.source) || !isAttemptResult(attempt.result) ||
      !isSafeRouteTemplate(attempt.route) ||
      (attempt.resolvedRoute !== undefined && !isSafeRouteTemplate(attempt.resolvedRoute)) ||
      !boundedInt(attempt.durationMs, 0, 60_000)
    ) throw new Error("invalid discovery diagnostic attempt");
    if (attempt.adapter !== undefined && !["network-json", "embedded-json", "dom-links", "dom-actions"].includes(attempt.adapter)) {
      throw new Error("invalid discovery diagnostic adapter");
    }
    const evidence = attempt.evidence === undefined ? undefined : parseAttemptEvidence(attempt.evidence);
    return {
      page: attempt.page,
      source: attempt.source,
      route: attempt.route,
      resolvedRoute: attempt.resolvedRoute,
      adapter: attempt.adapter,
      result: attempt.result,
      durationMs: attempt.durationMs,
      ...(evidence ? { evidence } : {}),
    };
  });
  if (attempts.some((attempt) => attempt.page > raw.pages!.attempted)) {
    throw new Error("discovery diagnostic attempt exceeds attempted pages");
  }
  const verification = parseVerification(raw.verification, raw.candidates.retained, result);
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
    attempts,
    ...(verification ? { verification } : {}),
    termination,
    result,
  };
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
    const retrieval = outcome.retrieval === undefined ? undefined : parseVerificationRetrieval(outcome.retrieval);
    return {
      candidate: outcome.candidate,
      adapter: outcome.adapter,
      result: outcome.result,
      ...(retrieval ? { retrieval } : {}),
    };
  });
  return { attempted: value.attempted, outcomes };
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
    !boundedInt(value.structuredData, 0, 1_000) || !boundedInt(value.semanticControls, 0, 1_000)
  ) throw new Error("invalid discovery diagnostic attempt evidence");
  return {
    jsonResources: value.jsonResources,
    observedRequests: value.observedRequests ?? 0,
    replayedRequests: value.replayedRequests ?? 0,
    documentLinks: value.documentLinks,
    structuredData: value.structuredData,
    semanticControls: value.semanticControls,
  };
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
  return value === "entry" || value === "linked" || value === "common_route";
}

function isTermination(value: unknown): value is DiscoveryTermination {
  return value === "page_cap" || value === "time_cap" || value === "queue_exhausted" || value === "candidate_set_complete";
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
    "unapproved_document_origin", "no_documents", "policy_rejected", "limit_reached",
  ].includes(String(value));
}
