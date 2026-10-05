import { streamVendor } from "../../../src/core/engine";
import type { FetchedDocument, ReplayTrace, RetrievalCompleteness, RetrievalProof, VendorRecipe } from "../../../src/core/types";
import {
  AuthExpired,
  AuthFailure,
  type CollectionFailureEvidence,
  type CollectionFailureStage,
  DocumentPermissionRequired,
  collectionFailureEvidence,
  operationalCodeForError,
  operationalOutcomeLabel,
  RateLimited,
  RetrievalIncomplete,
  type OperationalOutcomeCode,
} from "../../../src/core/errors";
import { buildRunContext, buildSink, buildStrategies, DestinationNeedsReconnect } from "./runtime";
import { resolveCollectorSource } from "./source-catalog";
import {
  boundedNextEligibleRunAt,
  getConnections,
  getDestination,
  getNextEligibleRunAt,
  markDestinationUnavailable,
  recordCollected,
  recordRun,
  sinkCompanyId,
  type ConnectionStatus,
  type DestinationId,
  type LastRunEvidence,
} from "./storage";
import { isTransientRetryCode, nextTransientRetryAt } from "./retry-policy";
import { IngestUnauthorized } from "../../../src/ingest/http-sink";
import { notifyReconnect, notifyDestinationReconnect } from "./notifications";
import { ReplayPhaseFailed } from "./document-action-controller";
import { COLLECTOR_RUNTIME_IDENTITY } from "./collector-runtime-identity";

export interface VendorRunSummary {
  vendorId: string;
  status: "ok" | "partial" | "auth_expired" | "rate_limited" | "skipped" | "error";
  /** Newly committed documents. Backend-reported duplicates are excluded. */
  count: number;
  /** Documents whose retrieval and destination identity were verified,
   * including documents the destination had already accepted. */
  verifiedCount?: number;
  /** Privacy-safe count of semantic document controls activated in this run. */
  documentActionCount?: number;
  /** Page-owned download responses observed and rejected during this run. */
  pageOwnedDownloadCount?: number;
  retrieval?: RetrievalCompleteness;
  retrievalProof?: RetrievalProof;
  retrievalSummary?: LastRunEvidence["retrievalSummary"];
  scopeFailureCodes?: OperationalOutcomeCode[];
  replay?: ReplayTrace;
  code?: OperationalOutcomeCode;
  failedScopes?: number;
  emptyScopes?: number;
  nextEligibleRunAt?: number;
  error?: string;
  requiredOrigins?: readonly string[];
  /** Closed stage/cause evidence for diagnostics; never contains supplier data. */
  failure?: CollectionFailureEvidence;
  terminalFailure?: CollectionFailureEvidence;
}

/**
 * Run one vendor and ingest what it produces. This is where the run loop closes:
 * a document is marked "seen" ONLY after the sink accepts it, so a failed ingest
 * is retried on the next sync rather than lost.
 *
 * A destination is mandatory. Refusing before the first vendor request keeps the
 * user's disclosure and destination choice aligned with every collection run.
 */
const vendorRuns = new Map<string, Promise<VendorRunSummary>>();

class DestinationDeliveryError extends Error {
  constructor(readonly cause: unknown) {
    super("invoice destination unavailable");
    this.name = "DestinationDeliveryError";
  }
}

class DiscoveryAdmissionError extends Error {
  constructor(readonly cause: unknown) {
    super("discovered supplier connection could not be saved");
    this.name = "DiscoveryAdmissionError";
  }
}

export type SyncTrigger = "scheduled" | "manual" | "connect";

export function runVendorById(vendorId: string, trigger: SyncTrigger = "manual"): Promise<VendorRunSummary> {
  const existing = vendorRuns.get(vendorId);
  if (existing) return existing;

  const task = resolveCollectorSource(vendorId)
    .then(async (source) => {
      if (!source?.recipe) return recordBlockedRun(vendorId, trigger, "source_unavailable");
      // The destination is the SUPPLIER's, resolved at the moment the run
      // starts. There is no global current destination to read, which is what
      // makes "one supplier, one company" true of every path rather than of
      // the paths someone remembered to check.
      const destinationId = (await getConnections())[vendorId]?.destinationId;
      return executeRecipeRun(source.recipe, destinationId, undefined, false, source.candidateCount, trigger);
    })
    .finally(() => {
      if (vendorRuns.get(vendorId) === task) vendorRuns.delete(vendorId);
    });
  vendorRuns.set(vendorId, task);
  return task;
}

/** Execute an ephemeral candidate before it is admitted to the local catalog. */
export function runDiscoveredCandidate(
  recipe: VendorRecipe,
  destinationId: DestinationId,
  afterFirstDelivery: (document: FetchedDocument) => Promise<void>,
): Promise<VendorRunSummary> {
  return executeRecipeRun(recipe, destinationId, afterFirstDelivery, true);
}

async function executeRecipeRun(
  recipe: VendorRecipe,
  destinationId: DestinationId | undefined,
  afterFirstDelivery?: (document: FetchedDocument) => Promise<void>,
  requireCompleteRetrieval = false,
  minimumResolvedDocuments = 0,
  trigger: SyncTrigger = "connect",
): Promise<VendorRunSummary> {
  const vendorId = recipe.id;
  const startedAt = Date.now();

  const previous = (await getConnections())[vendorId];
  if (trigger === "scheduled" && previous?.lastCode === "auth_expired") {
    return { vendorId, status: "auth_expired", count: 0, code: "auth_expired" };
  }
  const nextEligibleRunAt = await getNextEligibleRunAt(vendorId);
  if (nextEligibleRunAt && (trigger === "scheduled" || !isTransientRetryCode(previous?.lastCode))) {
    return { vendorId, status: "skipped", count: 0, code: previous?.lastCode ?? "rate_limited", nextEligibleRunAt };
  }

  // A supplier left unbound by a company disconnect is paused, not redirected.
  // Local Downloads is never an automatic fallback.
  if (!destinationId) return recordBlockedRun(vendorId, trigger, "destination_unbound", startedAt);
  const destination = await getDestination(destinationId);
  if (!destination) return recordBlockedRun(vendorId, trigger, "destination_unbound", startedAt);
  if (destination.kind === "unavailable") {
    return recordBlockedRun(vendorId, trigger,
      destination.reason === "connection_expired" ? "destination_connection_expired" : "destination_unavailable", startedAt);
  }

  let acceptedCount = 0;
  let verifiedCount = 0;
  let retrieval: RetrievalCompleteness | undefined;
  let retrievalProof: RetrievalProof | undefined;
  let retrievalSummary: LastRunEvidence["retrievalSummary"];
  let scopeFailureCodes: OperationalOutcomeCode[] | undefined;
  let replay: ReplayTrace | undefined;
  let failure: CollectionFailureEvidence | undefined;
  let latestFailure: CollectionFailureEvidence | undefined;
  let latestError: unknown;
  let terminalFailure: CollectionFailureEvidence | undefined;
  const { ctx, dispose } = buildRunContext(sinkCompanyId(destination), recipe);
  const acquisitionMetrics = { documentActions: 0, pageOwnedDownloads: 0 };
  const strategies = buildStrategies(recipe, {
    onSemanticDocumentAction: () => {
      acquisitionMetrics.documentActions = Math.min(10_000, acquisitionMetrics.documentActions + 1);
    },
    onPageOwnedDownloadObservation: (attempted) => {
      if (attempted) acquisitionMetrics.pageOwnedDownloads = Math.min(10_000, acquisitionMetrics.pageOwnedDownloads + 1);
    },
  });
  const runMetrics = () => ({
    documentActionCount: acquisitionMetrics.documentActions,
    pageOwnedDownloadCount: acquisitionMetrics.pageOwnedDownloads,
  });
  const recordRunOutcome = (
    patch: Parameters<typeof recordRun>[1] & { lastStatus: ConnectionStatus },
  ): Promise<void> => {
    const counts: LastRunEvidence["counts"] = {
      accepted: boundedCount(acceptedCount),
      verified: boundedCount(verifiedCount),
      documentActions: boundedCount(acquisitionMetrics.documentActions),
      pageOwnedDownloads: boundedCount(acquisitionMetrics.pageOwnedDownloads),
      failedScopes: boundedCount(patch.lastFailedScopes ?? 0),
      emptyScopes: boundedCount(patch.lastEmptyScopes ?? 0),
    };
    return recordRun(vendorId, {
      ...patch,
      lastCount: counts.accepted,
      lastDocumentActionCount: counts.documentActions,
      lastPageOwnedDownloadCount: counts.pageOwnedDownloads,
      lastFailedScopes: counts.failedScopes,
      lastEmptyScopes: counts.emptyScopes,
      lastRunEvidence: {
        runtime: runRuntimeIdentity(),
        trigger, status: patch.lastStatus, ...(patch.lastCode ? { code: patch.lastCode } : {}),
        elapsedMs: boundedElapsed(startedAt), counts,
        ...(retrieval ? { retrieval } : {}),
        ...(retrievalProof ? { retrievalProof } : {}),
        ...(retrievalSummary ? { retrievalSummary } : {}),
        ...(scopeFailureCodes ? { scopeFailureCodes } : {}),
        ...(replay ? { replay } : {}),
        ...(failure ? { failure } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
      },
    });
  };

  console.info(`[collector] running "${vendorId}"…`);

  try {
    let firstDeliveryCommitted = false;
    let sink: Awaited<ReturnType<typeof buildSink>>;
    try {
      // Build the irreversible delivery path from the exact destination
      // snapshot that supplied this run's tenant/dedup context. A later UI
      // configuration change must apply to the next run, never split one run
      // across two destinations.
      sink = await buildSink(destination);
    } catch (error) {
      throw new DestinationDeliveryError(error);
    }
    const collectedAt = Date.now();
    const result = await streamVendor(recipe, ctx, strategies, async (doc) => {
      try {
        const result = await sink.send(doc);
        if (!result.accepted) throw new Error("destination rejected document");
        // Remember the accepted delivery before any admission callback. The
        // destination write cannot be rolled back, so its dedup evidence must
        // survive later secondary dedup/profile/connection storage failures.
        if (!result.deduped) acceptedCount++;
        // A backend-deduplicated retry can be the recovery path after a
        // previous accepted delivery failed before this local write. Preserve
        // (or restore) the local collection history for every accepted sink
        // response before committing either seen key.
        await recordCollected([
          {
            key: doc.idempotencyKey,
            vendorId: doc.vendorId,
            vendorName: doc.vendorName,
            vendorInvoiceId: doc.vendorInvoiceId,
            invoiceNumber: doc.invoiceNumber,
            issuedAt: doc.issuedAt || undefined,
            total: doc.total,
            currency: doc.currency,
            filename: doc.filename,
            metadataEvidence: doc.metadataEvidence,
            metadataConflicts: doc.metadataConflicts,
            collectedAt,
          },
        ]);
      } catch (error) {
        throw new DestinationDeliveryError(error);
      }
      if (!firstDeliveryCommitted) {
        try {
          await afterFirstDelivery?.(doc);
          firstDeliveryCommitted = true;
        } catch (error) {
          // Delivery is already durable, but discovery must not report a
          // connected supplier until both its profile and connection persist.
          throw new DiscoveryAdmissionError(error);
        }
      }
      // Admission must succeed before either identity becomes a retry guard.
      // The durable destination journal makes a repeated delivery safe while
      // leaving a failed discovered candidate eligible for verification again.
      try {
        await ctx.seen.add(doc.contentIdempotencyKey, doc.source);
        await ctx.seen.add(doc.idempotencyKey, doc.source);
        verifiedCount++;
      } catch (error) {
        throw new DestinationDeliveryError(error);
      }
    }, {
      requireCompleteRetrieval,
      onFailure: (evidence, error) => {
        failure ??= evidence;
        latestFailure = evidence;
        latestError = error;
        if (error instanceof ReplayPhaseFailed && (!replay || !replay.firstFailure)) replay = error.replay;
      },
    });
    const { scopes } = result;
    retrieval = result.retrieval;
    retrievalProof = result.retrievalProof;
    retrievalSummary = summarizeRetrievalProofs(result.retrievalProofs ?? (result.retrievalProof ? [result.retrievalProof] : []));
    scopeFailureCodes = result.scopes.failureCodes ?? [];
    replay ??= result.replay;
    if (retrievalProof && retrievalProof.resolvedItems < minimumResolvedDocuments) {
      const error = new RetrievalIncomplete(
        `replay resolved ${retrievalProof.resolvedItems} of ${minimumResolvedDocuments} previously proven document controls`,
        recipe.id,
        { ...retrievalProof, completeness: "partial" },
      );
      failure = collectionFailureEvidence(error, "invoice_list", error.proof);
      throw error;
    }
    console.info(`[collector] "${vendorId}": ok — ${acceptedCount} document(s)`);

    const partial = scopes.failed > 0;
    const code = partial ? "partial_scope_failure" as const : undefined;
    await recordRunOutcome({
      lastStatus: partial ? "partial" : "ok",
      lastCount: acceptedCount,
      lastCode: code,
      lastFailedScopes: scopes.failed,
      lastEmptyScopes: scopes.empty,
      lastError: undefined,
      nextEligibleRunAt: undefined,
    });
    return {
      vendorId,
      status: partial ? "partial" : "ok",
      count: acceptedCount,
      verifiedCount,
      ...runMetrics(),
      retrieval,
      ...(retrievalProof ? { retrievalProof } : {}),
      ...(retrievalSummary ? { retrievalSummary } : {}),
      ...(scopeFailureCodes ? { scopeFailureCodes } : {}),
      ...(replay ? { replay } : {}),
      ...(failure ? { failure } : {}),
      ...(code ? { code } : {}),
      failedScopes: scopes.failed,
      emptyScopes: scopes.empty,
    };
  } catch (err) {
    // An expired or revoked company credential retires that ONE destination and
    // offers reconnection, instead of failing every supplier bound to it with a
    // generic delivery error nobody can act on.
    if (err instanceof DestinationDeliveryError && err.cause instanceof IngestUnauthorized
      && destination.kind === "igdrasil") {
      terminalFailure = { stage: "delivery", cause: "destination_rejected" };
      failure ??= terminalFailure;
      terminalFailure = distinctTerminalFailure(failure, terminalFailure);
      await markDestinationUnavailable(destinationId, "connection_expired").catch(() => undefined);
      notifyDestinationReconnect(destination.companyName);
      const code = "destination_connection_expired" as const;
      const message = operationalOutcomeLabel(code);
      await recordRunOutcome({
        lastStatus: acceptedCount > 0 ? "partial" : "error",
        lastCount: acceptedCount || undefined,
        lastCode: code,
        lastError: message,
        nextEligibleRunAt: undefined,
      });
      return {
        vendorId,
        status: acceptedCount > 0 ? "partial" : "error",
        count: acceptedCount,
        verifiedCount,
        ...runMetrics(),
        failure,
        terminalFailure,
        code,
        error: message,
      };
    }
    if (err instanceof DestinationDeliveryError) {
      terminalFailure = {
        ...collectionFailureEvidence(err.cause, "delivery", failure?.retrieval),
        stage: "delivery",
        cause: "destination_rejected",
      };
    } else if (err instanceof DiscoveryAdmissionError) {
      terminalFailure = {
        ...collectionFailureEvidence(err.cause, "admission", failure?.retrieval),
        stage: "admission",
        cause: "state_persistence",
      };
    } else {
      terminalFailure = latestError === err && latestFailure
        ? latestFailure : collectionFailureEvidence(err, fallbackFailureStage(err));
    }
    failure ??= terminalFailure;
    terminalFailure = distinctTerminalFailure(failure, terminalFailure);
    retrievalProof ??= failure?.retrieval;
    if (err instanceof RetrievalIncomplete) retrievalProof = err.proof;
    if (err instanceof DiscoveryAdmissionError) {
      const code = "connection_persistence_failed" as const;
      const message = operationalOutcomeLabel(code);
      console.error(`[collector] "${vendorId}": ${message}`);
      await recordRunOutcome({ lastStatus: "error", lastCode: code, lastError: message, nextEligibleRunAt: undefined });
      return {
        vendorId,
        status: "error",
        count: acceptedCount,
        verifiedCount,
        ...runMetrics(),
        retrieval,
        ...(retrievalProof ? { retrievalProof } : {}),
        ...(failure ? { failure } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
        code,
        error: message,
      };
    }
    if (err instanceof AuthExpired) {
      console.warn(`[collector] "${vendorId}": auth check failed — session looks logged out`);
      notifyReconnect(recipe);
      if (acceptedCount > 0) {
        const message = operationalOutcomeLabel("auth_expired");
        await recordRunOutcome({
          lastStatus: "partial",
          lastCount: acceptedCount,
          lastCode: "auth_expired",
          lastError: message,
          nextEligibleRunAt: undefined,
        });
        return {
          vendorId,
          status: "partial",
          count: acceptedCount,
          ...runMetrics(),
          retrieval,
          code: "auth_expired",
          error: message,
          ...(failure ? { failure } : {}),
          ...(terminalFailure ? { terminalFailure } : {}),
        };
      }
      await recordRunOutcome({ lastStatus: "auth_expired", lastCode: "auth_expired", nextEligibleRunAt: undefined });
      return {
        vendorId,
        status: "auth_expired",
        count: 0,
        code: "auth_expired",
        ...runMetrics(),
        ...(failure ? { failure } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
      };
    }
    if (err instanceof AuthFailure) {
      const code = operationalCodeForError(err);
      const message = operationalOutcomeLabel(code);
      console.warn(`[collector] "${vendorId}": ${message.toLowerCase()}`);
      if (acceptedCount > 0) {
        await recordRunOutcome({ lastStatus: "partial", lastCount: acceptedCount, lastCode: code, lastError: message, nextEligibleRunAt: undefined });
        return {
          vendorId,
          status: "partial",
          count: acceptedCount,
          retrieval,
          code,
          error: message,
          ...runMetrics(),
          ...(failure ? { failure } : {}),
          ...(terminalFailure ? { terminalFailure } : {}),
        };
      }
      await recordRunOutcome({ lastStatus: "error", lastCode: code, lastError: message, nextEligibleRunAt: undefined });
      return {
        vendorId,
        status: "error",
        count: 0,
        code,
        error: message,
        ...runMetrics(),
        ...(failure ? { failure } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
      };
    }
    if (err instanceof RateLimited) {
      const eligibleAt = boundedNextEligibleRunAt(err.retryAfterMs);
      await recordRunOutcome({
        lastStatus: acceptedCount > 0 ? "partial" : "rate_limited",
        lastCount: acceptedCount || undefined,
        lastCode: "rate_limited",
        lastError: operationalOutcomeLabel("rate_limited"),
        nextEligibleRunAt: eligibleAt,
      });
      return acceptedCount > 0
        ? {
            vendorId,
            status: "partial",
            count: acceptedCount,
            retrieval,
            code: "rate_limited",
            error: operationalOutcomeLabel("rate_limited"),
            nextEligibleRunAt: eligibleAt,
            ...runMetrics(),
            ...(failure ? { failure } : {}),
            ...(terminalFailure ? { terminalFailure } : {}),
          }
        : {
            vendorId,
            status: "rate_limited",
            count: 0,
            code: "rate_limited",
            nextEligibleRunAt: eligibleAt,
            ...runMetrics(),
            ...(failure ? { failure } : {}),
            ...(terminalFailure ? { terminalFailure } : {}),
          };
    }
    if (err instanceof DocumentPermissionRequired) {
      const code = "document_permission_required" as const;
      const message = operationalOutcomeLabel(code);
      const existing = (await getConnections())[vendorId];
      if (existing) {
        await recordRunOutcome({
          lastStatus: acceptedCount > 0 ? "partial" : "error",
          lastCount: acceptedCount || undefined,
          lastCode: code,
          lastError: message,
          documentOrigins: [...new Set([...(existing.documentOrigins ?? []), ...err.requiredOrigins])],
          nextEligibleRunAt: undefined,
        });
      }
      return {
        vendorId,
        status: acceptedCount > 0 ? "partial" : "error",
        count: acceptedCount,
        retrieval,
        code,
        error: message,
        requiredOrigins: err.requiredOrigins,
        ...runMetrics(),
        ...(failure ? { failure } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
      };
    }
    const code: OperationalOutcomeCode = err instanceof DestinationDeliveryError
      ? (err.cause instanceof DestinationNeedsReconnect ? "destination_connection_expired" : "destination_unavailable")
      : operationalCodeForError(err);
    const message = operationalOutcomeLabel(code);
    const nextEligibleRunAt = nextTransientRetryAt(code, (previous?.consecutiveFailures ?? 0) + 1);
    console.error(`[collector] "${vendorId}": ${message}`);
    if (acceptedCount > 0) {
      await recordRunOutcome({ lastStatus: "partial", lastCount: acceptedCount, lastCode: code, lastError: message, nextEligibleRunAt });
      return {
        vendorId,
        status: "partial",
        count: acceptedCount,
        retrieval: retrieval ?? (code === "retrieval_incomplete" ? "partial" : undefined),
        ...(retrievalProof ? { retrievalProof } : {}),
        ...(failure ? { failure } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
        code,
        error: message,
        nextEligibleRunAt,
        ...runMetrics(),
      };
    }
    await recordRunOutcome({ lastStatus: "error", lastCode: code, lastError: message, nextEligibleRunAt });
    return {
      vendorId,
      status: "error",
      count: 0,
      retrieval: code === "retrieval_incomplete" ? "partial" : retrieval,
      ...(retrievalProof ? { retrievalProof } : {}),
      ...(failure ? { failure } : {}),
      ...(terminalFailure ? { terminalFailure } : {}),
      code,
      error: message,
      nextEligibleRunAt,
      ...runMetrics(),
    };
  } finally {
    await dispose();
  }
}

function fallbackFailureStage(error: unknown): CollectionFailureStage {
  if (error instanceof AuthExpired || error instanceof AuthFailure || error instanceof RateLimited) return "authentication";
  if (error instanceof DocumentPermissionRequired) return "document_fetch";
  if (error instanceof RetrievalIncomplete) return "invoice_list";
  return "invoice_list";
}

function boundedCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100_000) : 0;
}

function boundedElapsed(startedAt: number): number {
  return Math.min(3_600_000, Math.max(0, Date.now() - startedAt));
}

function runRuntimeIdentity(): NonNullable<LastRunEvidence["runtime"]> {
  const runtime = COLLECTOR_RUNTIME_IDENTITY;
  return { collectorVersion: runtime.collectorVersion,
    discoveryEngine: runtime.discoveryEngine, documentAcquisition: runtime.documentAcquisition };
}

function distinctTerminalFailure(
  first: CollectionFailureEvidence | undefined,
  terminal: CollectionFailureEvidence | undefined,
): CollectionFailureEvidence | undefined {
  return first && terminal && JSON.stringify(first) === JSON.stringify(terminal) ? undefined : terminal;
}

function summarizeRetrievalProofs(proofs: readonly RetrievalProof[]): LastRunEvidence["retrievalSummary"] | undefined {
  if (!proofs.length) return undefined;
  const bounded = proofs.slice(0, 100);
  return {
    proofs: bounded.length,
    complete: bounded.filter((proof) => proof.completeness === "complete").length,
    partial: bounded.filter((proof) => proof.completeness === "partial").length,
    pagesVisited: boundedCount(bounded.reduce((sum, proof) => sum + proof.pagesVisited, 0)),
    observedItems: boundedCount(bounded.reduce((sum, proof) => sum + proof.observedItems, 0)),
    resolvedItems: boundedCount(bounded.reduce((sum, proof) => sum + proof.resolvedItems, 0)),
    unresolvedItems: boundedCount(bounded.reduce((sum, proof) => sum + proof.unresolvedItems, 0)),
    terminations: [...new Set(bounded.map((proof) => proof.termination))],
  };
}

type PreflightCode =
  | "host_permission_required"
  | "source_unavailable"
  | "destination_unbound"
  | "destination_unavailable"
  | "destination_connection_expired";

/** Record a refused attempt without inventing an invoice-list failure. */
export async function recordBlockedRun(
  vendorId: string,
  trigger: SyncTrigger,
  code: PreflightCode,
  startedAt = Date.now(),
): Promise<VendorRunSummary> {
  const failure: CollectionFailureEvidence = { stage: "preflight", cause: code };
  const error = operationalOutcomeLabel(code);
  await recordRun(vendorId, {
    lastStatus: "error", lastCode: code, lastError: error,
    lastCount: 0, lastDocumentActionCount: 0, lastPageOwnedDownloadCount: 0,
    lastFailedScopes: 0, lastEmptyScopes: 0, nextEligibleRunAt: undefined,
    lastRunEvidence: {
      runtime: runRuntimeIdentity(),
      trigger, status: "error", code, elapsedMs: boundedElapsed(startedAt),
      counts: { accepted: 0, verified: 0, documentActions: 0,
        pageOwnedDownloads: 0, failedScopes: 0, emptyScopes: 0 },
      failure,
    },
  });
  return { vendorId, status: "error", count: 0, code, error, failure };
}

/** Run every connected vendor in sequence (keeps concurrency gentle on the host). */
export async function runAllConnected(trigger: SyncTrigger = "manual", vendorIds?: readonly string[]): Promise<VendorRunSummary[]> {
  const ids = vendorIds ?? Object.keys(await getConnections());
  const summaries: VendorRunSummary[] = [];
  for (const id of ids) {
    const startedAt = Date.now();
    try {
      // Connections from retired bundled recipes can remain in older local
      // storage after an extension update. They are intentionally inert:
      // scheduled sync must not resurrect or execute a path that is no longer
      // present in the current source catalog.
      if (!(await resolveCollectorSource(id))) continue;
      summaries.push(await runVendorById(id, trigger));
    } catch (error) {
      const code = operationalCodeForError(error);
      const message = operationalOutcomeLabel(code);
      console.error(`[collector] "${id}": isolated run failure (${code})`);
      await recordRun(id, {
        lastStatus: "error",
        lastCode: code,
        lastError: message,
        lastCount: 0,
        lastDocumentActionCount: 0,
        lastPageOwnedDownloadCount: 0,
        lastFailedScopes: 0,
        lastEmptyScopes: 0,
        nextEligibleRunAt: undefined,
        lastRunEvidence: {
          runtime: runRuntimeIdentity(),
          trigger, status: "error", code, elapsedMs: boundedElapsed(startedAt),
          counts: { accepted: 0, verified: 0, documentActions: 0,
            pageOwnedDownloads: 0, failedScopes: 0, emptyScopes: 0 },
        },
      }).catch(() => undefined);
      summaries.push({ vendorId: id, status: "error", count: 0, code, error: message });
    }
  }
  return summaries;
}
