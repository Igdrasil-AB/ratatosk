import { streamVendor } from "../../../src/core/engine";
import type { FetchedDocument, RetrievalCompleteness, RetrievalProof, VendorRecipe } from "../../../src/core/types";
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
import { buildRunContext, buildSink, buildStrategies } from "./runtime";
import { resolveCollectorSource } from "./source-catalog";
import {
  boundedNextEligibleRunAt,
  getConnections,
  getNextEligibleRunAt,
  getSinkConfig,
  recordCollected,
  recordRun,
  sinkCompanyId,
} from "./storage";
import { notifyReconnect } from "./notifications";

export interface VendorRunSummary {
  vendorId: string;
  status: "ok" | "partial" | "auth_expired" | "rate_limited" | "skipped" | "error";
  /** Newly committed documents. Backend-reported duplicates are excluded. */
  count: number;
  /** Documents whose retrieval and destination identity were verified,
   * including documents the destination had already accepted. */
  verifiedCount?: number;
  retrieval?: RetrievalCompleteness;
  retrievalProof?: RetrievalProof;
  code?: OperationalOutcomeCode;
  failedScopes?: number;
  emptyScopes?: number;
  nextEligibleRunAt?: number;
  error?: string;
  requiredOrigins?: readonly string[];
  /** Closed stage/cause evidence for diagnostics; never contains supplier data. */
  failure?: CollectionFailureEvidence;
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

export function runVendorById(vendorId: string): Promise<VendorRunSummary> {
  const existing = vendorRuns.get(vendorId);
  if (existing) return existing;

  const task = resolveCollectorSource(vendorId)
    .then((source) => source?.recipe
      ? executeRecipeRun(source.recipe)
      : { vendorId, status: "error", count: 0, error: "unknown vendor" } as VendorRunSummary)
    .finally(() => {
      if (vendorRuns.get(vendorId) === task) vendorRuns.delete(vendorId);
    });
  vendorRuns.set(vendorId, task);
  return task;
}

/** Execute an ephemeral candidate before it is admitted to the local catalog. */
export function runDiscoveredCandidate(
  recipe: VendorRecipe,
  afterFirstDelivery: (document: FetchedDocument) => Promise<void>,
): Promise<VendorRunSummary> {
  return executeRecipeRun(recipe, afterFirstDelivery, true);
}

async function executeRecipeRun(
  recipe: VendorRecipe,
  afterFirstDelivery?: (document: FetchedDocument) => Promise<void>,
  requireCompleteRetrieval = false,
): Promise<VendorRunSummary> {
  const vendorId = recipe.id;

  const nextEligibleRunAt = await getNextEligibleRunAt(vendorId);
  if (nextEligibleRunAt) {
    return { vendorId, status: "skipped", count: 0, code: "rate_limited", nextEligibleRunAt };
  }

  const config = await getSinkConfig();
  if (!config) return { vendorId, status: "error", count: 0, error: "choose a destination before collecting" };
  const { ctx, dispose } = buildRunContext(sinkCompanyId(config), recipe);
  const strategies = buildStrategies(recipe);

  console.info(`[collector] running "${vendorId}"…`);
  let acceptedCount = 0;
  let verifiedCount = 0;
  let retrieval: RetrievalCompleteness | undefined;
  let retrievalProof: RetrievalProof | undefined;
  let failure: CollectionFailureEvidence | undefined;

  try {
    let firstDeliveryCommitted = false;
    let sink: Awaited<ReturnType<typeof buildSink>>;
    try {
      // Build the irreversible delivery path from the exact destination
      // snapshot that supplied this run's tenant/dedup context. A later UI
      // configuration change must apply to the next run, never split one run
      // across two destinations.
      sink = await buildSink(config);
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
      onFailure: (evidence) => {
        failure ??= evidence;
      },
    });
    const { scopes } = result;
    retrieval = result.retrieval;
    retrievalProof = result.retrievalProof;
    console.info(`[collector] "${vendorId}": ok — ${acceptedCount} document(s)`);

    const partial = scopes.failed > 0;
    const code = partial ? "partial_scope_failure" as const : undefined;
    await recordRun(vendorId, {
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
      retrieval,
      ...(retrievalProof ? { retrievalProof } : {}),
      ...(code ? { code } : {}),
      failedScopes: scopes.failed,
      emptyScopes: scopes.empty,
    };
  } catch (err) {
    if (err instanceof DestinationDeliveryError) {
      failure = {
        ...collectionFailureEvidence(err.cause, "delivery", failure?.retrieval),
        stage: "delivery",
        cause: "destination_rejected",
      };
    } else if (err instanceof DiscoveryAdmissionError) {
      failure = {
        ...collectionFailureEvidence(err.cause, "admission", failure?.retrieval),
        stage: "admission",
        cause: "state_persistence",
      };
    } else {
      failure ??= collectionFailureEvidence(err, fallbackFailureStage(err));
    }
    retrievalProof ??= failure.retrieval;
    if (err instanceof RetrievalIncomplete) retrievalProof = err.proof;
    if (err instanceof DiscoveryAdmissionError) {
      const code = "connection_persistence_failed" as const;
      const message = operationalOutcomeLabel(code);
      console.error(`[collector] "${vendorId}": ${message}`);
      return {
        vendorId,
        status: "error",
        count: acceptedCount,
        verifiedCount,
        retrieval,
        ...(retrievalProof ? { retrievalProof } : {}),
        ...(failure ? { failure } : {}),
        code,
        error: message,
      };
    }
    if (err instanceof AuthExpired) {
      console.warn(`[collector] "${vendorId}": auth check failed — session looks logged out`);
      notifyReconnect(recipe);
      if (acceptedCount > 0) {
        const message = operationalOutcomeLabel("auth_expired");
        await recordRun(vendorId, {
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
          retrieval,
          code: "auth_expired",
          error: message,
          ...(failure ? { failure } : {}),
        };
      }
      await recordRun(vendorId, { lastStatus: "auth_expired", lastCode: "auth_expired", nextEligibleRunAt: undefined });
      return { vendorId, status: "auth_expired", count: 0, code: "auth_expired", ...(failure ? { failure } : {}) };
    }
    if (err instanceof AuthFailure) {
      const code = operationalCodeForError(err);
      const message = operationalOutcomeLabel(code);
      console.warn(`[collector] "${vendorId}": ${message.toLowerCase()}`);
      if (acceptedCount > 0) {
        await recordRun(vendorId, { lastStatus: "partial", lastCount: acceptedCount, lastCode: code, lastError: message, nextEligibleRunAt: undefined });
        return { vendorId, status: "partial", count: acceptedCount, retrieval, code, error: message, ...(failure ? { failure } : {}) };
      }
      await recordRun(vendorId, { lastStatus: "error", lastCode: code, lastError: message, nextEligibleRunAt: undefined });
      return { vendorId, status: "error", count: 0, code, error: message, ...(failure ? { failure } : {}) };
    }
    if (err instanceof RateLimited) {
      const eligibleAt = boundedNextEligibleRunAt(err.retryAfterMs);
      await recordRun(vendorId, {
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
            ...(failure ? { failure } : {}),
          }
        : {
            vendorId,
            status: "rate_limited",
            count: 0,
            code: "rate_limited",
            nextEligibleRunAt: eligibleAt,
            ...(failure ? { failure } : {}),
          };
    }
    if (err instanceof DocumentPermissionRequired) {
      const code = "document_permission_required" as const;
      const message = operationalOutcomeLabel(code);
      const existing = (await getConnections())[vendorId];
      if (existing) {
        await recordRun(vendorId, {
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
        ...(failure ? { failure } : {}),
      };
    }
    const code: OperationalOutcomeCode = err instanceof DestinationDeliveryError ? "destination_unavailable" : operationalCodeForError(err);
    const message = operationalOutcomeLabel(code);
    console.error(`[collector] "${vendorId}": ${message}`);
    if (acceptedCount > 0) {
      await recordRun(vendorId, { lastStatus: "partial", lastCount: acceptedCount, lastCode: code, lastError: message, nextEligibleRunAt: undefined });
      return {
        vendorId,
        status: "partial",
        count: acceptedCount,
        retrieval: retrieval ?? (code === "retrieval_incomplete" ? "partial" : undefined),
        ...(retrievalProof ? { retrievalProof } : {}),
        ...(failure ? { failure } : {}),
        code,
        error: message,
      };
    }
    await recordRun(vendorId, { lastStatus: "error", lastCode: code, lastError: message, nextEligibleRunAt: undefined });
    return {
      vendorId,
      status: "error",
      count: 0,
      retrieval: code === "retrieval_incomplete" ? "partial" : retrieval,
      ...(retrievalProof ? { retrievalProof } : {}),
      ...(failure ? { failure } : {}),
      code,
      error: message,
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

/** Run every connected vendor in sequence (keeps concurrency gentle on the host). */
export async function runAllConnected(): Promise<VendorRunSummary[]> {
  const ids = Object.keys(await getConnections());
  const summaries: VendorRunSummary[] = [];
  for (const id of ids) {
    try {
      // Connections from retired bundled recipes can remain in older local
      // storage after an extension update. They are intentionally inert:
      // scheduled sync must not resurrect or execute a path that is no longer
      // present in the current source catalog.
      if (!(await resolveCollectorSource(id))) continue;
      summaries.push(await runVendorById(id));
    } catch (error) {
      const code = operationalCodeForError(error);
      const message = operationalOutcomeLabel(code);
      console.error(`[collector] "${id}": isolated run failure (${code})`);
      await recordRun(id, {
        lastStatus: "error",
        lastCode: code,
        lastError: message,
        nextEligibleRunAt: undefined,
      }).catch(() => undefined);
      summaries.push({ vendorId: id, status: "error", count: 0, code, error: message });
    }
  }
  return summaries;
}
