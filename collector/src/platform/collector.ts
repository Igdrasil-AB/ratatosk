import { runVendor } from "../../../src/core/engine";
import {
  AuthExpired,
  operationalCodeForError,
  operationalOutcomeLabel,
  RateLimited,
  type OperationalOutcomeCode,
} from "../../../src/core/errors";
import { getVendor } from "../../../src/vendors";
import { buildRunContext, buildSink, buildStrategies } from "./runtime";
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
  count: number;
  code?: OperationalOutcomeCode;
  failedScopes?: number;
  emptyScopes?: number;
  nextEligibleRunAt?: number;
  error?: string;
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

export function runVendorById(vendorId: string): Promise<VendorRunSummary> {
  const existing = vendorRuns.get(vendorId);
  if (existing) return existing;

  const task = executeVendorRun(vendorId).finally(() => {
    if (vendorRuns.get(vendorId) === task) vendorRuns.delete(vendorId);
  });
  vendorRuns.set(vendorId, task);
  return task;
}

async function executeVendorRun(vendorId: string): Promise<VendorRunSummary> {
  const recipe = getVendor(vendorId);
  if (!recipe) return { vendorId, status: "error", count: 0, error: "unknown vendor" };

  const nextEligibleRunAt = await getNextEligibleRunAt(vendorId);
  if (nextEligibleRunAt) {
    return { vendorId, status: "skipped", count: 0, code: "rate_limited", nextEligibleRunAt };
  }

  const config = await getSinkConfig();
  if (!config) return { vendorId, status: "error", count: 0, error: "choose a destination before collecting" };
  const { ctx, dispose } = buildRunContext(sinkCompanyId(config), recipe);
  const strategies = buildStrategies();

  console.info(`[collector] running "${vendorId}"…`);

  let phase: "collect" | "destination" = "collect";
  try {
    const { documents, scopes } = await runVendor(recipe, ctx, strategies);
    console.info(`[collector] "${vendorId}": ok — ${documents.length} document(s)`);

    let acceptedCount = 0;
    if (documents.length) {
      phase = "destination";
      const sink = await buildSink();
      const collectedAt = Date.now();
      for (const doc of documents) {
        const result = await sink.send(doc);
        if (!result.accepted) throw new Error("destination rejected document");
        await ctx.seen.add(doc.idempotencyKey, doc.source);
        acceptedCount++;
        // Remember what we collected so the popup can show a feed of invoices.
        await recordCollected([
          {
            key: doc.idempotencyKey,
            vendorId: doc.vendorId,
            vendorName: doc.vendorName,
            issuedAt: doc.issuedAt || undefined,
            total: doc.total,
            currency: doc.currency,
            collectedAt,
          },
        ]);
      }
    }

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
      ...(code ? { code } : {}),
      failedScopes: scopes.failed,
      emptyScopes: scopes.empty,
    };
  } catch (err) {
    if (err instanceof AuthExpired) {
      console.warn(`[collector] "${vendorId}": auth check failed — session looks logged out`);
      notifyReconnect(recipe);
      await recordRun(vendorId, { lastStatus: "auth_expired", lastCode: "auth_expired", nextEligibleRunAt: undefined });
      return { vendorId, status: "auth_expired", count: 0, code: "auth_expired" };
    }
    if (err instanceof RateLimited) {
      const eligibleAt = boundedNextEligibleRunAt(err.retryAfterMs);
      await recordRun(vendorId, {
        lastStatus: "rate_limited",
        lastCode: "rate_limited",
        lastError: operationalOutcomeLabel("rate_limited"),
        nextEligibleRunAt: eligibleAt,
      });
      return { vendorId, status: "rate_limited", count: 0, code: "rate_limited", nextEligibleRunAt: eligibleAt };
    }
    const code: OperationalOutcomeCode = phase === "destination" ? "destination_unavailable" : operationalCodeForError(err);
    const message = operationalOutcomeLabel(code);
    console.error(`[collector] "${vendorId}": ${message}`);
    await recordRun(vendorId, { lastStatus: "error", lastCode: code, lastError: message, nextEligibleRunAt: undefined });
    return { vendorId, status: "error", count: 0, code, error: message };
  } finally {
    await dispose();
  }
}

/** Run every connected vendor in sequence (keeps concurrency gentle on the host). */
export async function runAllConnected(): Promise<VendorRunSummary[]> {
  const ids = Object.keys(await getConnections());
  const summaries: VendorRunSummary[] = [];
  for (const id of ids) summaries.push(await runVendorById(id));
  return summaries;
}
