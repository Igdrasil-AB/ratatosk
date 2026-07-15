import { runVendor } from "../../../src/core/engine";
import { AuthExpired, CollectorError } from "../../../src/core/errors";
import { getVendor } from "../../../src/vendors";
import { buildRunContext, buildSink, buildStrategies } from "./runtime";
import { getConnections, getSinkConfig, recordCollected, recordRun, sinkCompanyId } from "./storage";
import { notifyReconnect } from "./notifications";

export interface VendorRunSummary {
  vendorId: string;
  status: "ok" | "auth_expired" | "error";
  count: number;
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
export async function runVendorById(vendorId: string): Promise<VendorRunSummary> {
  const recipe = getVendor(vendorId);
  if (!recipe) return { vendorId, status: "error", count: 0, error: "unknown vendor" };

  const config = await getSinkConfig();
  if (!config) return { vendorId, status: "error", count: 0, error: "choose a destination before collecting" };
  const { ctx, dispose } = buildRunContext(sinkCompanyId(config), recipe);
  const strategies = buildStrategies();

  console.info(`[collector] running "${vendorId}"…`);

  try {
    const { documents } = await runVendor(recipe, ctx, strategies);
    console.info(`[collector] "${vendorId}": ok — ${documents.length} document(s)`);

    if (documents.length) {
      const sink = await buildSink();
      const collectedAt = Date.now();
      for (const doc of documents) {
        const result = await sink.send(doc);
        if (!result.accepted) continue;
        await ctx.seen.add(doc.idempotencyKey, doc.source);
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

    await recordRun(vendorId, { lastStatus: "ok", lastCount: documents.length, lastError: undefined });
    return { vendorId, status: "ok", count: documents.length };
  } catch (err) {
    if (err instanceof AuthExpired) {
      console.warn(`[collector] "${vendorId}": auth check failed — session looks logged out`);
      notifyReconnect(recipe);
      await recordRun(vendorId, { lastStatus: "auth_expired" });
      return { vendorId, status: "auth_expired", count: 0 };
    }
    const message = err instanceof CollectorError ? err.message : "collection failed";
    console.error(`[collector] "${vendorId}": ${message}`);
    await recordRun(vendorId, { lastStatus: "error", lastError: message });
    return { vendorId, status: "error", count: 0, error: message };
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
