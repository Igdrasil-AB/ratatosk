import {
  COLLECTION_FAILURE_CAUSES,
  COLLECTION_FAILURE_STAGES,
  COLLECTION_RESPONSE_TYPES,
  OPERATIONAL_OUTCOME_CODES,
  type CollectionFailureEvidence,
  type OperationalOutcomeCode,
} from "../../../src/core/errors";
import type { ReplayTrace, RetrievalCompleteness, RetrievalProof, RetrievalTermination } from "../../../src/core/types";
import { parseReplayTrace } from "./discovery-diagnostic";
import type { Connection, LastRunEvidence } from "./storage";

export const COLLECTOR_DIAGNOSTIC_SCHEMA = "ratatosk.collector-diagnostic.v2" as const;
const RUN_TRIGGERS = ["connect", "manual", "scheduled"] as const;
const RUN_STATUSES = ["ok", "partial", "auth_expired", "rate_limited", "error"] as const;
const RETRIEVAL_COMPLETENESS: readonly RetrievalCompleteness[] = ["complete", "partial"];
const RETRIEVAL_TERMINATIONS: readonly RetrievalTermination[] = [
  "explicit_end", "stable_end", "continuation_failed", "repeated_state",
  "page_cap", "action_cap", "document_cap", "time_cap",
];
const MAX_COUNT = 100_000;
const MAX_ELAPSED_MS = 3_600_000;

export interface CollectorDiagnostic {
  schema: typeof COLLECTOR_DIAGNOSTIC_SCHEMA;
  vendorId: string;
  collectorVersion: string;
  lifecycleRevision: string;
  runtime?: { discoveryEngine: number; documentAcquisition: number };
  outcomeCode: OperationalOutcomeCode;
  recordedAt: string | null;
  counts: {
    collected: number;
    documentActions: number;
    failedScopes: number;
    emptyScopes: number;
  };
  nextEligibleAt: string | null;
  lastRunEvidence?: LastRunEvidence;
}

export function buildCollectorDiagnostic(input: {
  vendorId: string;
  collectorVersion: string;
  lifecycleRevision: string;
  runtime?: { discoveryEngine: number; documentAcquisition: number };
  connection: Connection | undefined;
}): CollectorDiagnostic {
  const connection = input.connection;
  const lastRunEvidence = readLastRunEvidence(connection?.lastRunEvidence);
  return {
    schema: COLLECTOR_DIAGNOSTIC_SCHEMA,
    vendorId: safeId(input.vendorId),
    collectorVersion: input.collectorVersion,
    lifecycleRevision: input.lifecycleRevision,
    ...(input.runtime ? { runtime: {
      discoveryEngine: boundedCount(input.runtime.discoveryEngine),
      documentAcquisition: boundedCount(input.runtime.documentAcquisition),
    } } : {}),
    outcomeCode: oneOf(connection?.lastCode, OPERATIONAL_OUTCOME_CODES) ? connection!.lastCode! : "unknown",
    recordedAt: isoTimestamp(connection?.lastRunAt),
    counts: {
      collected: boundedCount(connection?.lastCount),
      documentActions: boundedCount(connection?.lastDocumentActionCount),
      failedScopes: boundedCount(connection?.lastFailedScopes),
      emptyScopes: boundedCount(connection?.lastEmptyScopes),
    },
    nextEligibleAt: isoTimestamp(connection?.nextEligibleRunAt),
    ...(lastRunEvidence ? { lastRunEvidence } : {}),
  };
}

/** Rebuild persisted evidence from finite fields at both storage and export. */
export function readLastRunEvidence(value: unknown): LastRunEvidence | undefined {
  const raw = record(value);
  const counts = record(raw?.counts);
  if (!raw || !counts || !oneOf(raw.trigger, RUN_TRIGGERS) || !oneOf(raw.status, RUN_STATUSES) ||
    !boundedInt(raw.elapsedMs, MAX_ELAPSED_MS)) return undefined;
  const accepted = boundedInt(counts.accepted, MAX_COUNT) ? counts.accepted : undefined;
  const verified = boundedInt(counts.verified, MAX_COUNT) ? counts.verified : undefined;
  const documentActions = boundedInt(counts.documentActions, MAX_COUNT) ? counts.documentActions : undefined;
  const pageOwnedDownloads = boundedInt(counts.pageOwnedDownloads, MAX_COUNT) ? counts.pageOwnedDownloads : undefined;
  const failedScopes = boundedInt(counts.failedScopes, MAX_COUNT) ? counts.failedScopes : undefined;
  const emptyScopes = boundedInt(counts.emptyScopes, MAX_COUNT) ? counts.emptyScopes : undefined;
  if ([accepted, verified, documentActions, pageOwnedDownloads, failedScopes, emptyScopes].some((count) => count === undefined) ||
    (raw.code !== undefined && !oneOf(raw.code, OPERATIONAL_OUTCOME_CODES)) ||
    (raw.retrieval !== undefined && !oneOf(raw.retrieval, RETRIEVAL_COMPLETENESS))) return undefined;
  const retrievalProof = raw.retrievalProof === undefined ? undefined : readRetrievalProof(raw.retrievalProof);
  const retrievalSummary = raw.retrievalSummary === undefined ? undefined : readRetrievalSummary(raw.retrievalSummary);
  const scopeFailureCodes = raw.scopeFailureCodes === undefined ? undefined : readScopeFailureCodes(raw.scopeFailureCodes);
  const replay = raw.replay === undefined ? undefined : readReplay(raw.replay);
  const runtime = raw.runtime === undefined ? undefined : readRunRuntime(raw.runtime);
  const failure = raw.failure === undefined ? undefined : readFailure(raw.failure);
  const terminalFailure = raw.terminalFailure === undefined ? undefined : readFailure(raw.terminalFailure);
  if ((raw.retrievalProof !== undefined && !retrievalProof) || (raw.retrievalSummary !== undefined && !retrievalSummary) ||
    (raw.scopeFailureCodes !== undefined && !scopeFailureCodes) || (raw.replay !== undefined && !replay) ||
    (raw.runtime !== undefined && !runtime) ||
    (raw.failure !== undefined && !failure) || (raw.terminalFailure !== undefined && !terminalFailure)) return undefined;
  return {
    ...(runtime ? { runtime } : {}),
    trigger: raw.trigger,
    status: raw.status,
    ...(raw.code === undefined ? {} : { code: raw.code as OperationalOutcomeCode }),
    elapsedMs: raw.elapsedMs,
    counts: { accepted: accepted!, verified: verified!, documentActions: documentActions!,
      pageOwnedDownloads: pageOwnedDownloads!, failedScopes: failedScopes!, emptyScopes: emptyScopes! },
    ...(raw.retrieval === undefined ? {} : { retrieval: raw.retrieval as RetrievalCompleteness }),
    ...(retrievalProof ? { retrievalProof } : {}),
    ...(retrievalSummary ? { retrievalSummary } : {}),
    ...(scopeFailureCodes ? { scopeFailureCodes } : {}),
    ...(replay ? { replay } : {}),
    ...(failure ? { failure } : {}),
    ...(terminalFailure ? { terminalFailure } : {}),
  };
}

function readRunRuntime(value: unknown): NonNullable<LastRunEvidence["runtime"]> | undefined {
  const raw = record(value);
  if (!raw || typeof raw.collectorVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.collectorVersion) ||
    !boundedInt(raw.discoveryEngine, 10_000) || !boundedInt(raw.documentAcquisition, 10_000)) return undefined;
  return { collectorVersion: raw.collectorVersion,
    discoveryEngine: raw.discoveryEngine, documentAcquisition: raw.documentAcquisition };
}

function readRetrievalSummary(value: unknown): LastRunEvidence["retrievalSummary"] | undefined {
  const raw = record(value);
  if (!raw || !boundedInt(raw.proofs, 100) || !boundedInt(raw.complete, 100) || !boundedInt(raw.partial, 100) ||
    raw.complete + raw.partial !== raw.proofs ||
    !boundedInt(raw.pagesVisited, MAX_COUNT) || !boundedInt(raw.observedItems, MAX_COUNT) ||
    !boundedInt(raw.resolvedItems, MAX_COUNT) || !boundedInt(raw.unresolvedItems, MAX_COUNT) ||
    !Array.isArray(raw.terminations) || raw.terminations.length > RETRIEVAL_TERMINATIONS.length ||
    raw.terminations.some((item) => !oneOf(item, RETRIEVAL_TERMINATIONS)) ||
    new Set(raw.terminations).size !== raw.terminations.length) return undefined;
  return {
    proofs: raw.proofs, complete: raw.complete, partial: raw.partial,
    pagesVisited: raw.pagesVisited, observedItems: raw.observedItems,
    resolvedItems: raw.resolvedItems, unresolvedItems: raw.unresolvedItems,
    terminations: raw.terminations,
  };
}

function readScopeFailureCodes(value: unknown): OperationalOutcomeCode[] | undefined {
  if (!Array.isArray(value) || value.length > OPERATIONAL_OUTCOME_CODES.length ||
    value.some((code) => !oneOf(code, OPERATIONAL_OUTCOME_CODES)) || new Set(value).size !== value.length) return undefined;
  return value;
}

function readReplay(value: unknown): ReplayTrace | undefined {
  try { return parseReplayTrace(value as ReplayTrace); } catch { return undefined; }
}

function readFailure(value: unknown): CollectionFailureEvidence | undefined {
  const raw = record(value);
  if (!raw || !oneOf(raw.stage, COLLECTION_FAILURE_STAGES) || !oneOf(raw.cause, COLLECTION_FAILURE_CAUSES) ||
    (raw.httpStatus !== undefined && !boundedInt(raw.httpStatus, 599)) ||
    (raw.responseType !== undefined && !oneOf(raw.responseType, COLLECTION_RESPONSE_TYPES))) return undefined;
  const retrieval = raw.retrieval === undefined ? undefined : readRetrievalProof(raw.retrieval);
  if (raw.retrieval !== undefined && !retrieval) return undefined;
  return {
    stage: raw.stage,
    cause: raw.cause,
    ...(raw.httpStatus === undefined ? {} : { httpStatus: raw.httpStatus as number }),
    ...(raw.responseType === undefined ? {} : { responseType: raw.responseType as CollectionFailureEvidence["responseType"] }),
    ...(retrieval ? { retrieval } : {}),
  };
}

function readRetrievalProof(value: unknown): RetrievalProof | undefined {
  const raw = record(value);
  if (!raw || !oneOf(raw.completeness, RETRIEVAL_COMPLETENESS) || !oneOf(raw.termination, RETRIEVAL_TERMINATIONS) ||
    !boundedInt(raw.pagesVisited, MAX_COUNT) || !boundedInt(raw.observedItems, MAX_COUNT) ||
    !boundedInt(raw.resolvedItems, MAX_COUNT) || !boundedInt(raw.unresolvedItems, MAX_COUNT)) return undefined;
  return { completeness: raw.completeness, termination: raw.termination,
    pagesVisited: raw.pagesVisited, observedItems: raw.observedItems,
    resolvedItems: raw.resolvedItems, unresolvedItems: raw.unresolvedItems };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

function boundedInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function safeId(value: string): string {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) ? value : "unknown";
}

function boundedCount(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? Math.min(value, 100_000) : 0;
}

function isoTimestamp(value: number | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value!);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
